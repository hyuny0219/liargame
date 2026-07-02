'use strict';

// ---------- 게임방 렌더링 ----------

const PHASE_TITLES = {
  role: '🎭 역할 확인!',
  describe: '💬 설명 시간!',
  discuss: '🗣️ 토론 시간!',
  vote: '🗳️ 투표!',
  guess: '😈 최종 추리!',
  judge: '⚖️ 정답 판정!',
  result: '📋 라운드 결과',
  final: '🏆 최종 결과',
};

function playerName(id) {
  if (!App.room) return '?';
  const p = App.room.players.find((q) => q.id === id);
  if (p) return p.nickname;
  const game = App.room.game;
  return (game && game.names && game.names[id]) || '???';
}

function renderRoom() {
  const room = App.room;
  if (!room) return;
  $('#room-title').textContent = (room.isPublic ? '🌐 ' : '🔒 ') + room.name;
  $('#room-code-chip').textContent = 'CODE: ' + room.code + ' 📋';
  $('#players-count').textContent = room.players.length;
  renderPlayers();
  const area = $('#game-area');
  if (room.state === 'waiting') renderWaiting(area);
  else renderGame(area);
  updateChatInput();
}

// ---------- 점수판 (드로어/사이드 패널) ----------

function renderPlayers() {
  const room = App.room;
  const panel = $('#players-panel');
  const game = room.game;
  const votedSet = new Set(game && game.phase === 'vote' ? game.votedIds : []);
  const iAmHost = room.hostId === App.me.playerId;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  let html = '';
  let lastScore = null;
  let lastRank = 0;
  sorted.forEach((p, i) => {
    const rank = p.score === lastScore ? lastRank : i + 1;
    lastScore = p.score;
    lastRank = rank;
    const isMe = p.id === App.me.playerId;
    const showRank = room.state === 'playing' || sorted.some((q) => q.score > 0);
    html += `
      <div class="player-row">
        <span class="rankchip">${showRank ? (medals[rank - 1] || rank) : '·'}</span>
        ${avatarHtml(p.id)}
        <span class="pname ${isMe ? 'me' : ''}">${escapeHtml(p.nickname)}${isMe ? ' (나)' : ''}
          ${room.hostId === p.id ? ' 👑' : ''}${p.connected ? '' : ' <span class="off">(연결 끊김)</span>'}</span>
        ${votedSet.has(p.id) ? '<span class="voted-mark" title="투표 완료">✔</span>' : ''}
        <span class="score">⭐ ${p.score}</span>
        ${iAmHost && !isMe ? `<button class="kick-btn" data-kick="${p.id}" data-kick-name="${escapeHtml(p.nickname)}" title="강퇴">✕</button>` : ''}
      </div>`;
  });
  panel.innerHTML = html;

  panel.querySelectorAll('[data-kick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm(`${btn.dataset.kickName}님을 강퇴하시겠습니까? 강퇴하면 이 방에 다시 들어올 수 없습니다.`)) return;
      App.socket.emit('room:kick', { targetId: btn.dataset.kick }, (res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      });
    });
  });
}

// ---------- 대기실 ----------

