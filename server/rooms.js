'use strict';

const { CATEGORIES, CUSTOM_CATEGORY } = require('./words');

const rooms = new Map(); // code -> room

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(I, L, O, 0, 1) 제외
const MODES = ['basic', 'spy', 'fool'];
const DESCRIBE_TIMES = [30, 60, 90];
const DISCUSS_TIMES = [30, 60, 90, 120];

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSettings(input, base) {
  const prev = base || {
    mode: 'basic',
    rounds: 3,
    describeTime: 60,
    discussTime: 90,
    maxPlayers: 8,
    categories: CATEGORIES.slice(),
    customWords: [],
  };
  const s = { ...prev };
  if (!input || typeof input !== 'object') return s;
  if (MODES.includes(input.mode)) s.mode = input.mode;
  s.rounds = clampInt(input.rounds, 1, 10, prev.rounds);
  if (DESCRIBE_TIMES.includes(Number(input.describeTime))) s.describeTime = Number(input.describeTime);
  if (DISCUSS_TIMES.includes(Number(input.discussTime))) s.discussTime = Number(input.discussTime);
  s.maxPlayers = clampInt(input.maxPlayers, 3, 10, prev.maxPlayers);
  if (Array.isArray(input.customWords)) {
    s.customWords = [...new Set(
      input.customWords.map((w) => String(w).trim().slice(0, 20)).filter(Boolean)
    )].slice(0, 100);
  }
  if (Array.isArray(input.categories)) {
    const cats = input.categories.filter((c) => CATEGORIES.includes(c) || c === CUSTOM_CATEGORY);
    if (cats.length) s.categories = cats;
  }
  // 커스텀 제시어가 5개 미만이면 커스텀 카테고리는 사용할 수 없다
  if (s.categories.includes(CUSTOM_CATEGORY) && s.customWords.length < 5) {
    s.categories = s.categories.filter((c) => c !== CUSTOM_CATEGORY);
    if (!s.categories.length) s.categories = CATEGORIES.slice();
  }
  return s;
}

function createRoom({ name, isPublic, settings, hostId }) {
  const room = {
    code: genCode(),
    name,
    isPublic: !!isPublic,
    hostId,
    state: 'waiting', // waiting | playing
    settings: sanitizeSettings(settings),
    players: new Map(), // playerId -> { id, nickname, connected, score, disconnectTimer }
    game: null,
    history: [], // 최근 채팅/시스템 메시지 (입장·재접속 시 복원용)
    banned: new Set(), // 강퇴된 playerId
    bannedNames: new Set(), // 강퇴된 닉네임 (재로그인 우회 방지)
    bannedIps: new Set(), // 강퇴된 IP (재로그인 우회 방지)
    emptyTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.game) room.game.destroy();
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  for (const p of room.players.values()) {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  }
  rooms.delete(code);
}

function publicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.isPublic) continue;
    list.push({
      code: room.code,
      name: room.name,
      state: room.state,
      mode: room.settings.mode,
      players: room.players.size,
      maxPlayers: room.settings.maxPlayers,
    });
  }
  return list.sort((a, b) => b.players - a.players);
}

// 오래 방치된 방 정리 (2시간)
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyConnected = [...room.players.values()].some((p) => p.connected);
    if (!anyConnected && now - room.createdAt > 2 * 60 * 60 * 1000) deleteRoom(room.code);
  }
}, 10 * 60 * 1000).unref();

module.exports = { rooms, createRoom, getRoom, deleteRoom, publicRoomList, sanitizeSettings };
