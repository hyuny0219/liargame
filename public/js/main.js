'use strict';

// 전역 앱 상태
const App = {
  socket: null,
  me: { sessionId: null, playerId: null, nickname: null },
  room: null,        // 서버가 보내주는 방 전체 상태
  myRole: null,      // 개인 역할 정보 (서버에서 개별 전송)
  judgePrompt: null, // 판정자용 정보
  myVote: null,
  roleHidden: false,
  categories: [],    // /api/meta에서 로드
  authed: false,
};

const $ = (sel) => document.querySelector(sel);

function showToast(msg, info) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = info ? 'show info' : 'show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 2500);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showScreen(name) {
  for (const id of ['login', 'lobby', 'room']) {
    $('#screen-' + id).classList.toggle('hidden', id !== name);
  }
}

// ---------- 화면 전환 ----------

function enterLobby() {
  App.room = null;
  App.myRole = null;
  App.judgePrompt = null;
  App.myVote = null;
  $('#lobby-nick').textContent = '👤 ' + App.me.nickname;
  showScreen('lobby');
  renderRoomList(App._lastRooms || []);
  renderMyStats();
  App.socket.emit('lobby:list', null, (res) => {
    if (res && res.ok) {
      App._lastRooms = res.rooms;
      renderRoomList(res.rooms);
      if (res.stats) {
        App.stats = res.stats;
        renderMyStats();
      }
    }
  });
}

function renderMyStats() {
  const el = $('#my-stats');
  if (!el) return;
  const s = App.stats;
  if (!s || !s.rounds) {
    el.textContent = '아직 플레이 기록이 없습니다. 첫 게임을 시작해보세요!';
    return;
  }
  const rate = Math.round((s.wins / s.rounds) * 100);
  const liar = s.liarRounds
    ? ` · 라이어 ${s.liarRounds}회 중 <b>${s.liarWins}승</b>`
    : '';
  el.innerHTML = `${s.rounds}라운드 <b>${s.wins}승</b> (승률 ${rate}%)${liar}
    <br><span style="font-size:11px">서버가 재시작되면 초기화됩니다</span>`;
}

// 서버-클라이언트 시계 오차 보정 (상태 수신 시점에만 계산)
function syncClock(state) {
  if (state && state.serverNow) App._clockOffset = state.serverNow - Date.now();
}

function enterRoom(roomState, chatHistory) {
  App.room = roomState;
  syncClock(roomState);
  $('#chat-log').innerHTML = '';
  (chatHistory || []).forEach(appendChat); // 서버가 보관한 최근 대화 복원
  showScreen('room');
  renderRoom();
}

// ---------- 채팅 ----------

function appendChat(msg) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  if (msg.kind === 'system') {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'chat-msg ' + (msg.kind === 'describe' ? 'describe' : '');
    if (msg.playerId === App.me.playerId) div.classList.add('mine');
    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = (msg.kind === 'describe' ? '💬 ' : '') + msg.nickname;
    const body = document.createElement('span');
    body.textContent = msg.text;
    div.appendChild(name);
    div.appendChild(body);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// 내 설명 차례가 되면 화면 전체에 알림 효과 + 진동
function maybeTurnAlert() {
  const game = App.room && App.room.game;
  if (!game || game.phase !== 'describe') return;
  if (game.order[game.turnIndex] !== App.me.playerId) return;
  const key = game.round + '-' + game.turnIndex;
  if (App._lastTurnKey === key) return; // 같은 차례에 중복 알림 방지
  App._lastTurnKey = key;

  const el = $('#turn-alert');
  el.classList.remove('hidden');
  void el.offsetWidth; // 애니메이션 재시작
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2600);

  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  Sound.play('turn');
  const input = $('#chat-input');
  if (input && !input.disabled) input.focus();
}

// 게임 단계에 따라 채팅 입력 상태 갱신
function updateChatInput() {
  const input = $('#chat-input');
  const game = App.room && App.room.game;
  let disabled = false;
  let placeholder = '메시지 입력...';
  let myTurn = false;
  if (game && game.phase === 'describe') {
    const currentId = game.order[game.turnIndex];
    if (currentId === App.me.playerId) {
      placeholder = '제시어를 한 문장으로 설명하세요!';
      myTurn = true;
    } else {
      disabled = true;
      const cur = App.room.players.find((p) => p.id === currentId);
      placeholder = (cur ? cur.nickname : game.names[currentId] || '?') + '님의 설명 차례입니다...';
    }
  } else if (game && (game.phase === 'guess' || game.phase === 'judge')) {
    disabled = true;
    placeholder = game.accusedId === App.me.playerId
      ? '제시어 입력창을 이용하세요'
      : '라이어가 추리하는 동안에는 채팅할 수 없습니다';
  }
  input.disabled = disabled;
  input.placeholder = placeholder;
  input.classList.toggle('my-turn', myTurn);
  maybeTurnAlert();
}

