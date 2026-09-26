const test = require('node:test');
const assert = require('node:assert/strict');
const { Table } = require('../src/game/table');

const c = s => s.split(' ').map(x => ({ rank: x.slice(0, -1), suit: x.slice(-1) }));

function makeTable(names, { chips, bigBlind = 100 } = {}) {
  const t = new Table({ id: 'T', bigBlind });
  names.forEach((n, i) => {
    const { player } = t.addPlayer({ id: n, name: n });
    if (chips) player.chips = chips[i];
  });
  return t;
}

// 指定手牌与公共牌（deck 从末尾 pop：烧、翻 3、烧、转、烧、河）
function rig(t, hands, board) {
  for (const [id, cards] of Object.entries(hands)) t.getPlayer(id).hand = c(cards);
  const b = c(board);
  const x = { rank: '2', suit: '♣' };
  t.deck = [b[4], x, b[3], x, b[2], b[1], b[0], x];
}

const cur = t => t.players[t.currentPlayerIndex].id;
const total = t => t.players.reduce((s, p) => s + p.chips, 0) + t.pot;
const ok = r => assert.ok(r.ok, r.error);

test('单挑：庄家下小盲并先行动，翻牌后大盲先行动', () => {
  const t = makeTable(['A', 'B']);
  ok(t.startHand());
  assert.equal(t.dealerIndex, 0);
  assert.equal(t.getPlayer('A').bet, 50);
  assert.equal(t.getPlayer('B').bet, 100);
  assert.equal(cur(t), 'A');
  ok(t.act('A', 'call'));
  assert.equal(cur(t), 'B', '大盲有权选择过牌或加注');
  ok(t.act('B', 'check'));
  assert.equal(t.phase, 'flop');
  assert.equal(t.communityCards.length, 3);
  assert.equal(cur(t), 'B');
});

test('只剩一人未弃牌时立即结束并赢得底池', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());          // 庄 A，小盲 B，大盲 C，A 先行动
  assert.equal(cur(t), 'A');
  ok(t.act('A', 'fold'));
  ok(t.act('B', 'fold'));
  assert.equal(t.phase, 'showdown');
  assert.ok(t.result.uncontested);
  assert.equal(t.getPlayer('C').chips, 2050);
  assert.equal(total(t), 6000);
});

test('不是自己的回合不能行动；面对下注不能过牌；加注必须达到最小额', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  assert.equal(t.act('B', 'call').ok, false);
  assert.equal(t.act('A', 'check').ok, false);
  assert.equal(t.act('A', 'raise', 150).ok, false);     // 最少加到 200
  assert.equal(cur(t), 'A');
  ok(t.act('A', 'raise', 300));
  assert.equal(t.currentBet, 300);
  assert.equal(t.minRaise, 200);
  assert.equal(t.act('B', 'raise', 400).ok, false);     // 最少加到 500
  ok(t.act('B', 'raise', 500));
});

test('加注后已行动的玩家需要重新表态', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  ok(t.act('A', 'call'));
  ok(t.act('B', 'call'));
  ok(t.act('C', 'raise', 300));
  assert.equal(t.phase, 'preflop');
  assert.equal(cur(t), 'A');
  ok(t.act('A', 'call'));
  ok(t.act('B', 'call'));
  assert.equal(t.phase, 'flop');
  assert.equal(t.pot, 900);
});

test('翻牌后从庄家左手第一位开始行动', () => {
  const t = makeTable(['A', 'B', 'C', 'D']);
  ok(t.startHand());          // 庄 A，小盲 B，大盲 C，D 先行动
  assert.equal(cur(t), 'D');
  ok(t.act('D', 'call'));
  ok(t.act('A', 'call'));
  ok(t.act('B', 'call'));
  ok(t.act('C', 'check'));
  assert.equal(t.phase, 'flop');
  assert.equal(cur(t), 'B');
  ok(t.act('B', 'fold'));
  ok(t.act('C', 'check'));
  ok(t.act('D', 'check'));
  ok(t.act('A', 'check'));
  assert.equal(t.phase, 'turn');
  assert.equal(cur(t), 'C', '小盲弃牌后由下一位开始');
});

test('庄家按局轮换', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  ok(t.act('A', 'fold'));
  ok(t.act('B', 'fold'));
  ok(t.startHand());
  assert.equal(t.dealerIndex, 1);
  assert.equal(cur(t), 'B');  // 庄 B，小盲 C，大盲 A，B 先行动
});

