'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const roomsMod = require('./rooms');
const { createGame } = require('./game');
const { CATEGORIES } = require('./words');

const PORT = process.env.PORT || 3000;
const SITE_CODE = process.env.SITE_CODE || '1234';

const fs = require('fs');

const app = express();
app.set('trust proxy', true); // Render 등 프록시 뒤에서 https/host 인식
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

// OG 태그의 __ORIGIN__을 실제 배포 주소로 치환해 링크 미리보기가 동작하게 한다
app.get(['/', '/index.html'], (req, res) => {
  // Host 헤더는 안전한 문자만 허용 (HTML 주입 방지), 치환값은 함수로 전달해 $ 패턴 해석 차단
  const host = String(req.get('host') || '').replace(/[^a-zA-Z0-9.\-:[\]]/g, '');
  const proto = req.protocol === 'https' ? 'https' : 'http';
  const origin = host ? `${proto}://${host}` : '';
  res.type('html').send(INDEX_HTML.replace(/__ORIGIN__/g, () => origin));
});
app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/meta', (req, res) => res.json({ categories: CATEGORIES }));

const server = http.createServer(app);
const io = new Server(server);

// sessionId(비밀) -> { sessionId, playerId(공개), nickname, roomCode }
const sessions = new Map();
const sessionsByPlayer = new Map(); // playerId -> session
const playerSockets = new Map(); // playerId -> socket

const WAITING_DISCONNECT_MS = 60 * 1000; // 대기실에서 연결 끊긴 플레이어 제거 유예
const EMPTY_ROOM_MS = 5 * 60 * 1000; // 전원 연결 끊긴 방 삭제 유예
const AUTH_MAX_FAILS = 10; // IP당 접속코드 실패 허용 횟수
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000; // 실패 횟수 초기화 주기
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 미사용 세션 보관 기간

// 접속코드 무차별 대입 방지: IP별 실패 횟수 제한
const authFails = new Map(); // ip -> { count, resetAt }

function clientIp(socket) {
  const fwd = String(socket.handshake.headers['x-forwarded-for'] || '');
  return fwd.split(',')[0].trim() || socket.handshake.address || 'unknown';
}

function isAuthLimited(ip) {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (rec.resetAt < Date.now()) {
    authFails.delete(ip);
    return false;
  }
  return rec.count >= AUTH_MAX_FAILS;
}

function recordAuthFail(ip) {
  const now = Date.now();
  let rec = authFails.get(ip);
  if (!rec || rec.resetAt < now) rec = { count: 0, resetAt: now + AUTH_FAIL_WINDOW_MS };
  rec.count++;
  authFails.set(ip, rec);
}

// 방에 없고 오래 사용되지 않은 세션 정리 (메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [sid, sess] of sessions) {
    const idle = now - (sess.lastSeen || 0) > SESSION_TTL_MS;
    if (idle && !sess.roomCode && !playerSockets.has(sess.playerId)) {
      sessions.delete(sid);
      sessionsByPlayer.delete(sess.playerId);
    }
  }
  for (const [ip, rec] of authFails) {
    if (rec.resetAt < now) authFails.delete(ip);
  }
}, 60 * 60 * 1000).unref();

function roomChannel(code) {
  return `room:${code}`;
}

// ---------- 봇 플레이어 관리 ----------

const BOT_NAMES = ['알파', '베타', '감마', '델타', '오메가', '시그마', '루나', '코코'];

function addBot(room) {
  if (room.players.size >= room.settings.maxPlayers) return null;
  const used = new Set([...room.players.values()].map((p) => p.nickname));
  const name = BOT_NAMES.find((n) => !used.has('🤖 ' + n));
  if (!name) return null;
  const bot = {
    id: 'bot_' + crypto.randomBytes(6).toString('hex'),
    nickname: '🤖 ' + name,
    connected: true, // 봇은 항상 접속 상태
    score: 0,
    isBot: true,
    disconnectTimer: null,
  };
  room.players.set(bot.id, bot);
  return bot;
}

