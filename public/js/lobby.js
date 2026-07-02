'use strict';

// 게임 설정 폼 필드(방 만들기/설정 변경 공용)
const MODE_LABELS = { basic: '기본', spy: '스파이', fool: '바보' };
const MODE_ICONS = { basic: '🎭', spy: '🕵️', fool: '🤪' };
const MODE_DESCS = {
  basic: '라이어만 제시어를 모릅니다',
  spy: '라이어를 돕는 스파이가 있습니다 (5인 이상)',
  fool: '라이어 본인도 자신이 라이어인지 모릅니다',
};
const STRIPE_COLORS = ['var(--coral)', 'var(--mint)', 'var(--yellow)', 'var(--blue)', 'var(--purple)'];

function settingsFieldsHtml(s, idPrefix) {
  const p = idPrefix;
  const st = s || { mode: 'basic', rounds: 3, describeTime: 60, discussTime: 90, maxPlayers: 8, categories: null, customWords: [] };
  const catChecks = App.categories.map((c) => `
    <label class="chk">
      <input type="checkbox" name="${p}-cat" value="${escapeHtml(c)}" ${!st.categories || st.categories.includes(c) ? 'checked' : ''}> ${escapeHtml(c)}
    </label>`).join('') + `
    <label class="chk">
      <input type="checkbox" name="${p}-cat" value="커스텀" ${st.categories && st.categories.includes('커스텀') ? 'checked' : ''}> ✏️ 커스텀
    </label>`;
  const opt = (v, cur, label) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
  const modeCards = ['basic', 'spy', 'fool'].map((m) => `
    <label class="mode-opt">
      <input type="radio" name="${p}-mode" value="${m}" ${st.mode === m ? 'checked' : ''}>
      <span><span class="mi">${MODE_ICONS[m]}</span>${MODE_LABELS[m]}</span>
    </label>`).join('');
  return `
    <label>게임 모드</label>
    <div class="mode-row">${modeCards}</div>
    <div class="mode-desc" id="${p}-mode-desc">${MODE_DESCS[st.mode]}</div>
    <details class="advanced">
      <summary>⚙️ 고급 설정 <span style="font-weight:700;font-size:12px">라운드·시간·인원·카테고리</span></summary>
      <div class="field-2col">
        <div>
          <label>라운드 수</label>
          <select id="${p}-rounds">${[1,2,3,4,5,6,7,8,9,10].map((n) => opt(n, st.rounds, n + '라운드')).join('')}</select>
        </div>
        <div>
          <label>최대 인원</label>
          <select id="${p}-max">${[3,4,5,6,7,8,9,10].map((n) => opt(n, st.maxPlayers, n + '명')).join('')}</select>
        </div>
      </div>
      <div class="field-2col">
        <div>
          <label>발언 시간</label>
          <select id="${p}-desctime">${[30,60,90].map((n) => opt(n, st.describeTime, n + '초')).join('')}</select>
        </div>
        <div>
          <label>토론 시간</label>
          <select id="${p}-disctime">${[30,60,90,120].map((n) => opt(n, st.discussTime, n + '초')).join('')}</select>
        </div>
      </div>
      <label>주제 카테고리</label>
      <div class="check-grid">${catChecks}</div>
      <label>✏️ 커스텀 제시어 — 쉼표/줄바꿈 구분, 5개 이상</label>
      <textarea id="${p}-custom" rows="2" placeholder="예: 김치, 만두, 라면, 떡국, 잡채">${escapeHtml(((s && s.customWords) || []).join(', '))}</textarea>
    </details>
    <div class="hint-note">기본 설정 그대로도 바로 시작할 수 있어요!</div>`;
}

function bindModeDesc(idPrefix) {
  document.querySelectorAll(`input[name="${idPrefix}-mode"]`).forEach((el) => {
    el.addEventListener('change', () => {
      const desc = $(`#${idPrefix}-mode-desc`);
      if (desc) desc.textContent = MODE_DESCS[el.value] || '';
    });
  });
}

