'use strict';

// ---------- 게임방 렌더링 ----------

const PHASE_TITLES = {
  role: '🎭 역할 확인',
  describe: '💬 설명 단계',
  discuss: '🗣️ 토론 단계',
  vote: '🗳️ 투표 단계',
  guess: '🤔 라이어의 최종 추리',
  judge: '⚖️ 정답 판정',
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
  $('#room-code-chip').textContent = '코드: ' + room.code + ' 📋';
  renderPlayers();
  const area = $('#game-area');
  if (room.state === 'waiting') renderWaiting(area);
  else renderGame(area);
  updateChatInput();
}

function renderPlayers() {
  const room = App.room;
  const panel = $('#players-panel');
  const game = room.game;
  const votedSet = new Set(game && game.phase === 'vote' ? game.votedIds : []);
  let html = `<h3>👥 참가자 (${room.players.length}/${room.settings.maxPlayers})</h3>`;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const isMe = p.id === App.me.playerId;
    html += `
      <div class="player-row">
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        <span class="pname ${isMe ? 'me' : ''}">${escapeHtml(p.nickname)}${isMe ? ' (나)' : ''}</span>
        ${room.hostId === p.id ? '<span class="crown" title="방장">👑</span>' : ''}
        ${votedSet.has(p.id) ? '<span class="voted-mark" title="투표 완료">✔</span>' : ''}
        ${room.state === 'playing' || p.score > 0 ? `<span class="score">${p.score}점</span>` : ''}
      </div>`;
  }
  panel.innerHTML = html;
}

// ---------- 대기실 ----------