function hasConnectedHuman(room) {
  return [...room.players.values()].some((p) => p.connected && !p.isBot);
}

function humansOnly(room) {
  return [...room.players.values()].filter((p) => !p.isBot);
}

const CHAT_HISTORY_MAX = 100;

// 채팅을 방 히스토리에 남기면서 브로드캐스트 (새로고침 시 복원용)
function pushChat(room, msg) {
  room.history.push(msg);
  if (room.history.length > CHAT_HISTORY_MAX) room.history.shift();
  io.to(roomChannel(room.code)).emit('chat', msg);
}

function systemMsg(room, text) {
  pushChat(room, { kind: 'system', text });
}

function roomPublicState(room) {
  return {
    serverNow: Date.now(), // 클라이언트 타이머의 시계 오차 보정용
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
      score: p.score,
      isBot: !!p.isBot,
    })),
    game: room.game ? room.game.publicState() : null,
  };
}

function broadcastRoomState(room) {
  io.to(roomChannel(room.code)).emit('room:state', roomPublicState(room));
}

function updateLobby() {
  io.to('lobby').emit('lobby:rooms', roomsMod.publicRoomList());
}

function destroyRoom(room) {
  io.to(roomChannel(room.code)).emit('room:closed');
  roomsMod.deleteRoom(room.code);
  updateLobby();
}

function gameCtx(room) {
  return {
    emitRoom: (ev, data) => io.to(roomChannel(room.code)).emit(ev, data),
    chat: (msg) => pushChat(room, msg),
    emitPlayer: (playerId, ev, data) => {
      const s = playerSockets.get(playerId);
      if (s) s.emit(ev, data);
    },
    broadcastRoom: () => broadcastRoomState(room),
    systemMsg: (text) => systemMsg(room, text),
    // 라운드 결과를 각 플레이어의 세션 전적에 반영
    recordRound: (result) => {
      if (result.voided) return;
      const liarWin = result.outcome === 'liarSurvived' || result.outcome === 'liarGuessed';
      for (const pid of result.participants || []) {
        if (!room.players.has(pid)) continue; // 라운드 중 이탈자는 점수 규칙과 동일하게 제외
        const s = sessionsByPlayer.get(pid);
        if (!s || !s.stats) continue;
        s.stats.rounds++;
        if (pid === result.liarId) {
          s.stats.liarRounds++;
          if (liarWin) { s.stats.liarWins++; s.stats.wins++; }
        } else if (result.spyId && pid === result.spyId) {
          if (liarWin) s.stats.wins++;
        } else if (!liarWin) {
          s.stats.wins++;
        }
      }
    },
    endGame: () => {
      room.state = 'waiting';
      room.game = null;
      // 게임 중 연결이 끊긴 채 돌아오지 않은 플레이어는 대기실 유예 규칙으로 정리
      for (const p of room.players.values()) {
        if (!p.connected) scheduleWaitingRemoval(room, p);
      }
      broadcastRoomState(room);
      updateLobby();
    },
  };
}

function scheduleEmptyCheck(room) {
  // 봇만 남은 방은 유지할 이유가 없으므로 '사람' 기준으로 판단한다
  if (hasConnectedHuman(room)) {
    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }
    return;
  }
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    const r = roomsMod.getRoom(room.code);
    if (r && !hasConnectedHuman(r)) {
      for (const p of r.players.values()) {
        const sess = sessionsByPlayer.get(p.id);
        if (sess && sess.roomCode === r.code) sess.roomCode = null;
      }
      destroyRoom(r);
    }
  }, EMPTY_ROOM_MS);
}

