// 联机集成测试：启动真实服务器，用多个 socket.io 客户端模拟玩家
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createPokerServer } = require('../src/server');

let srv, url;
const clients = [];

test.before(async () => {
  srv = createPokerServer({
    turnSeconds: 1.5,
    disconnectedTurnSeconds: 0.4,
    sittingOutTurnSeconds: 0.2,
    nextHandSeconds: 0.6,
    lobbyDisconnectSeconds: 0.5,
    gameDisconnectSeconds: 2
  });
  await new Promise(r => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  srv.io.close();
  for (const room of srv.rooms.values()) {
    clearTimeout(room.timers.turn);
    clearTimeout(room.timers.nextHand);
    clearTimeout(room.timers.empty);
    room.timers.away.forEach(clearTimeout);
  }
  await new Promise(r => srv.server.close(r));
});

function client() {
  const s = connect(url, { reconnection: false, forceNew: true, transports: ['websocket'] });
  s.state = null;
  s.on('gameState', st => { s.state = st; });
  s.call = (ev, data) => new Promise(r => s.emit(ev, data, r));
  clients.push(s);
  return new Promise(r => s.on('connect', () => r(s)));
}

// 等待某个客户端的状态满足条件
function until(s, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (s.state && pred(s.state)) return resolve(s.state);
    const timer = setTimeout(() => reject(new Error('等待状态超时: ' + JSON.stringify(s.state && {
      phase: s.state.phase, cur: s.state.currentPlayerIndex, hand: s.state.handNumber
    }))), ms);
    const on = st => {
      if (pred(st)) { clearTimeout(timer); s.off('gameState', on); resolve(st); }
    };
    s.on('gameState', on);
  });
}

async function setupRoom(names) {
  const socks = [];
  for (const n of names) socks.push(await client());
  const created = await socks[0].call('createRoom', { name: names[0] });
  assert.ok(created.success);
  socks[0].token = created.token;
  for (let i = 1; i < socks.length; i++) {
    const res = await socks[i].call('joinRoom', { roomId: created.roomId.toLowerCase(), name: names[i] });
    assert.ok(res.success, res.error);
    socks[i].token = res.token;
  }
  await until(socks[0], s => s.players.length === names.length);
  return { socks, roomId: created.roomId };
}

const turnOf = (socks, st) => socks.find(s => s.state && s.state.myIndex === st.currentPlayerIndex);

test('两人局：一人弃牌后立即结算，随后自动开下一局', async () => {
  const { socks } = await setupRoom(['A', 'B']);
  assert.equal((await socks[1].call('startGame')).success, false, '非房主不能开局');
  assert.ok((await socks[0].call('startGame')).success);
  const st = await until(socks[0], s => s.phase === 'preflop');
  assert.equal(st.players[1].hand[0], null, '看不到对手手牌');
  assert.ok(st.players[0].hand[0]);
  assert.ok(!JSON.stringify(st).includes(socks[0].token), '状态中不含令牌');

  const other = socks.find(s => s !== turnOf(socks, st));
  assert.equal((await other.call('playerAction', { action: 'call' })).success, false, '没轮到不能行动');

  assert.ok((await turnOf(socks, st).call('playerAction', { action: 'fold' })).success);
  const end = await until(socks[0], s => s.phase === 'showdown');
  assert.ok(end.result.uncontested);
  assert.equal(end.players[0].chips + end.players[1].chips, 4000);

  const next = await until(socks[0], s => s.handNumber === 2 && s.phase === 'preflop');
  assert.equal(next.dealerIndex, 1, '庄家轮换');
});

test('牌局中不能提前开下一局', async () => {
  const { socks } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('startGame');
  await until(socks[1], s => s.phase === 'preflop');
  const res = await socks[0].call('nextHand');
  assert.equal(res.success, false);
  assert.equal(socks[1].state.handNumber, 1);
});

test('刷新页面后凭令牌回到原座位，手牌不变', async () => {
  const { socks, roomId } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('startGame');
  const before = await until(socks[2], s => s.phase === 'preflop');
  const myHand = before.players[before.myIndex].hand;

  socks[2].close();
  await until(socks[0], s => !s.players[2].connected);

  const fresh = await client();
  assert.equal((await fresh.call('resume', { roomId, token: 'wrong' })).success, false);
  const res = await fresh.call('resume', { roomId, token: socks[2].token });
  assert.ok(res.success, res.error);
  const after = await until(fresh, s => s.players[2].connected);
  assert.equal(after.myIndex, 2);
  assert.deepEqual(after.players[2].hand, myHand);
});