// ---------- 타이머 ----------

setInterval(() => {
  const game = App.room && App.room.game;
  const el = $('#phase-timer');
  if (!el) return;
  if (!game || !game.phaseEndsAt) { el.textContent = ''; return; }
  const now = Date.now() + (App._clockOffset || 0);
  const remain = Math.max(0, Math.ceil((game.phaseEndsAt - now) / 1000));
  el.textContent = remain + '초';
  el.classList.toggle('low', remain <= 10);
}, 250);

// ---------- 효과음 (WebAudio 합성음, 외부 파일 없음) ----------

const Sound = {
  muted: localStorage.getItem('liar_muted') === '1',
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, delay, dur, vol) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol || 0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  },
  play(name) {
    if (this.muted) return;
    this.ensure();
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (name === 'turn') { this.tone(880, 0, 0.15); this.tone(1174.66, 0.18, 0.3); }
    else if (name === 'vote') { this.tone(659.25, 0, 0.12); this.tone(659.25, 0.16, 0.12); }
    else if (name === 'result') { this.tone(523.25, 0, 0.14); this.tone(659.25, 0.13, 0.14); this.tone(783.99, 0.26, 0.32); }
  },
  toggle() {
    this.muted = !this.muted;
    localStorage.setItem('liar_muted', this.muted ? '1' : '0');
    return this.muted;
  },
};

// ---------- 모바일 가상 키보드 대응 ----------
// 키보드가 올라와도 포커스된 입력창이 가려지지 않게 화면을 조정한다

function setupMobileKeyboard() {
  const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

  document.addEventListener('focusin', (e) => {
    if (!isNarrow()) return;
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
      // 키보드 애니메이션이 끝난 뒤 입력창을 화면 중앙으로
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    }
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!isNarrow()) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
        el.scrollIntoView({ block: 'center' });
      }
      const log = $('#chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    });
  }
}

// ---------- 소켓 ----------

function doAuth(payload, cb) {
  App.socket.emit('auth', payload, (res) => {
    if (res && res.ok) {
      App.authed = true;
      App.me = { sessionId: res.sessionId, playerId: res.playerId, nickname: res.nickname };
      if (res.stats) App.stats = res.stats;
      localStorage.setItem('liar_session', res.sessionId);
      localStorage.setItem('liar_nick', res.nickname);
      if (res.room) {
        App._pendingRoom = null; // 이미 방에 있으면 초대 링크 무시
        enterRoom(res.room, res.chatHistory);
      } else {
        enterLobby();
        if (App._pendingRoom) {
          const code = App._pendingRoom;
          App._pendingRoom = null;
          joinRoom(code); // 초대 링크로 들어온 경우 자동 입장
        }
      }
    }
    if (cb) cb(res);
  });
}