// 대기 상태에서 연결이 끊긴 플레이어를 유예 시간 후 제거
function scheduleWaitingRemoval(room, player) {
  if (player.disconnectTimer) return;
  player.disconnectTimer = setTimeout(() => {
    player.disconnectTimer = null;
    const r = roomsMod.getRoom(room.code);
    if (!r) return;
    const cur = r.players.get(player.id);
    if (cur && !cur.connected) removePlayer(r, player.id);
  }, WAITING_DISCONNECT_MS);
}

// 방장 위임 대상 선택: 사람만, 게임 중이면 라운드 참가자 우선, 그다음 접속자 순
function pickNextHost(room) {
  const humans = humansOnly(room);
  const order = room.game ? room.game.publicState().order : [];
  return humans.find((p) => p.connected && order.includes(p.id))
    || humans.find((p) => p.connected)
    || humans[0];
}

function removePlayer(room, playerId, opts) {
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  room.players.delete(playerId);
  const sess = sessionsByPlayer.get(playerId);
  if (sess && sess.roomCode === room.code) sess.roomCode = null;

  // 사람이 한 명도 없으면(빈 방 또는 봇만 남음) 방 삭제
  if (room.players.size === 0 || humansOnly(room).length === 0) {
    destroyRoom(room);
    return;
  }
  if (!opts || !opts.silent) systemMsg(room, `${player.nickname}님이 나갔습니다.`);
  if (room.hostId === playerId) {
    const next = pickNextHost(room);
    if (next) {
      room.hostId = next.id;
      systemMsg(room, `${next.nickname}님이 새 방장이 되었습니다.`);
    }
  }
  if (room.game) {
    room.game.handleLeave(playerId);
  } else {
    broadcastRoomState(room);
  }
  scheduleEmptyCheck(room);
  updateLobby();
}