function renderWaiting(area) {
  const room = App.room;
  const isHost = room.hostId === App.me.playerId;
  const s = room.settings;
  const connectedCount = room.players.filter((p) => p.connected).length;

  let html = `
    <div class="waiting-head">
      <div class="big">게임 대기 중</div>
      <div class="desc">${room.isPublic ? '공개방' : '비공개방'} · 친구에게 방 코드 <b style="color:var(--accent)">${room.code}</b>를 공유하세요</div>
    </div>
    <div class="settings-view">
      <div class="sv-item"><span class="sv-label">모드</span>${MODE_LABELS[s.mode]}</div>
      <div class="sv-item"><span class="sv-label">라운드</span>${s.rounds}라운드</div>
      <div class="sv-item"><span class="sv-label">발언/토론 시간</span>${s.describeTime}초 / ${s.discussTime}초</div>
      <div class="sv-item"><span class="sv-label">카테고리</span>${s.categories.map(escapeHtml).join(', ')}</div>
    </div>`;

  if (isHost) {
    html += `
      <div class="host-actions">
        <button id="start-btn" class="btn primary block">🚀 게임 시작 (${connectedCount}명 접속 중)</button>
        <button id="edit-settings-btn" class="btn ghost small">⚙️ 게임 설정 변경</button>
        <div id="settings-editor" class="settings-form-wrap hidden"></div>
      </div>`;
  } else {
    html += `<div class="big-msg">방장이 게임을 시작할 때까지 기다려주세요 ⏳</div>`;
  }
  area.innerHTML = html;

  if (isHost) {
    $('#start-btn').addEventListener('click', () => {
      App.socket.emit('game:start', null, (res) => {
        if (res && !res.ok) showToast(res.error || '시작할 수 없습니다.');
      });
    });
    $('#edit-settings-btn').addEventListener('click', () => {
      const wrap = $('#settings-editor');
      if (!wrap.classList.contains('hidden')) { wrap.classList.add('hidden'); return; }
      wrap.classList.remove('hidden');
      wrap.innerHTML = settingsFieldsHtml(room.settings, 'edit') +
        '<button id="save-settings-btn" class="btn ok block">설정 저장</button>';
      $('#save-settings-btn').addEventListener('click', () => {
        const settings = readSettingsFields('edit');
        if (settings.categories.length === 0) return showToast('카테고리를 1개 이상 선택해주세요.');
        App.socket.emit('room:settings', { settings }, (res) => {
          if (res && res.ok) showToast('설정이 저장되었습니다.', true);
          else showToast((res && res.error) || '설정 변경에 실패했습니다.');
        });
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

  let html = `
    <div class="phase-banner">
      <div>
        <div class="phase-title">${PHASE_TITLES[game.phase] || ''}</div>
        <div class="round-info">라운드 ${game.round}/${game.totalRounds} · ${MODE_LABELS[game.mode]} · 카테고리: ${escapeHtml(game.category || '')}</div>
      </div>
      <div id="phase-timer" class="timer"></div>
    </div>`;

  // 내 역할 카드 (최종 결과 화면 제외)
  if (App.myRole && game.phase !== 'final') {
    html += roleCardHtml(App.myRole);
  }

  switch (game.phase) {
    case 'role':
      html += `<div class="big-msg">역할과 제시어를 확인하세요. 곧 설명 단계가 시작됩니다!</div>`;
      break;
    case 'describe':
      html += orderStripHtml(game) + describeListHtml(game);
      break;
    case 'discuss':
      html += describeListHtml(game) +
        `<div class="big-msg">채팅으로 자유롭게 토론하세요. 누가 <span class="em">라이어</span>일까요?</div>`;
      if (isHost) {
        html += `<button id="skip-discuss-btn" class="btn primary block">🗳️ 토론 끝내고 바로 투표하기</button>`;
      }
      break;
    case 'vote':
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

function roleCardHtml(role) {
  let body;
  if (role.role === 'liar') {
    body = `당신은 <span class="liar-word">라이어</span>입니다! 제시어를 모르는 척하지 말고, 아는 척 설명하세요.`;
  } else if (role.role === 'spy') {
    body = `당신은 <span class="liar-word">스파이</span>입니다. 제시어는 <span class="word">${escapeHtml(role.word)}</span>, 라이어는 <b>${escapeHtml(role.liarName)}</b>님입니다. 몰래 라이어를 도우세요!`;
  } else {
    body = `당신은 <b>시민</b>입니다. 제시어: <span class="word">${escapeHtml(role.word)}</span>`;
  }
  return `
    <div class="role-card ${App.roleHidden ? 'blurred' : ''}" id="role-card">
      <div class="role-head">
        <span class="role-label">🃏 내 역할 · 카테고리: ${escapeHtml(role.category)}</span>
        <button id="role-toggle" class="btn ghost small">${App.roleHidden ? '보기' : '가리기'}</button>
      </div>
      <div class="role-body">${body}</div>
    </div>`;
}

function orderStripHtml(game) {
  let html = '<div class="order-strip">';
  game.order.forEach((id, i) => {
    const cls = i < game.turnIndex ? 'done' : i === game.turnIndex ? 'current' : '';
    html += `<span class="order-chip ${cls}">${i + 1}. ${escapeHtml(playerName(id))}</span>`;
  });
  return html + '</div>';
}

function describeListHtml(game) {
  if (!game.describes.length) return '';
  let html = '<div class="describe-list">';
  for (const d of game.describes) {
    html += `<div class="describe-item"><span class="dname">${escapeHtml(d.nickname)}</span>${
      d.skipped ? '<span class="skipped">(시간 초과)</span>' : escapeHtml(d.text)
    }</div>`;
  }
  return html + '</div>';
}

function voteHtml(game, me) {
  const candidates = game.tieCandidates || game.order;
  const iCanVote = game.order.includes(me);
  let html = '';
  if (game.tieCandidates) {
    html += `<div class="big-msg">⚠️ 동표! <span class="em">재투표</span>입니다. 후보 중에서 선택하세요.</div>`;
  }
  html += '<div class="vote-grid">';
  for (const id of candidates) {
    const selected = App.myVote === id;
    const disabled = !iCanVote || id === me;
    html += `<button class="vote-btn ${selected ? 'selected' : ''}" data-vote="${id}" ${disabled ? 'disabled' : ''}>
      ${escapeHtml(playerName(id))}${id === me ? ' (나)' : ''}</button>`;
  }
  html += '</div>';
  const voterCount = game.order.filter((id) => {
    const p = App.room.players.find((q) => q.id === id);
    return p && p.connected;
  }).length;
  html += `<div class="big-msg">${game.votedIds.length}/${voterCount}명 투표 완료</div>`;
  return html;
}

function guessHtml(game, me) {
  if (game.accusedId === me) {
    return `
      <div class="big-msg">당신이 라이어로 지목되었습니다!<br>제시어를 맞히면 <span class="em">역전승</span>합니다.</div>
      <div class="guess-box">
        <input id="guess-input" type="text" maxlength="30" placeholder="제시어를 입력하세요" autocomplete="off">
        <button id="guess-btn" class="btn primary">제출</button>
      </div>`;
  }
  return `<div class="big-msg"><span class="em">${escapeHtml(game.accusedName)}</span>님이 라이어로 지목되었습니다!<br>라이어가 제시어를 추리하는 중... 🤔</div>`;
}

function judgeHtml(game, me) {
  if (game.judgeId === me && App.judgePrompt) {
    return `
      <div class="judge-box">
        <div class="pair">라이어의 답: <b>${escapeHtml(App.judgePrompt.guess)}</b> / 정답: <b>${escapeHtml(App.judgePrompt.word)}</b></div>
        <div style="color:var(--muted);font-size:13px;margin-bottom:12px">사실상 같은 답이면 정답으로 인정해주세요.</div>
        <div class="judge-actions">
          <button id="judge-ok" class="btn ok">⭕ 정답 인정</button>
          <button id="judge-no" class="btn danger">❌ 오답</button>
        </div>
      </div>`;
  }
  return `<div class="big-msg">라이어의 답: <span class="em">${escapeHtml(game.guessText || '')}</span><br>${escapeHtml(playerName(game.judgeId))}님이 정답 여부를 판정하는 중... ⚖️</div>`;
}

function resultHtml(game, isHost) {
  const r = game.result;
  if (!r) return '';
  let outcomeCls = 'voided';
  let outcomeText = '라운드 무효';
  if (!r.voided) {
    const liarWin = r.outcome === 'liarSurvived' || r.outcome === 'liarGuessed';
    outcomeCls = liarWin ? 'liar-win' : 'citizen-win';
    outcomeText = {
      liarSurvived: '😈 라이어 승리! (정체를 숨겼습니다)',
      liarGuessed: '😈 라이어 역전승! (제시어를 맞혔습니다)',
      liarCaught: '🎉 시민 승리! (라이어를 잡았습니다)',
      spyCaught: '🎉 시민 승리! (스파이를 잡았습니다)',
    }[r.outcome] || '';
  }
  let html = `
    <div class="result-card">
      <div class="outcome ${outcomeCls}">${outcomeText}</div>
      ${r.voided ? `<div class="reveal">${escapeHtml(r.reason || '')}</div>` : ''}
      <div class="reveal">제시어: <b>${escapeHtml(r.word)}</b> (${escapeHtml(r.category)})</div>
      <div class="reveal">라이어: <b>${escapeHtml(r.liarName)}</b>${r.fakeWord ? ` — 바보 모드 제시어: <b>${escapeHtml(r.fakeWord)}</b>` : ''}</div>
      ${r.spyName ? `<div class="reveal">스파이: <b>${escapeHtml(r.spyName)}</b></div>` : ''}
      ${r.guessText ? `<div class="reveal">라이어의 추리: <b>${escapeHtml(r.guessText)}</b></div>` : ''}
      ${deltaTableHtml(r.deltas)}
      ${voteDetailHtml(r.votes)}
    </div>`;
  html += isHost
    ? `<button id="next-btn" class="btn primary block">${game.round >= game.totalRounds ? '🏆 최종 결과 보기' : '▶️ 다음 라운드'}</button>`
    : `<div class="big-msg">방장이 진행할 때까지 기다려주세요...</div>`;
  return html;
}

function deltaTableHtml(deltas) {
  const entries = Object.entries(deltas || {});
  if (!entries.length) return '';
  let html = '<table class="delta-table">';
  for (const [id, d] of entries.sort((a, b) => b[1] - a[1])) {
    html += `<tr><td>${escapeHtml(playerName(id))}</td><td class="plus">+${d}점</td></tr>`;
  }
  return html + '</table>';
}

function voteDetailHtml(votes) {
  const entries = Object.entries(votes || {});
  if (!entries.length) return '';
  const parts = entries.map(([v, t]) => `${escapeHtml(playerName(v))} → ${escapeHtml(playerName(t))}`);
  return `<div class="vote-detail">투표: ${parts.join(' · ')}</div>`;
}

function finalHtml(room, isHost) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  let html = '<div class="rank-list">';
  sorted.forEach((p, i) => {
    html += `
      <div class="rank-item">
        <span class="medal">${medals[i] || (i + 1) + '위'}</span>
        <span class="rname">${escapeHtml(p.nickname)}${p.id === App.me.playerId ? ' (나)' : ''}</span>
        <span class="rscore">${p.score}점</span>
      </div>`;
  });
  html += '</div>';
  html += isHost
    ? '<button id="next-btn" class="btn primary block">🏠 대기실로 돌아가기</button>'
    : '<div class="big-msg">수고하셨습니다! 방장이 대기실로 이동할 때까지 기다려주세요.</div>';
  return html;
}

// ---------- 이벤트 바인딩 ----------

function bindGameEvents(game, me, isHost) {
  const roleToggle = $('#role-toggle');
  if (roleToggle) {
    roleToggle.addEventListener('click', () => {
      App.roleHidden = !App.roleHidden;
      $('#role-card').classList.toggle('blurred', App.roleHidden);
      roleToggle.textContent = App.roleHidden ? '보기' : '가리기';
    });
  }

  document.querySelectorAll('[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.vote;
      App.socket.emit('game:vote', { targetId }, (res) => {
        if (res && res.ok) App.myVote = targetId;
        else if (res && res.error) showToast(res.error);
      });
    });
  });

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

  const skipBtn = $('#skip-discuss-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      App.socket.emit('game:skipDiscuss', null, (res) => {
        if (res && !res.ok && res.error) showToast(res.error);
      });
    });
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