test('轮到掉线玩家时超时自动弃牌，牌局不会卡住', async () => {
  const { socks } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('startGame');
  // 庄 A，小盲 B，大盲 C，A 先行动
  const st = await until(socks[0], s => s.phase === 'preflop' && s.currentPlayerIndex === 0);
  assert.ok(st.turnDeadline > st.serverNow);
  socks[2].close();              // C 掉线（不是 C 的回合）
  await socks[0].call('playerAction', { action: 'call' });
  await socks[1].call('playerAction', { action: 'call' });
  // 轮到 C（大盲，可以过牌）：掉线后 0.4 秒内自动过牌并转为暂离
  const flop = await until(socks[0], s => s.phase === 'flop', 3000);
  assert.equal(flop.players[2].folded, false);
  assert.equal(flop.players[2].sittingOut, true);
  // 在线的人及时行动把这局打完；下一局不再给掉线的 C 发牌
  socks[0].on('gameState', st => {
    if (st.handNumber === 1 && st.currentPlayerIndex === st.myIndex) {
      socks[0].emit('playerAction', { action: st.legal.canCheck ? 'check' : 'call' });
    }
  });
  socks[1].on('gameState', st => {
    if (st.handNumber === 1 && st.currentPlayerIndex === st.myIndex) {
      socks[1].emit('playerAction', { action: st.legal.canCheck ? 'check' : 'call' });
    }
  });
  const next = await until(socks[0], s => s.handNumber === 2 && s.phase === 'preflop', 8000);
  assert.equal(next.players[2].inHand, false);
});

test('在线玩家行动超时自动过牌或弃牌', async () => {
  const { socks } = await setupRoom(['A', 'B']);
  await socks[0].call('startGame');
  await until(socks[0], s => s.phase === 'preflop');
  const end = await until(socks[0], s => s.phase === 'showdown', 4000);
  assert.ok(end.result.uncontested);
});

test('游戏进行中可以加入，下一局参与', async () => {
  const { socks, roomId } = await setupRoom(['A', 'B']);
  await socks[0].call('startGame');
  await until(socks[0], s => s.phase === 'preflop');
  const late = await client();
  const res = await late.call('joinRoom', { roomId, name: 'Late' });
  assert.ok(res.success, res.error);
  const st = await until(late, s => s.players.length === 3);
  assert.equal(st.players[2].inHand, false);
  assert.equal(st.players[2].hand.length, 0);
  await turnOf(socks, socks[0].state).call('playerAction', { action: 'fold' });
  const next = await until(late, s => s.handNumber === 2);
  assert.equal(next.players[2].inHand, true);
  assert.equal(next.players[2].hand.length, 2);
});

test('非法加注被拒绝', async () => {
  const { socks } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('startGame');
  const st = await until(socks[0], s => s.phase === 'preflop');
  const me = turnOf(socks, st);
  assert.equal((await me.call('playerAction', { action: 'check' })).success, false);
  assert.equal((await me.call('playerAction', { action: 'raise', amount: 50 })).success, false);
  assert.equal((await me.call('playerAction', { action: 'raise', amount: 'abc' })).success, false);
  assert.equal((await me.call('playerAction', { action: 'hack' })).success, false);
  assert.ok((await me.call('playerAction', { action: 'raise', amount: 200 })).success);
});

test('等待阶段离开或掉线会被移出房间，房主转移', async () => {
  const { socks, roomId } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('leaveRoom');
  const st = await until(socks[1], s => s.players.length === 2);
  assert.equal(st.hostId, st.players[0].id);
  assert.equal(st.players[0].name, 'B');
  socks[2].close();
  await until(socks[1], s => s.players.length === 1, 3000);
  assert.equal((await (await client()).call('resume', { roomId, token: socks[2].token })).success, false);
});

test('游戏中掉线太久会被移出房间', async () => {
  const { socks } = await setupRoom(['A', 'B', 'C']);
  await socks[0].call('startGame');
  await until(socks[0], s => s.phase === 'preflop');
  socks[2].close();
  const st = await until(socks[0], s => s.players.length === 2, 8000);
  assert.deepEqual(st.players.map(p => p.name), ['A', 'B']);
});

test('牌局中所有人离开后房间被删除', async () => {
  const { socks, roomId } = await setupRoom(['A', 'B']);
  await socks[0].call('startGame');
  await until(socks[0], s => s.phase === 'preflop');
  await socks[0].call('leaveRoom');
  await socks[1].call('leaveRoom');
  assert.equal(srv.rooms.has(roomId), false);
});