io.on('connection', (socket) => {
  socket.data.session = null;

  const cbOf = (cb) => (typeof cb === 'function' ? cb : () => {});

  function currentCtx() {
    const sess = socket.data.session;
    if (!sess) return { sess: null, room: null };
    const room = sess.roomCode ? roomsMod.getRoom(sess.roomCode) : null;
    return { sess, room };
  }

  socket.on('auth', (data, cb) => {
    cb = cbOf(cb);
    const nickname = String((data && data.nickname) || '').trim().slice(0, 12);
    let sess = data && data.sessionId ? sessions.get(String(data.sessionId)) : null;

    if (!sess) {
      const ip = clientIp(socket);
      if (isAuthLimited(ip)) {
        return cb({ ok: false, error: '시도가 너무 많습니다. 15분 후 다시 시도해주세요.' });
      }
      if (String((data && data.code) || '') !== SITE_CODE) {
        recordAuthFail(ip);
        return cb({ ok: false, error: '접속코드가 올바르지 않습니다.' });
      }
      if (!nickname) return cb({ ok: false, error: '닉네임을 입력해주세요.' });
      sess = {
        sessionId: crypto.randomBytes(16).toString('hex'),
        playerId: 'p_' + crypto.randomBytes(6).toString('hex'),
        nickname,
        roomCode: null,
        stats: { rounds: 0, wins: 0, liarRounds: 0, liarWins: 0 },
      };
      sessions.set(sess.sessionId, sess);
      sessionsByPlayer.set(sess.playerId, sess);
    } else if (nickname && !sess.roomCode) {
      sess.nickname = nickname;
    }
    sess.lastSeen = Date.now();

    // 같은 세션의 이전 소켓(다른 탭 등)은 끊는다
    const old = playerSockets.get(sess.playerId);
    if (old && old !== socket) {
      old.data.session = null;
      old.emit('session:takeover');
      old.disconnect(true);
    }
    socket.data.session = sess;
    playerSockets.set(sess.playerId, socket);

    let roomState = null;
    const room = sess.roomCode ? roomsMod.getRoom(sess.roomCode) : null;
    if (room && room.players.has(sess.playerId)) {
      // 재접속: 기존 방으로 복귀
      const p = room.players.get(sess.playerId);
      p.connected = true;
      if (p.disconnectTimer) {
        clearTimeout(p.disconnectTimer);
        p.disconnectTimer = null;
      }
      socket.join(roomChannel(room.code));
      scheduleEmptyCheck(room);
      systemMsg(room, `${p.nickname}님이 다시 접속했습니다.`);
      // 현재 방장이 오프라인이면 재접속한 플레이어에게 방장 위임 (진행 불가 상태 방지)
      const curHost = room.players.get(room.hostId);
      if (!curHost || !curHost.connected) {
        room.hostId = sess.playerId;
        systemMsg(room, `${p.nickname}님이 새 방장이 되었습니다.`);
      }
      if (room.game) room.game.handleReconnect(sess.playerId);
      else broadcastRoomState(room);
      roomState = roomPublicState(room);
      updateLobby();
    } else {
      sess.roomCode = null;
      socket.join('lobby');
      socket.emit('lobby:rooms', roomsMod.publicRoomList());
    }
    cb({
      ok: true,
      sessionId: sess.sessionId,
      playerId: sess.playerId,
      nickname: sess.nickname,
      stats: sess.stats,
      room: roomState,
      chatHistory: roomState ? roomsMod.getRoom(sess.roomCode).history : undefined,
    });
  });

  socket.on('lobby:list', (data, cb) => {
    if (!socket.data.session) return cbOf(cb)({ ok: false, error: '로그인이 필요합니다.' });
    cbOf(cb)({ ok: true, rooms: roomsMod.publicRoomList(), stats: socket.data.session.stats });
  });

  socket.on('room:create', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room: cur } = currentCtx();
    if (!sess) return cb({ ok: false, error: '로그인이 필요합니다.' });
    if (cur) return cb({ ok: false, error: '이미 방에 참여 중입니다.' });
    const name = String((data && data.name) || '').trim().slice(0, 20) || `${sess.nickname}의 방`;
    const room = roomsMod.createRoom({
      name,
      isPublic: !!(data && data.isPublic),
      settings: data && data.settings,
      hostId: sess.playerId,
    });
    room.players.set(sess.playerId, {
      id: sess.playerId,
      nickname: sess.nickname,
      connected: true,
      score: 0,
      disconnectTimer: null,
    });
    sess.roomCode = room.code;
    socket.leave('lobby');
    socket.join(roomChannel(room.code));
    broadcastRoomState(room);
    updateLobby();
    cb({ ok: true, room: roomPublicState(room) });
  });

  socket.on('room:join', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room: cur } = currentCtx();
    if (!sess) return cb({ ok: false, error: '로그인이 필요합니다.' });
    if (cur) return cb({ ok: false, error: '이미 방에 참여 중입니다.' });
    const room = roomsMod.getRoom((data && data.code) || '');
    if (!room) return cb({ ok: false, error: '존재하지 않는 방 코드입니다.' });
    if (room.banned.has(sess.playerId) || room.bannedNames.has(sess.nickname) || room.bannedIps.has(clientIp(socket))) {
      return cb({ ok: false, error: '이 방에서 강퇴되어 다시 입장할 수 없습니다.' });
    }
    // 게임 중에도 입장 허용(관전) — 현재 라운드는 구경만 하고 다음 라운드부터 참여
    if (room.players.size >= room.settings.maxPlayers) return cb({ ok: false, error: '방이 가득 찼습니다.' });
    const dup = [...room.players.values()].some((p) => p.nickname === sess.nickname);
    if (dup) return cb({ ok: false, error: '같은 닉네임의 플레이어가 이미 방에 있습니다.' });

    room.players.set(sess.playerId, {
      id: sess.playerId,
      nickname: sess.nickname,
      connected: true,
      score: 0,
      disconnectTimer: null,
    });
    sess.roomCode = room.code;
    socket.leave('lobby');
    socket.join(roomChannel(room.code));
    scheduleEmptyCheck(room);
    systemMsg(room, `${sess.nickname}님이 입장했습니다.`);
    broadcastRoomState(room);
    updateLobby();
    cb({ ok: true, room: roomPublicState(room), chatHistory: room.history });
  });

  socket.on('room:leave', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: true });
    socket.leave(roomChannel(room.code));
    removePlayer(room, sess.playerId);
    socket.join('lobby');
    socket.emit('lobby:rooms', roomsMod.publicRoomList());
    cb({ ok: true });
  });

  socket.on('room:addBot', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: false, error: '방에 참여하고 있지 않습니다.' });
    if (room.hostId !== sess.playerId) return cb({ ok: false, error: '방장만 봇을 추가할 수 있습니다.' });
    if (room.state !== 'waiting') return cb({ ok: false, error: '게임 중에는 봇을 추가할 수 없습니다.' });
    const bot = addBot(room);
    if (!bot) {
      const reason = room.players.size >= room.settings.maxPlayers
        ? '정원이 가득 차 봇을 추가할 수 없습니다.'
        : '추가할 수 있는 봇을 모두 사용했습니다.';
      return cb({ ok: false, error: reason });
    }
    systemMsg(room, `${bot.nickname}이(가) 참가했습니다. 삐빕! 🤖`);
    broadcastRoomState(room);
    updateLobby();
    cb({ ok: true, botId: bot.id });
  });

  socket.on('room:kick', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: false, error: '방에 참여하고 있지 않습니다.' });
    if (room.hostId !== sess.playerId) return cb({ ok: false, error: '방장만 강퇴할 수 있습니다.' });
    const targetId = String((data && data.targetId) || '');
    if (targetId === sess.playerId) return cb({ ok: false, error: '자기 자신은 강퇴할 수 없습니다.' });
    const target = room.players.get(targetId);
    if (!target) return cb({ ok: false, error: '대상을 찾을 수 없습니다.' });
    // 봇은 스스로 재입장하지 않으므로 차단 목록에 남기지 않는다 (이름 재사용 보장)
    if (!target.isBot) {
      room.banned.add(targetId);
      room.bannedNames.add(target.nickname);
    }
    const targetSocket = playerSockets.get(targetId);
    if (targetSocket) {
      room.bannedIps.add(clientIp(targetSocket));
      targetSocket.leave(roomChannel(room.code));
      targetSocket.emit('room:kicked');
      targetSocket.join('lobby');
      targetSocket.emit('lobby:rooms', roomsMod.publicRoomList());
    }
    systemMsg(room, `${target.nickname}님이 강퇴되었습니다.`);
    removePlayer(room, targetId, { silent: true });
    cb({ ok: true });
  });

  socket.on('room:settings', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: false, error: '방에 참여하고 있지 않습니다.' });
    if (room.hostId !== sess.playerId) return cb({ ok: false, error: '방장만 설정을 변경할 수 있습니다.' });
    if (room.state !== 'waiting') return cb({ ok: false, error: '게임 중에는 설정을 변경할 수 없습니다.' });
    room.settings = roomsMod.sanitizeSettings(data && data.settings, room.settings);
    broadcastRoomState(room);
    updateLobby();
    cb({ ok: true });
  });

  socket.on('game:start', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: false, error: '방에 참여하고 있지 않습니다.' });
    if (room.hostId !== sess.playerId) return cb({ ok: false, error: '방장만 게임을 시작할 수 있습니다.' });
    if (room.state !== 'waiting') return cb({ ok: false, error: '이미 게임이 진행 중입니다.' });
    let connected = [...room.players.values()].filter((p) => p.connected);
    // 3명 미만이면 부족한 만큼 봇을 자동 투입 (검증 실패 시 되돌린다)
    const added = [];
    if (connected.length < 3) {
      while (connected.length + added.length < 3) {
        const bot = addBot(room);
        if (!bot) break;
        added.push(bot);
      }
      connected = [...room.players.values()].filter((p) => p.connected);
    }
    const rollbackBots = () => { for (const b of added) room.players.delete(b.id); };
    if (connected.length < 3) {
      rollbackBots();
      return cb({ ok: false, error: '게임을 시작하려면 최소 3명이 필요합니다.' });
    }
    if (room.settings.mode === 'spy' && connected.length < 5) {
      rollbackBots();
      return cb({ ok: false, error: '스파이 모드는 5명 이상부터 시작할 수 있습니다. (봇 추가로 채울 수 있어요)' });
    }
    if (added.length) {
      systemMsg(room, `인원이 부족해 봇 ${added.length}명이 참가합니다! (${added.map((b) => b.nickname).join(', ')}) 🤖`);
    }
    for (const p of room.players.values()) p.score = 0;
    room.state = 'playing';
    room.game = createGame(room, gameCtx(room));
    room.game.start();
    updateLobby();
    cb({ ok: true });
  });

  socket.on('chat', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room) return cb({ ok: false, error: '방에 참여하고 있지 않습니다.' });
    const text = String((data && data.text) || '').trim().slice(0, 200);
    if (!text) return cb({ ok: false });
    if (room.game) return cb(room.game.handleChat(sess.playerId, text));
    pushChat(room, { kind: 'chat', playerId: sess.playerId, nickname: sess.nickname, text });
    cb({ ok: true });
  });

  socket.on('game:vote', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room || !room.game) return cb({ ok: false, error: '게임이 진행 중이 아닙니다.' });
    cb(room.game.handleVote(sess.playerId, String((data && data.targetId) || ''), data && data.voteRound));
  });

  socket.on('game:guess', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room || !room.game) return cb({ ok: false, error: '게임이 진행 중이 아닙니다.' });
    cb(room.game.handleGuess(sess.playerId, data && data.text));
  });

  socket.on('game:judge', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room || !room.game) return cb({ ok: false, error: '게임이 진행 중이 아닙니다.' });
    cb(room.game.handleJudge(sess.playerId, !!(data && data.correct)));
  });

  socket.on('game:skipDiscuss', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room || !room.game) return cb({ ok: false, error: '게임이 진행 중이 아닙니다.' });
    cb(room.game.handleSkipDiscuss(sess.playerId));
  });

  socket.on('game:next', (data, cb) => {
    cb = cbOf(cb);
    const { sess, room } = currentCtx();
    if (!sess || !room || !room.game) return cb({ ok: false, error: '게임이 진행 중이 아닙니다.' });
    cb(room.game.handleNext(sess.playerId));
  });

  socket.on('disconnect', () => {
    const sess = socket.data.session;
    if (!sess) return;
    sess.lastSeen = Date.now();
    if (playerSockets.get(sess.playerId) === socket) playerSockets.delete(sess.playerId);
    const room = sess.roomCode ? roomsMod.getRoom(sess.roomCode) : null;
    if (!room) return;
    const p = room.players.get(sess.playerId);
    if (!p) return;
    p.connected = false;
    systemMsg(room, `${p.nickname}님의 연결이 끊겼습니다.`);

    if (room.hostId === sess.playerId) {
      const next = pickNextHost(room);
      if (next && next.connected) {
        room.hostId = next.id;
        systemMsg(room, `${next.nickname}님이 새 방장이 되었습니다.`);
      }
    }
    if (room.state === 'waiting') {
      scheduleWaitingRemoval(room, p);
      broadcastRoomState(room);
    } else if (room.game) {
      room.game.handleDisconnect(sess.playerId);
    }
    scheduleEmptyCheck(room);
    updateLobby();
  });
});

server.listen(PORT, () => {
  console.log(`라이어게임 서버 실행 중: http://localhost:${PORT} (접속코드: ${SITE_CODE})`);
});