function renderWaiting(area) {
  const room = App.room;
  const isHost = room.hostId === App.me.playerId;
  const s = room.settings;
  const connectedCount = room.players.filter((p) => p.connected).length;

  let html = `
    <div class="waiting-head">
      <div class="big">🎈 파티 대기 중</div>
      <div class="desc">${room.isPublic ? '공개방' : '비공개방'} · 친구에게 코드 <b>${room.code}</b>를 공유하세요</div>
      <button id="invite-btn" class="btn3d small yellow" style="margin-top:12px">🔗 초대 링크 공유</button>
    </div>
    <div class="settings-chips">
      <span class="badge">${MODE_ICONS[s.mode]} ${MODE_LABELS[s.mode]} 모드</span>
      <span class="badge">${s.rounds}라운드</span>
      <span class="badge">발언 ${s.describeTime}초</span>
      <span class="badge">토론 ${s.discussTime}초</span>
      <span class="badge">최대 ${s.maxPlayers}명</span>
      <span class="badge">카테고리 ${s.categories.length}개</span>
    </div>`;

  if (isHost) {
    html += `
      <button id="start-btn" class="btn3d block" style="font-size:19px;padding:16px">🚀 게임 시작! (${connectedCount}명 접속 중)</button>
      <div class="card panel" style="margin-top:14px;padding:14px 18px">
        <details class="advanced" style="border:none;padding:0;margin:0">
          <summary>⚙️ 게임 설정 변경</summary>
          <div id="settings-editor"></div>
        </details>
      </div>`;
  } else {
    html += `<div class="big-msg">방장이 게임을 시작할 때까지 기다려주세요 ⏳<br><span class="em">채팅으로 인사를 나눠보세요!</span></div>`;
  }
  area.innerHTML = html;

  $('#invite-btn').addEventListener('click', () => {
    const url = `${location.origin}/?room=${room.code}`;
    const text = `🎭 라이어게임에 초대합니다! (방 코드: ${room.code})`;
    if (navigator.share) {
      navigator.share({ title: '라이어게임 초대', text, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => showToast('초대 링크가 복사되었습니다!', true));
    } else {
      showToast(url, true);
    }
  });

  if (isHost) {
    $('#start-btn').addEventListener('click', () => {
      App.socket.emit('game:start', null, (res) => {
        if (res && !res.ok) showToast(res.error || '시작할 수 없습니다.');
      });
    });
    const editor = $('#settings-editor');
    editor.innerHTML = settingsFieldsHtml(room.settings, 'edit') +
      '<button id="save-settings-btn" class="btn3d small mint block">설정 저장</button>';
    bindModeDesc('edit');
    $('#save-settings-btn').addEventListener('click', () => {
      const settings = readSettingsFields('edit');
      const err = validateSettings(settings);
      if (err) return showToast(err);
      App.socket.emit('room:settings', { settings }, (res) => {
        if (res && res.ok) showToast('설정이 저장되었습니다.', true);
        else showToast((res && res.error) || '설정 변경에 실패했습니다.');
      });
    });
  }
}

// ---------- 게임 진행 ----------

function renderGame(area) {
  const room = App.room;
  const game = room.game;
  if (!game) { area.innerHTML = ''; return; }
  const me = App.me.playerId;
  const isHost = room.hostId === me;

  let html = '';
  if (game.phase !== 'final') {
    html += `
      <div class="phase-row">
        <span class="phase-sticker">${PHASE_TITLES[game.phase] || ''}</span>
        <span class="badge purple">ROUND ${game.round}/${game.totalRounds}</span>
        <span class="badge">${escapeHtml(game.category || '')}</span>
      </div>`;
  }

  // 관전자(이번 라운드 미참여) 안내
  const spectating = game.order.length && !game.order.includes(me);
  if (spectating && game.phase !== 'final') {
    html += `<div class="big-msg">🎬 <span class="em">관전 중</span>입니다. 다음 라운드부터 참여할 수 있어요!</div>`;
  }

  switch (game.phase) {
    case 'role':
      if (App.myRole) html += roleCardHtml(App.myRole, false);
      html += `<div class="big-msg">역할과 제시어를 확인하세요.<br>곧 <span class="em">설명 단계</span>가 시작됩니다!</div>`;
      break;
    case 'describe':
      if (App.myRole) html += roleCardHtml(App.myRole, true);
      html += orderStripHtml(game);
      break;
    case 'discuss':
      if (App.myRole) html += roleCardHtml(App.myRole, true);
      html += orderStripHtml(game);
      html += `<div class="big-msg">채팅으로 자유롭게 토론하세요.<br>누가 <span class="em">라이어</span>일까요? 🤔</div>`;
      if (isHost) {
        html += `<button id="skip-discuss-btn" class="btn3d block">🗳️ 토론 끝내고 바로 투표하기</button>`;
      }
      break;
    case 'vote':
      if (App.myRole) html += roleCardHtml(App.myRole, true);
      html += voteHtml(game, me);
      break;
    case 'guess':
      html += guessHtml(game, me);
      break;
    case 'judge':
      html += judgeHtml(game, me);
      break;
    case 'result':
      html += resultHtml(game, isHost);
      break;
    case 'final':
      html += finalHtml(room, isHost);
      break;
  }
  area.innerHTML = html;
  bindGameEvents(game, me, isHost);
}

function roleCardHtml(role, mini) {
  const isLiar = role.role === 'liar';
  let label;
  let word;
  if (isLiar) {
    label = `내 역할 · ${escapeHtml(role.category)} · 라이어`;
    word = `<span class="${mini ? 'rm-word' : 'rc-word'} liar">제시어를 모릅니다! 아는 척 연기하세요 😈</span>`;
  } else if (role.role === 'spy') {
    label = `내 역할 · ${escapeHtml(role.category)} · 스파이 (라이어: ${escapeHtml(role.liarName)})`;
    word = `<span class="${mini ? 'rm-word' : 'rc-word'}">${escapeHtml(role.word)}</span>`;
  } else {
    label = `내 역할 · ${escapeHtml(role.category)} · 시민`;
    word = `<span class="${mini ? 'rm-word' : 'rc-word'}">${escapeHtml(role.word)}</span>`;
  }
  const emoji = isLiar ? '🃏' : role.role === 'spy' ? '🕵️' : '🙂';
  if (mini) {
    return `
      <div class="role-mini ${isLiar || role.role === 'spy' ? 'liar-card' : ''} ${App.roleHidden ? 'blurred' : ''}" id="role-card">
        <span class="rm-emoji">${emoji}</span>
        <div class="rm-body" style="min-width:0">
          <div class="rm-label">${label}</div>
          <div>${word}</div>
        </div>
        <div class="grow"></div>
        <button id="role-toggle" class="btn3d small yellow">${App.roleHidden ? '👀 보기' : '👀 가리기'}</button>
      </div>`;
  }
  return `
    <div class="role-card ${isLiar || role.role === 'spy' ? 'liar-card' : ''} ${App.roleHidden ? 'blurred' : ''}" id="role-card">
      <span class="rc-emoji">${emoji}</span>
      <div class="rc-body" style="min-width:0;flex:1">
        <div class="rc-label">${label}</div>
        <div>${word}</div>
      </div>
      <button id="role-toggle" class="btn3d small yellow">${App.roleHidden ? '👀 보기' : '👀 가리기'}</button>
    </div>`;
}

function orderStripHtml(game) {
  let html = '<div class="order-row">';
  game.order.forEach((id, i) => {
    const done = game.phase !== 'describe' || i < game.turnIndex;
    const current = game.phase === 'describe' && i === game.turnIndex;
    html += `
      <div class="seat ${done && !current ? 'done' : ''} ${current ? 'current' : ''}">
        ${current ? '<span class="now-label">지금 설명 중!</span>' : ''}
        ${avatarHtml(id)}
        <div class="sname">${escapeHtml(playerName(id))}${id === App.me.playerId ? ' (나)' : ''}${done && !current ? ' ✔' : ''}</div>
      </div>`;
  });
  return html + '</div>';
}

// 각 플레이어의 마지막 설명 한 줄 (투표 힌트용)
function lastDescribeOf(game, id) {
  for (let i = game.describes.length - 1; i >= 0; i--) {
    const d = game.describes[i];
    if (d.playerId === id && d.text) return d.text;
  }
  return null;
}

function voteHtml(game, me) {
  const candidates = game.tieCandidates || game.order;
  const iCanVote = game.order.includes(me);
  let html = `
    <div class="vote-head">
      <div class="vt">${game.tieCandidates ? '⚠️ 동표! 재투표!' : '🗳️ 라이어를 지목하라!'}</div>
      <div class="sub">${game.tieCandidates ? '최다 득표자 중에서 다시 선택하세요' : '카드를 눌러 투표 · 마감 전까지 변경 가능'}</div>
    </div>
    <div class="vote-grid">`;
  for (const id of candidates) {
    const selected = App.myVote === id;
    const disabled = !iCanVote || id === me;
    const hint = lastDescribeOf(game, id);
    html += `
      <button class="vote-btn ${selected ? 'selected' : ''}" data-vote="${id}" ${disabled ? 'disabled' : ''}>
        ${avatarHtml(id)}
        <div class="vname">${escapeHtml(playerName(id))}${id === me ? ' (나)' : ''}</div>
        <div class="vhint">${id === me ? '투표 불가' : hint ? '"' + escapeHtml(hint) + '"' : ''}</div>
      </button>`;
  }
  html += '</div>';

  const required = game.order.filter((id) => {
    const p = App.room.players.find((q) => q.id === id);
    return p && p.connected;
  });
  const notVoted = required.filter((id) => !game.votedIds.includes(id)).map((id) => playerName(id));
  const pct = required.length ? Math.round((game.votedIds.length / required.length) * 100) : 0;
  html += `
    <div class="pbar"><div class="fill" style="width:${pct}%"></div></div>
    <div class="big-msg" style="padding:10px 0 0">${game.votedIds.length}/${required.length}명 투표 완료${
      notVoted.length ? ' · 기다리는 중: <span class="em">' + notVoted.map(escapeHtml).join(', ') + '</span>' : ''}</div>`;
  return html;
}

// 스포트라이트 무대 (지목 발표)
function spotlightHtml(game, voteCount) {
  const rays = [...Array(8)].map((_, i) =>
    `<div class="ray" style="transform:translate(-50%,-100%) rotate(${i * 45}deg)"></div>`).join('');
  return `
    <div class="spotlight-stage">
      <div class="glow"></div>
      <div class="rays">${rays}</div>
      ${avatarHtml(game.accusedId)}
      ${voteCount ? `<span class="vote-count">🎯 ${voteCount}표!</span>` : ''}
    </div>
    <div class="spot-title">${escapeHtml(game.accusedName)}님이 지목되었습니다!</div>`;
}

// 득표 현황 막대
function tallyHtml(votes, title) {
  const entries = Object.entries(votes || {});
  if (!entries.length) return '';
  const counts = {};
  for (const t of Object.values(votes)) counts[t] = (counts[t] || 0) + 1;
  const max = Math.max(...Object.values(counts));
  const barColors = ['var(--coral)', 'var(--blue)', 'var(--mint)', 'var(--yellow)', 'var(--purple)'];
  let html = `<div class="card tally-card"><div class="tc-title">${title || '🧾 득표 현황'}</div>`;
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([id, c], i) => {
    html += `
      <div class="tally-row">
        <span class="tname">${avatarFor(id).emoji} ${escapeHtml(playerName(id))}</span>
        <div class="tbar"><div style="width:${Math.round((c / max) * 100)}%;background:${barColors[i % barColors.length]}"></div></div>
        <span class="tcnt">${c}표</span>
      </div>`;
  });
  const detail = entries.map(([v, t]) => `${escapeHtml(playerName(v))} → ${escapeHtml(playerName(t))}`).join(' · ');
  html += `<div class="vote-detail">${detail}</div></div>`;
  return html;
}

