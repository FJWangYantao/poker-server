const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHand, compareHands, createDeck, shuffleDeck } = require('../src/game/pokerLogic');

// '10♠ J♥' -> [{rank:'10',suit:'♠'}, ...]
const c = s => s.split(' ').map(x => ({ rank: x.slice(0, -1), suit: x.slice(-1) }));
const rankOf = s => evaluateHand(c(s)).rank;

test('牌堆有 52 张且洗牌不丢牌', () => {
  const deck = shuffleDeck(createDeck());
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(x => x.rank + x.suit)).size, 52);
});

test('7 张牌中识别顺子', () => {
  assert.equal(rankOf('5♠ 6♥ 7♦ 8♣ 9♠ K♥ 2♦'), 'straight');
  assert.equal(rankOf('A♠ 2♥ 3♦ 4♣ 5♠ K♥ 9♦'), 'straight');
  assert.equal(rankOf('10♠ J♥ Q♦ K♣ A♠ A♥ 2♦'), 'straight');
  assert.equal(rankOf('4♠ 5♥ 6♦ 7♣ 8♠ 9♥ 10♦'), 'straight');
  assert.deepEqual(evaluateHand(c('4♠ 5♥ 6♦ 7♣ 8♠ 9♥ 10♦')).highCards, [10]);
});

test('A-2-3-4-5 是最小的顺子', () => {
  assert.ok(compareHands(c('2♠ 3♥ 4♦ 5♣ 6♠ K♥ K♦'), c('A♠ 2♥ 3♦ 4♣ 5♠ K♥ K♦')) > 0);
});

test('同花顺必须是同一花色的五张', () => {
  assert.equal(rankOf('2♥ 5♥ 9♥ J♥ K♥ 10♠ Q♣'), 'flush');
  assert.equal(rankOf('5♥ 6♥ 7♥ 8♥ 9♥ 10♠ 2♣'), 'straight_flush');
  assert.equal(rankOf('10♥ J♥ Q♥ K♥ A♥ 9♠ 2♣'), 'royal_flush');
  assert.equal(rankOf('A♥ 2♥ 3♥ 4♥ 5♥ K♠ Q♣'), 'straight_flush');
});

test('两个三条算葫芦，三对取最大两对', () => {
  assert.equal(rankOf('K♠ K♥ K♦ 5♣ 5♠ 5♥ 2♦'), 'full_house');
  assert.deepEqual(evaluateHand(c('K♠ K♥ K♦ 5♣ 5♠ 5♥ 2♦')).highCards, [13, 5]);
  const tp = evaluateHand(c('K♠ K♥ 9♦ 9♣ 4♠ 4♥ 2♦'));
  assert.equal(tp.rank, 'two_pair');
  assert.deepEqual(tp.highCards, [13, 9, 4]);
});

test('各牌型大小顺序', () => {
  const order = [
    '2♠ 7♥ 9♦ J♣ K♠',   // 高牌
    '2♠ 2♥ 9♦ J♣ K♠',   // 一对
    '2♠ 2♥ 9♦ 9♣ K♠',   // 两对
    '2♠ 2♥ 2♦ 9♣ K♠',   // 三条
    '5♠ 6♥ 7♦ 8♣ 9♠',   // 顺子
    '2♥ 5♥ 9♥ J♥ K♥',   // 同花
    '2♠ 2♥ 2♦ 9♣ 9♠',   // 葫芦
    '2♠ 2♥ 2♦ 2♣ 9♠',   // 四条
    '5♥ 6♥ 7♥ 8♥ 9♥'    // 同花顺
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(compareHands(c(order[i]), c(order[i - 1])) > 0, `${order[i]} 应大于 ${order[i - 1]}`);
  }
});

test('同牌型比踢脚，完全相同为平手', () => {
  assert.ok(compareHands(c('A♠ A♥ K♦ 7♣ 2♠ 3♦ 4♣'), c('A♣ A♦ Q♦ 7♥ 2♥ 3♠ 4♥')) > 0);
  assert.equal(compareHands(c('A♠ K♥ 2♦ 3♣ 8♠ 9♦ J♣'), c('A♥ K♠ 2♣ 3♦ 8♥ 9♣ J♦')), 0);
  // 公共牌就是最大牌型时平分
  assert.equal(compareHands(c('2♠ 3♥ 10♥ J♥ Q♥ K♥ A♥'), c('4♠ 5♥ 10♥ J♥ Q♥ K♥ A♥')), 0);
});

test('描述文字', () => {
  assert.equal(evaluateHand(c('K♠ K♥ 9♦ 4♣ 2♠ 3♦ 7♣')).description, '一对 K');
  assert.equal(evaluateHand(c('5♠ 6♥ 7♦ 8♣ 9♠ K♥ 2♦')).description, '顺子（9 高）');
});
