// 德州扑克游戏核心逻辑（服务器端）：发牌、洗牌、牌型评估

// 牌面花色
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

// 牌型：rankValue 越大越强
const HAND_TYPES = {
  high_card: { value: 0, name: '高牌' },
  pair: { value: 1, name: '一对' },
  two_pair: { value: 2, name: '两对' },
  three_of_a_kind: { value: 3, name: '三条' },
  straight: { value: 4, name: '顺子' },
  flush: { value: 5, name: '同花' },
  full_house: { value: 6, name: '葫芦' },
  four_of_a_kind: { value: 7, name: '四条' },
  straight_flush: { value: 8, name: '同花顺' },
  royal_flush: { value: 8, name: '皇家同花顺' } // 皇家同花顺就是 A 高的同花顺
};

// 创建一副标准扑克牌
function createDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

// Fisher-Yates 洗牌算法
function shuffleDeck(deck, random = Math.random) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 获取牌的数值
function getCardValue(card) {
  return RANK_VALUES[card.rank];
}

// 数值转牌面文字（用于描述）
function valueName(v) {
  return { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' }[v] || String(v);
}

// 评估恰好 5 张牌
function evaluateFive(cards) {
  const values = cards.map(getCardValue).sort((a, b) => b - a);
  const isFlush = cards.every(c => c.suit === cards[0].suit);

  // 顺子：5 个不同点数且首尾差 4，或 A-2-3-4-5（A 当 1 用，5 高）
  const unique = [...new Set(values)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique.join(',') === '14,5,4,3,2') straightHigh = 5;
  }

  // 按（张数降序, 点数降序）分组，便于比较对子/三条/四条
  const counts = new Map();
  values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(g => g[1]).join('');
  const byGroup = groups.map(g => g[0]);

  let rank, tiebreak;
  if (straightHigh && isFlush) {
    rank = straightHigh === 14 ? 'royal_flush' : 'straight_flush';
    tiebreak = [straightHigh];
  } else if (shape === '41') {
    rank = 'four_of_a_kind'; tiebreak = byGroup;
  } else if (shape === '32') {
    rank = 'full_house'; tiebreak = byGroup;
  } else if (isFlush) {
    rank = 'flush'; tiebreak = values;
  } else if (straightHigh) {
    rank = 'straight'; tiebreak = [straightHigh];
  } else if (shape === '311') {
    rank = 'three_of_a_kind'; tiebreak = byGroup;
  } else if (shape === '221') {
    rank = 'two_pair'; tiebreak = byGroup;
  } else if (shape === '2111') {
    rank = 'pair'; tiebreak = byGroup;
  } else {
    rank = 'high_card'; tiebreak = values;
  }

  return {
    rank,
    rankValue: HAND_TYPES[rank].value,
    highCards: tiebreak,
    description: describe(rank, tiebreak),
    cards
  };
}

function describe(rank, t) {
  const n = HAND_TYPES[rank].name;
  switch (rank) {
    case 'royal_flush': return n;
    case 'straight_flush':
    case 'straight': return `${n}（${valueName(t[0])} 高）`;
    case 'four_of_a_kind':
    case 'three_of_a_kind':
    case 'pair': return `${n} ${valueName(t[0])}`;
    case 'full_house': return `${n}（${valueName(t[0])} 带 ${valueName(t[1])}）`;
    case 'two_pair': return `${n} ${valueName(t[0])} 和 ${valueName(t[1])}`;
    case 'flush':
    case 'high_card': return `${n} ${valueName(t[0])}`;
  }
  return n;
}

// 比较两个评估结果：>0 表示 a 更大，<0 表示 b 更大，0 为平手
function compareResults(a, b) {
  if (a.rankValue !== b.rankValue) return a.rankValue - b.rankValue;
  for (let i = 0; i < Math.max(a.highCards.length, b.highCards.length); i++) {
    const diff = (a.highCards[i] || 0) - (b.highCards[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 从任意 5~7 张牌中找出最大的 5 张组合
function evaluateHand(cards) {
  if (cards.length < 5) {
    const values = cards.map(getCardValue).sort((a, b) => b - a);
    return { rank: 'high_card', rankValue: 0, highCards: values, description: '高牌', cards: [...cards] };
  }

  let best = null;
  const n = cards.length;
  const pick = [];
  (function choose(start) {
    if (pick.length === 5) {
      const result = evaluateFive(pick.map(i => cards[i]));
      if (!best || compareResults(result, best) > 0) best = result;
      return;
    }
    for (let i = start; i <= n - (5 - pick.length); i++) {
      pick.push(i);
      choose(i + 1);
      pick.pop();
    }
  })(0);
  return best;
}

// 比较两手牌（各自传入全部可用牌）
function compareHands(hand1, hand2) {
  return compareResults(evaluateHand(hand1), evaluateHand(hand2));
}

module.exports = {
  createDeck,
  shuffleDeck,
  evaluateHand,
  compareHands,
  compareResults
};