function guessHtml(game, me) {
  const voteCount = game.votesDetail
    ? Object.values(game.votesDetail).filter((t) => t === game.accusedId).length : 0;
  if (game.accusedId === me) {
    const hints = game.describes.filter((d) => d.text && d.playerId !== me)
      .map((d) => `<span>💬 "${escapeHtml(d.text)}"</span>`).join('');
    return `
      <div class="vote-head" style="margin-top:6px">
        <div class="vt" style="background:var(--navy);box-shadow:0 6px 0 var(--navy-deep),0 10px 0 rgba(0,0,0,.35)">😈 마지막 기회!</div>
        <div class="sub">당신이 지목되었습니다! 제시어를 맞히면 <b style="color:var(--yellow-soft)">역전승 (+2점)</b> 🔥</div>
      </div>
      <div class="card" style="text-align:center">
        <div class="note-msg">카테고리: ${escapeHtml(game.category)} · 다른 사람들의 설명을 떠올려보세요!</div>
        ${hints ? `<div class="guess-hints">${hints}</div>` : ''}
        <div class="guess-box">
          <input id="guess-input" type="text" maxlength="30" placeholder="제시어를 입력하세요..." autocomplete="off">
        </div>
        <button id="guess-btn" class="btn3d block">🎯 정답 제출!</button>
      </div>`;
  }
  return `
    ${spotlightHtml(game, voteCount)}
    <div class="big-msg">과연 ${escapeHtml(game.accusedName)}님이 라이어일까요...? 🫣<br>
      라이어라면 지금 <span class="em">제시어를 추리하는 중</span>입니다!</div>
    ${tallyHtml(game.votesDetail)}`;
}