test('边池：短码全下只能赢得自己跟得起的部分', () => {
  const t = makeTable(['A', 'B', 'C'], { chips: [500, 2000, 2000] });
  ok(t.startHand());
  rig(t, { A: 'A♠ A♥', B: 'K♠ K♥', C: 'Q♠ Q♥' }, '2♦ 7♣ 9♥ J♦ 3♠');
  ok(t.act('A', 'all-in'));   // 500
  ok(t.act('B', 'raise', 1000));
  ok(t.act('C', 'call'));
  assert.equal(t.phase, 'flop');
  ok(t.act('B', 'raise', 500)); // 翻牌圈 B 下注 500
  ok(t.act('C', 'call'));
  ok(t.act('B', 'check'));
  ok(t.act('C', 'check'));
  ok(t.act('B', 'check'));
  ok(t.act('C', 'check'));
  assert.equal(t.phase, 'showdown');
  const [main, side] = t.result.pots;
  assert.equal(main.amount, 1500);
  assert.deepEqual(main.winners.map(w => w.id), ['A']);
  assert.equal(side.amount, 2000);
  assert.deepEqual(side.winners.map(w => w.id), ['B']);
  assert.equal(t.getPlayer('A').chips, 1500);
  assert.equal(t.getPlayer('B').chips, 2500);
  assert.equal(t.getPlayer('C').chips, 500);
  assert.equal(total(t), 4500);
});

test('没人跟的超额下注退回', () => {
  const t = makeTable(['A', 'B'], { chips: [3000, 1000] });
  ok(t.startHand());
  rig(t, { A: '2♠ 7♥', B: 'A♠ A♥' }, '3♦ 8♣ 9♥ J♦ 4♠');
  ok(t.act('A', 'all-in'));
  ok(t.act('B', 'call'));
  assert.equal(t.phase, 'showdown');
  assert.equal(t.communityCards.length, 5, '全员全下后自动发完公共牌');
  assert.equal(t.getPlayer('B').chips, 2000);
  assert.equal(t.getPlayer('A').chips, 2000);
});

test('平分底池，零头给庄家左手第一位赢家', () => {
  const t = makeTable(['A', 'B', 'C'], { bigBlind: 2 });
  ok(t.startHand());          // 庄 A，小盲 B(1)，大盲 C(2)，A 先行动
  rig(t, { A: '2♠ 3♥', B: '4♠ 5♣', C: '4♥ 5♦' }, '10♥ J♠ Q♦ K♣ 9♠');
  ok(t.act('A', 'raise', 5));
  ok(t.act('B', 'call'));
  ok(t.act('C', 'call'));     // 底池 15
  ok(t.act('B', 'check'));
  ok(t.act('C', 'check'));
  ok(t.act('A', 'check'));
  ok(t.act('B', 'raise', 2)); // 转牌圈 B 下注 2
  ok(t.act('C', 'call'));
  ok(t.act('A', 'fold'));     // 底池 19，B、C 都是 K 高顺子
  ok(t.act('B', 'check'));
  ok(t.act('C', 'check'));
  assert.equal(t.phase, 'showdown');
  assert.equal(t.result.pots[0].amount, 19);
  assert.deepEqual(t.result.pots[0].winners.map(w => [w.id, w.amount]), [['B', 10], ['C', 9]]);
  assert.equal(total(t), 6000);
});

test('盲注不足时全下', () => {
  const t = makeTable(['A', 'B', 'C'], { chips: [2000, 30, 2000] });
  ok(t.startHand());
  const b = t.getPlayer('B');
  assert.equal(b.bet, 30);
  assert.ok(b.allIn);
  assert.equal(t.currentBet, 100);
});

test('输光的玩家不会被发牌，补充筹码后可继续', () => {
  const t = makeTable(['A', 'B', 'C'], { chips: [2000, 0, 2000] });
  ok(t.startHand());
  assert.equal(t.getPlayer('B').inHand, false);
  assert.equal(t.getPlayer('B').hand.length, 0);
  assert.equal(t.rebuy('A').ok, false);
  ok(t.rebuy('B'));
  assert.equal(t.getPlayer('B').chips, 2000);
});

test('人数不足 2 人时不能开局', () => {
  const t = makeTable(['A', 'B'], { chips: [2000, 0] });
  assert.equal(t.startHand().ok, false);
  assert.equal(t.phase, 'waiting');
});

