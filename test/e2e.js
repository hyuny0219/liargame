'use strict';

/**
 * E2E 테스트: 봇 3명이 방을 만들고 한 라운드 전체를 플레이한다.
 * 흐름: 접속코드 인증 → 방 생성/입장 → 시작 → 역할 수신 → 설명 → 토론 →
 *       투표(시민들이 라이어 지목) → 라이어 오답 추리 → 판정(오답) → 결과 → 최종 → 대기실 복귀
 */

const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3987;
const SITE_CODE = 'testcode';
const URL = `http://localhost:${PORT}`;

let failed = false;
function assert(cond, msg) {
  if (cond) {
    console.log('  ✅', msg);
  } else {
    failed = true;
    console.error('  ❌', msg);
  }
}

function waitForServer(retries = 50) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      http.get(`${URL}/healthz`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (n <= 0) return reject(new Error('server did not start'));
        setTimeout(() => tryOnce(n - 1), 200);
      });
    };
    tryOnce(retries);
  });
}

function emitP(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

async function main() {
  console.log('서버 시작...');
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), SITE_CODE },
    stdio: 'ignore',
  });
  process.on('exit', () => server.kill());
  await waitForServer();
  console.log('서버 준비 완료.\n');

  const bots = ['철수', '영희', '민수'].map((nickname) => ({
    nickname,
    socket: io(URL),
    playerId: null,
    role: null,
    described: false,
    voted: false,
    guessed: false,
    judged: false,
  }));
  const roles = {}; // playerId -> role
  let liarId = null;
  let nexted = { result: false, final: false };
  let phaseLog = [];

  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('테스트 타임아웃 (150초)')), 150000);

    for (const bot of bots) {
      bot.socket.on('game:role', (role) => {
        bot.role = role;
        roles[bot.playerId] = role;
        if (role.role === 'liar') liarId = bot.playerId;
      });

      bot.socket.on('game:judgePrompt', async (data) => {
        console.log(`  ⚖️ ${bot.nickname}이(가) 판정: "${data.guess}" vs 정답 "${data.word}"`);
        assert(data.word && data.guess === '완전틀린답', '판정자가 라이어의 답과 정답을 받음');
        if (!bot.judged) {
          bot.judged = true;
          await emitP(bot.socket, 'game:judge', { correct: false });
        }
      });

      bot.socket.on('room:state', async (state) => {
        try {
          if (!state.game) return;
          const g = state.game;
          if (!phaseLog.includes(g.phase)) {
            phaseLog.push(g.phase);
            console.log(`[단계] ${g.phase}`);
          }

          if (g.phase === 'describe') {
            const cur = g.order[g.turnIndex];
            if (cur === bot.playerId && !bot.described) {
              bot.described = true;
              const res = await emitP(bot.socket, 'chat', { text: `${bot.nickname}의 설명입니다` });
              assert(res.ok, `${bot.nickname} 설명 전송 성공`);
            }
          }

          if (g.phase === 'vote' && !bot.voted && liarId) {
            bot.voted = true;
            const target = bot.playerId === liarId
              ? g.order.find((id) => id !== bot.playerId)
              : liarId;
            const res = await emitP(bot.socket, 'game:vote', { targetId: target });
            assert(res.ok, `${bot.nickname} 투표 성공`);
          }

          if (g.phase === 'guess' && bot.playerId === liarId && !bot.guessed) {
            bot.guessed = true;
            assert(g.accusedId === liarId, '라이어가 정확히 지목됨');
            const res = await emitP(bot.socket, 'game:guess', { text: '완전틀린답' });
            assert(res.ok, '라이어 추리 제출 성공');
          }

          if (g.phase === 'result' && state.hostId === bot.playerId && !nexted.result) {
            nexted.result = true;
            const r = g.result;
            assert(r.outcome === 'liarCaught', `라운드 결과가 liarCaught (실제: ${r.outcome})`);
            assert(r.liarId === liarId, '결과에 라이어가 올바르게 표시됨');
            const citizens = state.players.filter((p) => p.id !== liarId);
            assert(citizens.every((p) => p.score === 2), `시민들이 +2점 획득 (${citizens.map((p) => p.score).join(',')})`);
            assert(state.players.find((p) => p.id === liarId).score === 0, '라이어는 0점');
            await emitP(bot.socket, 'game:next', null);
          }

          if (g.phase === 'final' && state.hostId === bot.playerId && !nexted.final) {
            nexted.final = true;
            console.log('[단계] final → 대기실 복귀');
            await emitP(bot.socket, 'game:next', null);
          }

          if (!state.game && state.state === 'waiting') {
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });

      // 게임 종료 후 대기실 상태
      bot.socket.on('room:state', (state) => {
        if (state.state === 'waiting' && phaseLog.includes('final')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
  });

  // 인증
  for (const bot of bots) {
    const res = await emitP(bot.socket, 'auth', { code: SITE_CODE, nickname: bot.nickname });
    assert(res.ok, `${bot.nickname} 인증 성공`);
    bot.playerId = res.playerId;
  }
  const bad = await emitP(bots[0].socket, 'auth', { code: '틀린코드', nickname: 'x' });
  assert(bad.ok === false, '잘못된 접속코드는 거부됨');

  // 미인증 소켓은 로비 목록도 볼 수 없어야 한다
  const anon = io(URL);
  const anonList = await emitP(anon, 'lobby:list', null);
  assert(anonList.ok === false, '미인증 소켓의 lobby:list는 거부됨');
  anon.close();

  // 방 생성(비공개) 및 입장
  const created = await emitP(bots[0].socket, 'room:create', {
    name: '테스트방',
    isPublic: false,
    settings: { mode: 'basic', rounds: 1, describeTime: 30, discussTime: 30, categories: ['음식'] },
  });
  assert(created.ok, '방 생성 성공');
  const code = created.room.code;
  assert(/^[A-Z0-9]{6}$/.test(code), `6자리 방 코드 발급 (${code})`);

  const lobbyList = await emitP(bots[1].socket, 'lobby:list', null);
  assert(lobbyList.rooms.every((r) => r.code !== code), '비공개방은 로비 목록에 노출되지 않음');

  for (const bot of bots.slice(1)) {
    const res = await emitP(bot.socket, 'room:join', { code });
    assert(res.ok, `${bot.nickname} 방 입장 성공`);
  }

  // 게임 시작
  const started = await emitP(bots[0].socket, 'game:start', null);
  assert(started.ok, '게임 시작 성공');

  await done;

  const liarBot = bots.find((b) => b.playerId === liarId);
  assert(!!liarBot, `라이어 배정됨 (${liarBot && liarBot.nickname})`);
  assert(bots.filter((b) => b.role && b.role.word).length === 2, '시민 2명만 제시어를 받음');
  assert(liarBot.role.word === null && liarBot.role.category === '음식', '라이어는 카테고리만 받음');
  assert(phaseLog.join('>').includes('describe') && phaseLog.includes('vote') && phaseLog.includes('result'),
    `전체 단계 진행됨 (${phaseLog.join(' → ')})`);

  for (const bot of bots) bot.socket.close();
  server.kill();

  console.log(failed ? '\n❌ 테스트 실패' : '\n🎉 모든 테스트 통과!');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('테스트 오류:', e);
  process.exit(1);
});