function judgeHtml(game, me) {
  if (game.judgeId === me && App.judgePrompt) {
    return `
      <div class="card" style="text-align:center">
        <div class="judge-pair">라이어의 답: <b>${escapeHtml(App.judgePrompt.guess)}</b></div>
        <div class="judge-pair">정답: <b>${escapeHtml(App.judgePrompt.word)}</b></div>
        <div class="note-msg">사실상 같은 답이면 정답으로 인정해주세요!</div>
        <div class="judge-actions">
          <button id="judge-ok" class="btn3d mint">⭕ 정답 인정</button>
          <button id="judge-no" class="btn3d">❌ 오답</button>
        </div>
      </div>`;
  }
  return `
    ${spotlightHtml(game, null)}
    <div class="big-msg">라이어의 답: <span class="em">"${escapeHtml(game.guessText || '')}"</span><br>
      ${escapeHtml(playerName(game.judgeId))}님이 정답 여부를 판정하는 중... ⚖️</div>`;
}

const OUTCOME_VIEW = {
  liarSurvived: { emoji: '😈', title: '라이어 승리!', sub: '정체를 끝까지 숨겼습니다', cls: 'liar-win' },
  liarGuessed: { emoji: '🃏', title: '라이어 역전승!', sub: '제시어까지 맞혀버렸습니다!', cls: 'liar-win' },
  liarCaught: { emoji: '🎉', title: '시민 승리!', sub: '라이어를 잡았습니다!', cls: 'citizen-win' },
  spyCaught: { emoji: '🎉', title: '시민 승리!', sub: '스파이를 잡았습니다!', cls: 'citizen-win' },
  voided: { emoji: '😵', title: '라운드 무효', sub: '', cls: 'voided' },
};