test('超时：能过牌就过牌，否则弃牌；掉线超时后暂离', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  assert.deepEqual(t.autoAct().action, 'fold');        // A 面对大盲
  t.setConnected('B', false);
  assert.deepEqual(t.autoAct().action, 'fold');        // B 掉线
  assert.ok(t.getPlayer('B').sittingOut);
  assert.equal(t.phase, 'showdown');
  ok(t.startHand());
  assert.equal(t.getPlayer('B').inHand, false, '暂离/掉线玩家不参与下一局');
  t.setConnected('B', true);
  assert.equal(t.getPlayer('B').sittingOut, false);
});

test('连续两次超时自动暂离，sitIn 回座', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  t.autoAct();                 // A 第 1 次
  ok(t.act('B', 'fold'));
  ok(t.startHand());           // 庄 B，小盲 C，大盲 A，B 先行动
  ok(t.act('B', 'fold'));
  ok(t.act('C', 'call'));
  assert.equal(cur(t), 'A');
  t.autoAct();                 // A 第 2 次（过牌）
  assert.ok(t.getPlayer('A').sittingOut);
  ok(t.sitIn('A'));
  assert.equal(t.getPlayer('A').sittingOut, false);
});

test('牌局中离开：自动弃牌，结束后移出牌桌', () => {
  const t = makeTable(['A', 'B', 'C']);
  ok(t.startHand());
  t.removePlayer('C');         // 非当前行动者离开
  assert.ok(t.getPlayer('C').folded);
  assert.equal(t.players.length, 3);
  t.removePlayer('A');         // 当前行动者离开 -> 只剩 B
  assert.equal(t.phase, 'showdown');
  assert.equal(t.getPlayer('B').chips, 2100);
  assert.equal(t.hostId, 'B', '房主离开后转给下一位');
  t.addPlayer({ id: 'D', name: 'D' });
  ok(t.startHand());
  assert.deepEqual(t.players.map(p => p.id), ['B', 'D']);
});

test('等待阶段离开直接移除', () => {
  const t = makeTable(['A', 'B']);
  t.removePlayer('A');
  assert.deepEqual(t.players.map(p => p.id), ['B']);
  assert.equal(t.hostId, 'B');
});

test('中途加入的玩家下一局才参与', () => {
  const t = makeTable(['A', 'B']);
  ok(t.startHand());
  t.addPlayer({ id: 'C', name: 'C' });
  assert.equal(t.getPlayer('C').inHand, false);
  assert.equal(t.getState('C').players[2].hand.length, 0);
  ok(t.act('A', 'fold'));
  ok(t.startHand());
  assert.equal(t.getPlayer('C').inHand, true);
});

test('视图中看不到别人的手牌，摊牌时亮牌', () => {
  const t = makeTable(['A', 'B']);
  ok(t.startHand());
  const s = t.getState('A');
  assert.equal(s.players[0].hand.length, 2);
  assert.ok(s.players[0].hand[0]);
  assert.deepEqual(s.players[1].hand, [null, null]);
  assert.ok(s.legal);
  assert.equal(t.getState('B').legal, null);
  ok(t.act('A', 'all-in'));
  ok(t.act('B', 'call'));
  const end = t.getState('A');
  assert.ok(end.players[1].hand[0], '摊牌后能看到对手的牌');
  assert.equal(end.result.hands.length, 2);
});

test('随机对局：筹码总数始终守恒且牌局总能结束', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let game = 0; game < 200; game++) {
    const n = 2 + (game % 5);
    const t = new Table({ id: 'R', bigBlind: 20, random: rand });
    for (let i = 0; i < n; i++) {
      const { player } = t.addPlayer({ id: 'P' + i, name: 'P' + i });
      player.chips = 100 + Math.floor(rand() * 900);
    }
    const start = total(t);
    for (let hand = 0; hand < 30 && t.startHand().ok; hand++) {
      let steps = 0;
      while (t.isHandLive()) {
        assert.ok(++steps < 500, '牌局卡住');
        const p = t.players[t.currentPlayerIndex];
        const legal = t.legalActions(p.id);
        const r = rand();
        let res;
        if (r < 0.15) res = t.act(p.id, 'fold');
        else if (r < 0.3 && legal.canRaise) res = t.act(p.id, 'raise', legal.minRaiseTo + Math.floor(rand() * 200));
        else if (r < 0.35) res = t.act(p.id, 'all-in');
        else res = t.act(p.id, legal.canCheck ? 'check' : 'call');
        assert.ok(res.ok, res.error);
        assert.equal(total(t), start);
      }
      assert.ok(t.players.every(p => p.chips >= 0));
    }
  }
});