function initSocket() {
  App.socket = io();

  App.socket.on('connect', () => {
    // 재연결 시 자동 재인증
    if (App.authed && App.me.sessionId) {
      doAuth({ sessionId: App.me.sessionId }, (res) => {
        if (!res || !res.ok) {
          App.authed = false;
          showScreen('login');
        }
      });
    }
  });

  App.socket.on('room:state', (state) => {
    if (!App.room) return;
    const prevPhase = App.room.game ? App.room.game.phase : null;
    App.room = state;
    syncClock(state);
    const phase = state.game ? state.game.phase : null;
    if (phase !== prevPhase) {
      App.myVote = null; // 단계가 바뀌면 투표 선택 초기화 (재투표 대비)
      if (phase === 'role') { App.judgePrompt = null; App._lastTurnKey = null; }
      if (!phase) { App.myRole = null; App.judgePrompt = null; App._lastTurnKey = null; }
    }
    // 서버 투표 목록에 내가 없으면 선택 표시 초기화 (재투표 시작 시 votes가 비워짐)
    const g = state.game;
    if (g && g.phase === 'vote' && App.myVote && !g.votedIds.includes(App.me.playerId)) {
      App.myVote = null;
    }
    if (phase !== prevPhase) {
      if (phase === 'vote') Sound.play('vote');
      else if (phase === 'result') Sound.play('result');
    }
    renderRoom();
  });

  App.socket.on('game:role', (role) => {
    App.myRole = role;
    App.roleHidden = false;
    renderRoom();
  });

  App.socket.on('game:judgePrompt', (data) => {
    App.judgePrompt = data;
    renderRoom();
  });

  App.socket.on('chat', appendChat);

  App.socket.on('lobby:rooms', (rooms) => {
    if (!$('#screen-lobby').classList.contains('hidden')) renderRoomList(rooms);
    App._lastRooms = rooms;
  });

  App.socket.on('room:closed', () => {
    showToast('방이 닫혔습니다.', true);
    App.socket.emit('lobby:list', null, (res) => {
      if (res && res.ok) App._lastRooms = res.rooms;
      enterLobby();
      renderRoomList(App._lastRooms || []);
    });
  });

  App.socket.on('room:kicked', () => {
    showToast('방장에 의해 방에서 강퇴되었습니다.');
    enterLobby();
  });

  App.socket.on('session:takeover', () => {
    App.authed = false;
    showToast('다른 탭/기기에서 접속하여 연결이 종료되었습니다.');
  });

  App.socket.on('disconnect', () => {
    if (App.authed) showToast('서버와 연결이 끊겼습니다. 재연결 중...', true);
  });
}

// ---------- 로그인 ----------

function setupLogin() {
  const tryLogin = () => {
    const code = $('#login-code').value.trim();
    const nickname = $('#login-nick').value.trim();
    $('#login-error').textContent = '';
    doAuth({ code, nickname }, (res) => {
      if (!res || !res.ok) $('#login-error').textContent = (res && res.error) || '접속에 실패했습니다.';
    });
  };
  $('#login-btn').addEventListener('click', tryLogin);
  $('#login-nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
  $('#login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-nick').focus(); });

  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem('liar_session');
    location.reload();
  });
}

// ---------- 방 공통 ----------

function setupRoomControls() {
  const muteBtn = $('#mute-btn');
  muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = Sound.toggle() ? '🔇' : '🔊';
  });
  // 첫 사용자 조작 시 오디오 컨텍스트 활성화 (브라우저 자동재생 정책 대응)
  document.addEventListener('click', () => Sound.ensure(), { once: true });

  $('#leave-btn').addEventListener('click', () => {
    if (App.room && App.room.state === 'playing' && !confirm('게임이 진행 중입니다. 정말 나가시겠습니까?')) return;
    App.socket.emit('room:leave', null, () => enterLobby());
  });

  $('#room-code-chip').addEventListener('click', () => {
    if (!App.room) return;
    const code = App.room.code;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => showToast('방 코드가 복사되었습니다: ' + code, true));
    } else {
      showToast('방 코드: ' + code, true);
    }
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    App.socket.emit('chat', { text }, (res) => {
      if (res && res.ok === false && res.error) showToast(res.error);
    });
    input.value = '';
  });
}

// ---------- 시작 ----------

window.addEventListener('DOMContentLoaded', async () => {
  // 초대 링크(?room=코드) 처리
  const invited = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(invited)) {
    App._pendingRoom = invited;
    history.replaceState(null, '', location.pathname); // 새로고침 시 재입장 시도 방지
    document.querySelector('#screen-login .sub').textContent =
      `초대받은 방(${invited})으로 바로 입장합니다`;
  }
  try {
    const meta = await fetch('/api/meta').then((r) => r.json());
    App.categories = meta.categories || [];
  } catch (e) {
    App.categories = [];
  }
  buildCreateFormFields();
  setupLogin();
  setupLobby();
  setupRoomControls();
  setupMobileKeyboard();
  initSocket();

  // 저장된 세션으로 자동 로그인 시도
  const saved = localStorage.getItem('liar_session');
  const savedNick = localStorage.getItem('liar_nick');
  if (saved) {
    doAuth({ sessionId: saved, nickname: savedNick || '' }, (res) => {
      if (!res || !res.ok) {
        localStorage.removeItem('liar_session');
        showScreen('login');
      }
    });
  } else {
    showScreen('login');
  }
  if (savedNick) $('#login-nick').value = savedNick;
});