function resultHtml(game, isHost) {
  const r = game.result;
  if (!r) return '';
  const v = OUTCOME_VIEW[r.voided ? 'voided' : r.outcome] || OUTCOME_VIEW.voided;
  let html = `
    <div class="result-banner ${v.cls}">
      <div class="rb-emoji">${v.emoji}</div>
      <div class="rb-title">${v.title}</div>
      <div class="rb-sub">${r.voided ? escapeHtml(r.reason || '') : v.sub}</div>
    </div>
    <div class="card reveal-card">
      <div class="rv-row">제시어 <span class="word-pill">${escapeHtml(r.word)}</span> <span style="color:var(--muted)">(${escapeHtml(r.category)})</span></div>
      <div class="rv-row">라이어는 ${avatarHtml(r.liarId, 'sm')} <b>${escapeHtml(r.liarName)}</b>님!${
        r.fakeWord ? ` <span style="color:var(--muted)">바보 모드 제시어: ${escapeHtml(r.fakeWord)}</span>` : ''}</div>
      ${r.spyName ? `<div class="rv-row">스파이는 ${avatarHtml(r.spyId, 'sm')} <b>${escapeHtml(r.spyName)}</b>님!</div>` : ''}
      ${r.guessText ? `<div class="rv-row">라이어의 추리: <b>"${escapeHtml(r.guessText)}"</b></div>` : ''}
    </div>`;
  const deltas = Object.entries(r.deltas || {});
  if (deltas.length) {
    html += '<div class="card delta-list">';
    deltas.sort((a, b) => b[1] - a[1]).forEach(([id, d]) => {
      html += `
        <div class="delta-row">
          ${avatarHtml(id, 'sm')}
          <span class="dname">${escapeHtml(playerName(id))}</span>
          <span class="dplus">+${d}점 ⭐</span>
        </div>`;
    });
    html += '</div>';
  }
  html += tallyHtml(r.votes);
  html += isHost
    ? `<button id="next-btn" class="btn3d block" style="font-size:18px">${game.round >= game.totalRounds ? '🏆 최종 결과 보기' : '▶️ 다음 라운드!'}</button>`
    : `<div class="big-msg">방장이 진행할 때까지 잠시만요... ⏳</div>`;
  return html;
}

