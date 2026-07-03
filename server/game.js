'use strict';

const { pickRound, WORDS, CUSTOM_CATEGORY } = require('./words');
const { LIAR_LINES, CITIZEN_GENERIC, DISCUSS_LINES, citizenLine, randOf } = require('./hints');

// 단계별 제한 시간 (초) — 설명/토론 시간은 방 설정을 따름
const TIMES = { role: 7, vote: 45, revote: 30, guess: 45, judge: 30 };
const LIAR_GRACE_MS = 45 * 1000; // 라이어 연결 끊김 시 복귀 대기 시간
const LOW_PLAYER_GRACE_MS = 45 * 1000; // 접속 인원이 3인 미만이 됐을 때 복귀 대기 시간

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 방 하나의 게임 상태 머신.
 * ctx: { emitRoom, emitPlayer, broadcastRoom, systemMsg, endGame }
 * 역할/제시어는 emitPlayer로 개별 전송하며, publicState()에는 절대 포함하지 않는다.
 */
function createGame(room, ctx) {
  const g = {
    round: 0,
    totalRounds: room.settings.rounds,
    mode: room.settings.mode,
    phase: null, // role | describe | discuss | vote | guess | judge | result | final
    phaseEndsAt: null,
    category: null,
    word: null,
    fakeWord: null,
    liarId: null,
    spyId: null,
    roles: {}, // playerId -> 개인 전송용 역할 정보
    names: {}, // playerId -> nickname (라운드 시작 시점 스냅샷, 퇴장자 표시용)
    order: [],
    turnIndex: 0,
    describes: [], // { playerId, text, skipped }
    votes: {}, // voterId -> targetId
    voteRound: 0, // 투표 회차 토큰 (재투표 전환 직전의 늦은 표가 섞이는 것 방지)
    revoted: false,
    tieCandidates: null,
    accusedId: null,
    guessText: null,
    judgeId: null,
    result: null,
  };
  let timer = null;
  let liarGraceTimer = null;
  let lowPlayerTimer = null;
  let botTimers = [];
  let ended = false;

  // ---------- 봇 플레이어 ----------

  function isBot(id) {
    const p = room.players.get(id);
    return !!(p && p.isBot);
  }

  function scheduleBot(ms, fn) {
    botTimers.push(setTimeout(fn, ms));
  }

  function clearBotTimers() {
    for (const t of botTimers) clearTimeout(t);
    botTimers = [];
  }

  // 봇의 설명 한 마디 (역할에 따라 다르게, 이번 라운드에 이미 나온 문장은 피한다)
  function botDescribeLine(id) {
    const used = new Set(g.describes.map((d) => d.text).filter(Boolean));
    const pickUnused = (pool) => {
      const fresh = pool.filter((line) => !used.has(line));
      return randOf(fresh.length ? fresh : pool);
    };
    const role = g.roles[id];
    if (!role) return pickUnused(CITIZEN_GENERIC);
    if (role.role === 'liar') return pickUnused(LIAR_LINES); // 제시어를 모르는 채 허세
    if (role.role === 'spy') return pickUnused(CITIZEN_GENERIC); // 라이어를 돕기 위해 두루뭉술하게
    // 시민(바보 모드 라이어 포함): 제시어 힌트 — 앞사람과 겹치면 일반 문장으로 대체
    const hint = citizenLine(role.word);
    return used.has(hint) ? pickUnused(CITIZEN_GENERIC) : hint;
  }

  // 현재 설명 차례가 봇이면 잠시 후 자동 발언
  function maybeScheduleBotTurn() {
    const cur = g.order[g.turnIndex];
    if (!isBot(cur)) return;
    scheduleBot(2000 + Math.random() * 2500, () => {
      if (g.phase === 'describe' && g.order[g.turnIndex] === cur) {
        handleChat(cur, botDescribeLine(cur));
      }
    });
  }

  // 투표 단계: 봇들이 시차를 두고 무작위 투표 (재투표 시 후보 내에서)
  function scheduleBotVotes() {
    for (const id of g.order) {
      if (!isBot(id) || !room.players.has(id)) continue;
      scheduleBot(1500 + Math.random() * 4000, () => {
        if (g.phase !== 'vote') return;
        const pool = (g.tieCandidates || g.order)
          .filter((t) => t !== id && room.players.has(t));
        if (pool.length) handleVote(id, randOf(pool), g.voteRound);
      });
    }
  }

  function nickname(id) {
    const p = room.players.get(id);
    return p ? p.nickname : (g.names[id] || '???');
  }

  function isActive(id) {
    const p = room.players.get(id);
    return !!(p && p.connected);
  }

  function activeIds() {
    return [...room.players.values()].filter((p) => p.connected).map((p) => p.id);
  }

  function setTimer(seconds, fn) {
    clearTimer();
    g.phaseEndsAt = Date.now() + seconds * 1000;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, seconds * 1000);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    g.phaseEndsAt = null;
  }

  function clearLiarGrace() {
    if (liarGraceTimer) {
      clearTimeout(liarGraceTimer);
      liarGraceTimer = null;
    }
  }

  function clearLowPlayerGrace() {
    if (lowPlayerTimer) {
      clearTimeout(lowPlayerTimer);
      lowPlayerTimer = null;
    }
  }

  function inRound() {
    return g.phase && g.phase !== 'result' && g.phase !== 'final';
  }

  // 이번 라운드 참가자(관전자 제외) 중 접속 중인 인원
  function activeParticipantCount() {
    return g.order.filter(isActive).length;
  }

  // 라운드 참가자가 3인 미만이면 라운드 무효(관전자 포함 인원이 충분하면 게임은 유지) 또는 게임 종료
  function endRoundIfShortHanded() {
    if (!inRound() || activeParticipantCount() >= 3) return false;
    if (activeIds().length >= 3) {
      voidRound('참가 인원이 부족하여 이번 라운드는 무효 처리됩니다.');
    } else {
      abort('인원이 부족하여 게임을 종료합니다.');
    }
    return true;
  }

  // ---------- 라운드 진행 ----------

  function start() {
    startRound();
  }

  function startRound() {
    const ids = activeIds();
    if (ids.length < 3) {
      abort('인원이 부족하여 게임을 종료합니다.');
      return;
    }
    g.round++;
    g.order = shuffle(ids);
    g.turnIndex = 0;
    g.describes = [];
    g.votes = {};
    g.revoted = false;
    g.tieCandidates = null;
    g.accusedId = null;
    g.guessText = null;
    g.judgeId = null;
    g.result = null;
    clearLiarGrace();
    clearLowPlayerGrace();
    clearBotTimers();

    g.names = {};
    for (const id of ids) g.names[id] = nickname(id);

    const picked = pickRound(room.settings.categories, room.settings.customWords);
    g.category = picked.category;
    g.word = picked.word;
    g.fakeWord = g.mode === 'fool' ? picked.fakeWord : null;

    const casting = shuffle(ids);
    g.liarId = casting[0];
    g.spyId = g.mode === 'spy' && ids.length >= 5 ? casting[1] : null;

    g.roles = {};
    for (const id of ids) {
      if (id === g.liarId) {
        // 바보 모드: 라이어 본인도 시민인 줄 알고 다른 제시어를 받는다
        g.roles[id] = g.mode === 'fool'
          ? { role: 'citizen', category: g.category, word: g.fakeWord }
          : { role: 'liar', category: g.category, word: null };
      } else if (id === g.spyId) {
        g.roles[id] = { role: 'spy', category: g.category, word: g.word, liarName: nickname(g.liarId) };
      } else {
        g.roles[id] = { role: 'citizen', category: g.category, word: g.word };
      }
    }

    g.phase = 'role';
    for (const [id, role] of Object.entries(g.roles)) ctx.emitPlayer(id, 'game:role', role);
    ctx.systemMsg(`라운드 ${g.round}/${g.totalRounds} 시작! 역할을 확인하세요.`);
    setTimer(TIMES.role, beginDescribe);
    ctx.broadcastRoom();
  }

  function beginDescribe() {
    g.phase = 'describe';
    g.turnIndex = -1;
    ctx.systemMsg('설명 단계입니다. 자기 차례에 제시어를 한 문장으로 설명하세요.');
    advanceTurn();
  }

  function advanceTurn() {
    g.turnIndex++;
    while (g.turnIndex < g.order.length && !isActive(g.order[g.turnIndex])) {
      g.describes.push({ playerId: g.order[g.turnIndex], text: null, skipped: true });
      g.turnIndex++;
    }
    if (g.turnIndex >= g.order.length) {
      beginDiscuss();
      return;
    }
    setTimer(room.settings.describeTime, () => {
      const cur = g.order[g.turnIndex];
      g.describes.push({ playerId: cur, text: null, skipped: true });
      ctx.systemMsg(`${nickname(cur)}님이 시간을 초과하여 차례를 넘깁니다.`);
      advanceTurn();
    });
    clearBotTimers();
    maybeScheduleBotTurn();
    ctx.broadcastRoom();
  }

  function beginDiscuss() {
    g.phase = 'discuss';
    ctx.systemMsg('토론 시간입니다. 누가 라이어인지 자유롭게 이야기해보세요!');
    setTimer(room.settings.discussTime, beginVote);
    // 봇들의 토론 수다 (전부는 아니고 확률적으로)
    clearBotTimers();
    for (const id of g.order) {
      if (isBot(id) && Math.random() < 0.7) {
        scheduleBot(1500 + Math.random() * room.settings.discussTime * 600, () => {
          if (g.phase === 'discuss') handleChat(id, randOf(DISCUSS_LINES));
        });
      }
    }
    ctx.broadcastRoom();
  }

  function beginVote() {
    g.phase = 'vote';
    g.votes = {};
    g.voteRound++;
    ctx.systemMsg('투표 시간! 라이어라고 생각하는 사람에게 투표하세요.');
    setTimer(TIMES.vote, tally);
    clearBotTimers();
    scheduleBotVotes();
    ctx.broadcastRoom();
  }

  function tally() {
    clearTimer();
    const counts = {};
    for (const t of Object.values(g.votes)) counts[t] = (counts[t] || 0) + 1;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      ctx.systemMsg('아무도 투표하지 않아 라이어가 생존했습니다.');
      finishRound('liarSurvived');
      return;
    }
    const top = entries[0][1];
    const topIds = entries.filter(([, c]) => c === top).map(([id]) => id);
    if (topIds.length > 1) {
      if (!g.revoted) {
        g.revoted = true;
        g.tieCandidates = topIds;
        g.votes = {};
        g.voteRound++;
        g.phase = 'vote';
        ctx.systemMsg('동표가 나왔습니다! 최다 득표자들만 대상으로 재투표합니다.');
        setTimer(TIMES.revote, tally);
        clearBotTimers();
        scheduleBotVotes();
        ctx.broadcastRoom();
        return;
      }
      ctx.systemMsg('재투표도 동표! 라이어가 생존했습니다.');
      finishRound('liarSurvived');
      return;
    }
    g.accusedId = topIds[0];
    if (g.accusedId === g.liarId) {
      beginGuess();
    } else if (g.spyId && g.accusedId === g.spyId) {
      finishRound('spyCaught');
    } else {
      finishRound('liarSurvived');
    }
  }

  function beginGuess() {
    g.phase = 'guess';
    ctx.systemMsg(`${nickname(g.accusedId)}님이 라이어로 지목되었습니다! 라이어는 제시어를 맞히면 역전승합니다.`);
    setTimer(TIMES.guess, () => finishRound('liarCaught'));
    clearBotTimers();
    // 라이어가 봇이면 카테고리에서 무작위 추리 (운 좋으면 역전승!)
    if (isBot(g.liarId)) {
      scheduleBot(3000 + Math.random() * 2000, () => {
        if (g.phase !== 'guess') return;
        const list = g.category === CUSTOM_CATEGORY ? room.settings.customWords : WORDS[g.category];
        const guess = list && list.length ? randOf(list) : '음...';
        handleGuess(g.liarId, guess);
      });
    }
    ctx.broadcastRoom();
  }

  function pickJudge() {
    // 판정자는 이번 라운드 참가자 중에서만 선택 (관전자 방장에게 제시어가 새지 않게)
    // 사람을 우선하고, 사람이 없으면 봇이 자동 판정한다
    if (room.hostId !== g.liarId && g.order.includes(room.hostId) && isActive(room.hostId)) {
      return room.hostId;
    }
    return g.order.find((id) => id !== g.liarId && isActive(id) && !isBot(id))
      || g.order.find((id) => id !== g.liarId && isActive(id))
      || null;
  }

  // 판정자가 봇이면 자동 판정 (정규화 후 동일하거나 포함 관계면 정답 인정)
  function maybeScheduleBotJudge() {
    if (!isBot(g.judgeId)) return;
    scheduleBot(2000 + Math.random() * 1500, () => {
      if (g.phase !== 'judge') return;
      const a = normalize(g.guessText);
      const b = normalize(g.word);
      const correct = a === b || (a.length > 1 && b.length > 1 && (a.includes(b) || b.includes(a)));
      handleJudge(g.judgeId, correct);
    });
  }

  function beginJudge() {
    g.judgeId = pickJudge();
    if (!g.judgeId) {
      finishRound('liarCaught');
      return;
    }
    g.phase = 'judge';
    setTimer(TIMES.judge, () => finishRound('liarCaught'));
    sendJudgePrompt();
    clearBotTimers();
    maybeScheduleBotJudge();
    ctx.systemMsg(`라이어의 답이 정답과 정확히 일치하지 않습니다. ${nickname(g.judgeId)}님이 정답 여부를 판정합니다.`);
    ctx.broadcastRoom();
  }

  // 판정자 이탈 시 교체 — 남은 판정 시간은 그대로 유지한다
  function reassignJudge() {
    g.judgeId = pickJudge();
    if (!g.judgeId) {
      finishRound('liarCaught');
      return;
    }
    sendJudgePrompt();
    clearBotTimers();
    maybeScheduleBotJudge();
    ctx.systemMsg(`판정자가 자리를 비워 ${nickname(g.judgeId)}님이 대신 판정합니다.`);
    ctx.broadcastRoom();
  }

  function sendJudgePrompt() {
    ctx.emitPlayer(g.judgeId, 'game:judgePrompt', { guess: g.guessText, word: g.word });
  }

  // ---------- 라운드 종료/점수 ----------

  function finishRound(outcome) {
    clearTimer();
    clearLiarGrace();
    clearBotTimers();
    const deltas = {};
    const liarWin = outcome === 'liarSurvived' || outcome === 'liarGuessed';
    if (liarWin) {
      // 방을 나간 플레이어는 점수표에서도 제외해 실제 반영과 표시를 일치시킨다
      if (room.players.has(g.liarId)) deltas[g.liarId] = outcome === 'liarSurvived' ? 3 : 2;
      if (g.spyId && room.players.has(g.spyId)) deltas[g.spyId] = 2;
    } else {
      // 시민 승리: 시민 전원 +1, 정답 대상에게 투표한 시민은 추가 +1
      const target = outcome === 'spyCaught' ? g.spyId : g.liarId;
      for (const id of g.order) {
        if (id === g.liarId || id === g.spyId) continue;
        if (!room.players.has(id)) continue;
        deltas[id] = 1 + (g.votes[id] === target ? 1 : 0);
      }
    }
    for (const [id, d] of Object.entries(deltas)) {
      const p = room.players.get(id);
      if (p) p.score += d;
    }
    g.result = {
      outcome,
      voided: false,
      liarId: g.liarId,
      liarName: nickname(g.liarId),
      spyId: g.spyId,
      spyName: g.spyId ? nickname(g.spyId) : null,
      category: g.category,
      word: g.word,
      fakeWord: g.fakeWord,
      accusedId: g.accusedId,
      accusedName: g.accusedId ? nickname(g.accusedId) : null,
      guessText: g.guessText,
      votes: { ...g.votes },
      deltas,
    };
    ctx.recordRound({ ...g.result, participants: g.order.slice() });
    g.phase = 'result';
    ctx.broadcastRoom();
  }

  function voidRound(reason) {
    clearTimer();
    clearLiarGrace();
    clearBotTimers();
    g.result = {
      outcome: 'voided',
      voided: true,
      reason,
      liarId: g.liarId,
      liarName: nickname(g.liarId),
      spyId: g.spyId,
      spyName: g.spyId ? nickname(g.spyId) : null,
      category: g.category,
      word: g.word,
      fakeWord: g.fakeWord,
      accusedId: null,
      accusedName: null,
      guessText: null,
      votes: {},
      deltas: {},
    };
    g.phase = 'result';
    ctx.systemMsg(reason);
    ctx.broadcastRoom();
  }

  function abort(msg) {
    ctx.systemMsg(msg);
    destroy();
    ctx.endGame();
  }

  // ---------- 플레이어 입력 핸들러 ----------

  function handleChat(playerId, text) {
    if (g.phase === 'describe') {
      if (g.order[g.turnIndex] !== playerId) {
        return { ok: false, error: '설명 단계에서는 자신의 차례에만 발언할 수 있습니다.' };
      }
      g.describes.push({ playerId, text, skipped: false });
      ctx.chat({ kind: 'describe', playerId, nickname: nickname(playerId), text });
      advanceTurn();
      return { ok: true };
    }
    // 라이어가 추리하는 동안 채팅으로 정답이 유출되는 것을 막는다
    if (g.phase === 'guess' || g.phase === 'judge') {
      return { ok: false, error: '라이어가 추리하는 동안에는 채팅할 수 없습니다.' };
    }
    ctx.chat({ kind: 'chat', playerId, nickname: nickname(playerId), text });
    return { ok: true };
  }

  function handleVote(playerId, targetId, voteRound) {
    if (g.phase !== 'vote') return { ok: false, error: '지금은 투표 시간이 아닙니다.' };
    if (Number(voteRound) !== g.voteRound) {
      return { ok: false, error: '투표가 갱신되었습니다. 다시 투표해주세요.' };
    }
    if (!g.order.includes(playerId)) return { ok: false, error: '이번 라운드에는 참여할 수 없습니다.' };
    if (playerId === targetId) return { ok: false, error: '자기 자신에게는 투표할 수 없습니다.' };
    if (!g.order.includes(targetId) || !room.players.has(targetId)) {
      return { ok: false, error: '유효하지 않은 대상입니다.' };
    }
    if (g.tieCandidates && !g.tieCandidates.includes(targetId)) {
      return { ok: false, error: '재투표 후보에게만 투표할 수 있습니다.' };
    }
    g.votes[playerId] = targetId;
    const required = g.order.filter(isActive);
    const done = required.length > 0 && required.every((id) => g.votes[id]);
    ctx.broadcastRoom();
    if (done) tally();
    return { ok: true };
  }

  function handleGuess(playerId, text) {
    if (g.phase !== 'guess' || playerId !== g.liarId) {
      return { ok: false, error: '지금 제시어를 입력할 수 없습니다.' };
    }
    const t = String(text || '').trim().slice(0, 30);
    if (!t) return { ok: false, error: '제시어를 입력해주세요.' };
    g.guessText = t;
    if (normalize(t) === normalize(g.word)) {
      ctx.systemMsg('라이어가 제시어를 맞혔습니다!');
      finishRound('liarGuessed');
      return { ok: true };
    }
    beginJudge();
    return { ok: true };
  }

  // 방장이 토론을 조기 종료하고 바로 투표 시작
  function handleSkipDiscuss(playerId) {
    if (playerId !== room.hostId) return { ok: false, error: '방장만 토론을 끝낼 수 있습니다.' };
    if (g.phase !== 'discuss') return { ok: false, error: '지금은 토론 시간이 아닙니다.' };
    ctx.systemMsg('방장이 토론을 끝냈습니다. 바로 투표를 시작합니다!');
    beginVote();
    return { ok: true };
  }

  function handleJudge(playerId, correct) {
    if (g.phase !== 'judge' || playerId !== g.judgeId) {
      return { ok: false, error: '판정 권한이 없습니다.' };
    }
    finishRound(correct ? 'liarGuessed' : 'liarCaught');
    return { ok: true };
  }

  function handleNext(playerId) {
    if (playerId !== room.hostId) return { ok: false, error: '방장만 진행할 수 있습니다.' };
    if (g.phase === 'result') {
      if (g.round >= g.totalRounds) {
        g.phase = 'final';
        clearTimer();
        ctx.systemMsg('모든 라운드가 끝났습니다! 최종 결과를 확인하세요.');
        ctx.broadcastRoom();
      } else {
        startRound();
      }
      return { ok: true };
    }
    if (g.phase === 'final') {
      destroy();
      ctx.endGame();
      return { ok: true };
    }
    return { ok: false, error: '지금은 진행할 수 없습니다.' };
  }

  // ---------- 접속 변동 처리 ----------

  function handleDisconnect(playerId) {
    if (!inRound()) {
      ctx.broadcastRoom();
      return;
    }
    // 라운드 참가자가 3인 미만이 되면 복귀 유예 후에도 부족할 때 라운드 무효/게임 종료
    if (activeParticipantCount() < 3) {
      clearLowPlayerGrace();
      lowPlayerTimer = setTimeout(() => {
        lowPlayerTimer = null;
        endRoundIfShortHanded();
      }, LOW_PLAYER_GRACE_MS);
    }
    if (playerId === g.liarId) {
      clearLiarGrace();
      liarGraceTimer = setTimeout(() => {
        liarGraceTimer = null;
        const p = room.players.get(g.liarId);
        if ((!p || !p.connected) && inRound()) {
          voidRound('라이어의 연결이 끊겨 이번 라운드는 무효 처리됩니다.');
        }
      }, LIAR_GRACE_MS);
    }
    // 설명 차례 중 끊긴 경우: 즉시 건너뛰지 않고 남은 발언 시간을 복귀 유예로 사용
    // (시간 내 재접속하면 이어서 설명, 못 돌아오면 기존 타임아웃 처리로 차례가 넘어감)
    if (g.phase === 'vote') {
      // 부재자의 표가 결과를 좌우하지 않도록 제거 (명시적 퇴장과 동일, 재접속 시 재투표 가능)
      delete g.votes[playerId];
      const required = g.order.filter(isActive);
      if (required.length > 0 && required.every((id) => g.votes[id])) {
        tally();
        return;
      }
    }
    if (g.phase === 'judge' && playerId === g.judgeId) {
      reassignJudge();
      return;
    }
    ctx.broadcastRoom();
  }

  function handleReconnect(playerId) {
    if (playerId === g.liarId) clearLiarGrace();
    if (activeParticipantCount() >= 3) clearLowPlayerGrace();
    // 이번 라운드 역할이 없으면 null을 보내 클라이언트의 이전 역할 카드를 지운다
    ctx.emitPlayer(playerId, 'game:role', g.roles[playerId] || null);
    if (g.phase === 'judge' && playerId === g.judgeId) sendJudgePrompt();
    ctx.broadcastRoom();
  }

  // 명시적 퇴장(방에서 제거된 뒤 호출됨)
  function handleLeave(playerId) {
    if (ended || g.phase === 'final') {
      ctx.broadcastRoom();
      return;
    }
    if (playerId === g.liarId && inRound()) {
      voidRound('라이어가 방을 나가 이번 라운드는 무효 처리됩니다.');
    } else if (g.phase === 'describe' && g.order[g.turnIndex] === playerId) {
      clearTimer();
      g.describes.push({ playerId, text: null, skipped: true });
      advanceTurn();
    } else if (g.phase === 'vote') {
      delete g.votes[playerId];
      for (const [voter, target] of Object.entries(g.votes)) {
        if (target === playerId) delete g.votes[voter];
      }
      const required = g.order.filter(isActive);
      if (required.length > 0 && required.every((id) => g.votes[id])) tally();
    } else if (g.phase === 'judge' && playerId === g.judgeId) {
      reassignJudge();
    }
    if (endRoundIfShortHanded()) return;
    ctx.broadcastRoom();
  }

  // ---------- 공개 상태 ----------

  function publicState() {
    return {
      round: g.round,
      totalRounds: g.totalRounds,
      mode: g.mode,
      phase: g.phase,
      phaseEndsAt: g.phaseEndsAt,
      category: g.category,
      names: { ...g.names },
      order: g.order.slice(),
      turnIndex: g.turnIndex,
      describes: g.describes.map((d) => ({
        playerId: d.playerId,
        nickname: nickname(d.playerId),
        text: d.text,
        skipped: !!d.skipped,
      })),
      votedIds: Object.keys(g.votes),
      voteRound: g.voteRound,
      tieCandidates: g.tieCandidates,
      accusedId: g.accusedId,
      accusedName: g.accusedId ? nickname(g.accusedId) : null,
      // 지목 확정 후에는 개표 연출을 위해 투표 상세를 공개
      votesDetail: g.accusedId ? { ...g.votes } : null,
      judgeId: g.judgeId,
      guessText: g.phase === 'judge' ? g.guessText : null,
      result: g.phase === 'result' || g.phase === 'final' ? g.result : null,
    };
  }

  function destroy() {
    ended = true;
    clearTimer();
    clearLiarGrace();
    clearLowPlayerGrace();
    clearBotTimers();
  }

  return {
    start,
    handleChat,
    handleVote,
    handleGuess,
    handleJudge,
    handleSkipDiscuss,
    handleNext,
    handleDisconnect,
    handleReconnect,
    handleLeave,
    publicState,
    destroy,
  };
}

module.exports = { createGame };