function readSettingsFields(idPrefix) {
  const p = idPrefix;
  const modeEl = document.querySelector(`input[name="${p}-mode"]:checked`);
  return {
    mode: modeEl ? modeEl.value : 'basic',
    rounds: Number($(`#${p}-rounds`).value),
    maxPlayers: Number($(`#${p}-max`).value),
    describeTime: Number($(`#${p}-desctime`).value),
    discussTime: Number($(`#${p}-disctime`).value),
    categories: [...document.querySelectorAll(`input[name="${p}-cat"]:checked`)].map((el) => el.value),
    // 서버 sanitize와 동일한 규칙(공백 정리·20자 절단·중복 제거)으로 정규화해 검증 불일치 방지
    customWords: [...new Set(
      $(`#${p}-custom`).value.split(/[,\n]/).map((w) => w.trim().slice(0, 20)).filter(Boolean)
    )].slice(0, 100),
  };
}

// 카테고리/커스텀 제시어 조합 검증 (방 만들기·설정 변경 공용)
function validateSettings(settings) {
  if (settings.categories.length === 0) return '카테고리를 1개 이상 선택해주세요.';
  if (settings.categories.includes('커스텀') && settings.customWords.length < 5) {
    return '커스텀 카테고리를 사용하려면 제시어를 5개 이상 입력해주세요.';
  }
  return null;
}

function buildCreateFormFields() {
  document.querySelector('#create-form .settings-fields').innerHTML = settingsFieldsHtml(null, 'create');
  bindModeDesc('create');
}

// ---------- 로비 탭 (모바일) ----------

function switchLobbyTab(target) {
  document.querySelectorAll('.lobby-section').forEach((s) => s.classList.toggle('active', s.id === target));
  document.querySelectorAll('#lobby-tabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === target));
}

// ---------- 공개방 목록 ----------

function renderRoomList(rooms) {
  const list = $('#room-list');
  if (!list) return;
  if (!rooms || rooms.length === 0) {
    list.innerHTML = '<div class="empty-note">아직 열려있는 파티가 없어요.<br>첫 파티를 열어보세요! 🎉</div>';
    return;
  }
  list.innerHTML = '';
  rooms.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.style.setProperty('--stripe', STRIPE_COLORS[i % STRIPE_COLORS.length]);
    const playing = r.state === 'playing';
    item.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">
          <span class="badge ${playing ? 'playing' : 'wait'}">${playing ? '게임 중' : '대기 중'}</span>
          <span class="badge">${MODE_ICONS[r.mode] || ''} ${MODE_LABELS[r.mode] || r.mode}</span>
          <span class="badge">${r.players}/${r.maxPlayers}</span>
        </div>
      </div>`;
    const btn = document.createElement('button');
    btn.className = 'btn3d small' + (playing ? ' blue' : '');
    btn.textContent = playing ? '관전' : '입장';
    btn.disabled = r.players >= r.maxPlayers;
    btn.addEventListener('click', () => joinRoom(r.code));
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function joinRoom(code) {
  App.socket.emit('room:join', { code }, (res) => {
    if (res && res.ok) enterRoom(res.room, res.chatHistory);
    else showToast((res && res.error) || '입장에 실패했습니다.');
  });
}

function setupLobby() {
  document.querySelectorAll('#lobby-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => switchLobbyTab(t.dataset.tab));
  });

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const settings = readSettingsFields('create');
    const err = validateSettings(settings);
    if (err) return showToast(err);
    const isPublic = document.querySelector('input[name="create-public"]:checked').value === '1';
    App.socket.emit('room:create', {
      name: $('#create-name').value.trim(),
      isPublic,
      settings,
    }, (res) => {
      if (res && res.ok) enterRoom(res.room, res.chatHistory);
      else showToast((res && res.error) || '방 생성에 실패했습니다.');
    });
  });

  $('#join-code-btn').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 6) return showToast('6자리 방 코드를 입력해주세요.');
    joinRoom(code);
  });
  $('#join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#join-code-btn').click(); }
  });
}