function finalHtml(room, isHost) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const [first, second, third] = sorted;
  let html = `
    <div class="vote-head" style="margin-top:8px">
      <div class="vt" style="background:var(--yellow);color:var(--navy);text-shadow:none;box-shadow:0 6px 0 var(--yellow-dark),0 10px 0 rgba(43,35,80,.5)">🏆 최종 결과!</div>
    </div>
    <div class="podium">`;
  const pd = (p, cls, medal) => p ? `
    <div class="pd ${cls}">
      ${avatarHtml(p.id)}
      <div class="pd-name">${escapeHtml(p.nickname)}</div>
      <div class="pd-block">${medal}</div>
    </div>` : '';
  html += pd(second, 'second', '🥈') + pd(first, 'first', '🥇') + pd(third, 'third', '🥉');
  html += '</div><div class="card rank-list">';
  const medals = ['🥇', '🥈', '🥉'];
  sorted.forEach((p, i) => {
    html += `
      <div class="rank-row">
        <span class="rr-rank">${medals[i] || (i + 1) + '위'}</span>
        ${avatarHtml(p.id, 'sm')}
        <span class="rr-name">${escapeHtml(p.nickname)}${p.id === App.me.playerId ? ' (나)' : ''}</span>
        <span class="rr-score">⭐ ${p.score}점</span>
      </div>`;
  });
  html += '</div>';
  html += isHost
    ? '<button id="next-btn" class="btn3d mint block">🏠 대기실로 돌아가기</button>'
    : '<div class="big-msg">수고하셨습니다! 🎉<br>방장이 대기실로 이동할 때까지 기다려주세요.</div>';
  return html;
}

// ---------- 이벤트 바인딩 ----------

function bindGameEvents(game, me, isHost) {
  const roleToggle = $('#role-toggle');
  if (roleToggle) {
    roleToggle.addEventListener('click', () => {
      App.roleHidden = !App.roleHidden;
      $('#role-card').classList.toggle('blurred', App.roleHidden);
      roleToggle.textContent = App.roleHidden ? '👀 보기' : '👀 가리기';
    });
  }

  document.querySelectorAll('[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.vote;
      const voteRound = App.room.game ? App.room.game.voteRound : 0;
      App.socket.emit('game:vote', { targetId, voteRound }, (res) => {
        if (res && res.ok) {
          App.myVote = targetId;
          if (navigator.vibrate) navigator.vibrate(60);
        } else if (res && res.error) showToast(res.error);
      });
    });
  });

  const skipBtn = $('#skip-discuss-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      App.socket.emit('game:skipDiscuss', null, (res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      });
    });
  }

  const guessBtn = $('#guess-btn');
  if (guessBtn) {
    const submit = () => {
      const text = $('#guess-input').value.trim();
      if (!text) return;
      App.socket.emit('game:guess', { text }, (res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      });
    };
    guessBtn.addEventListener('click', submit);
    $('#guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    $('#guess-input').focus();
  }

  const judgeOk = $('#judge-ok');
  if (judgeOk) {
    judgeOk.addEventListener('click', () => App.socket.emit('game:judge', { correct: true }, () => {}));
    $('#judge-no').addEventListener('click', () => App.socket.emit('game:judge', { correct: false }, () => {}));
  }

  const nextBtn = $('#next-btn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      App.socket.emit('game:next', null, (res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      });
    });
  }
}
