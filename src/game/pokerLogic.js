// 德州扑克游戏核心逻辑（服务器端）

// 牌面花色
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

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
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 获取牌的数值
function getCardValue(card) {
  const rankValues = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
  };
  return rankValues[card.rank];
}

// 判断是否是同花
function isFlush(cards) {
  return cards.every(card => card.suit === cards[0].suit);
}

// 判断是否是顺子
function isStraight(cards) {
  const values = [...new Set(cards.map(getCardValue))].sort((a, b) => a - b);

  if (values.length === 5) {
    // A-2-3-4-5顺子
    if (values[4] === 14 && values[0] === 2 && values[1] === 3 && values[2] === 4 && values[3] === 5) {
      return true;
    }
    // 普通顺子
    for (let i = 0; i < values.length - 1; i++) {
      if (values[i + 1] - values[i] !== 1) return false;
    }
    return true;
  }
  return false;
}

// 评估牌型
function evaluateHand(cards) {
  if (cards.length < 5) {
    return { rank: 'high_card', highCards: [], description: '高牌' };
  }

  const values = cards.map(getCardValue).sort((a, b) => b - a);
  const valueCounts = new Map();
  const suitCounts = new Map();

  cards.forEach(card => {
    const v = getCardValue(card);
    valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
    suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);
  });

  const counts = Array.from(valueCounts.values()).sort((a, b) => b - a);
  const flushSuit = Array.from(suitCounts.entries()).find(([_, count]) => count >= 5);
  const isFlushHand = flushSuit !== undefined;
  const isStraightHand = isStraight(cards);

  // 皇家同花顺
  if (isFlushHand && isStraightHand && values[0] === 14 && values[1] === 13) {
    return { rank: 'royal_flush', highCards: [14], description: '皇家同花顺' };
  }

  // 同花顺
  if (isFlushHand && isStraightHand) {
    return { rank: 'straight_flush', highCards: values, description: '同花顺' };
  }

  // 四条
  if (counts[0] === 4) {
    const fourValue = Array.from(valueCounts.entries()).find(([_, count]) => count === 4)[0];
    const kicker = Math.max(...values.filter(v => v !== fourValue));
    return { rank: 'four_of_a_kind', highCards: [fourValue, kicker], description: '四条' };
  }

  // 葫芦
  if (counts[0] === 3 && counts[1] === 2) {
    const threeValue = Array.from(valueCounts.entries()).find(([_, count]) => count === 3)[0];
    const pairValue = Array.from(valueCounts.entries()).find(([_, count]) => count === 2)[0];
    return { rank: 'full_house', highCards: [threeValue, pairValue], description: '葫芦' };
  }

  // 同花
  if (isFlushHand) {
    const flushCards = cards.filter(c => c.suit === flushSuit[0]);
    const flushValues = flushCards.map(getCardValue).sort((a, b) => b - a);
    return { rank: 'flush', highCards: flushValues, description: '同花' };
  }

  // 顺子
  if (isStraightHand) {
    return { rank: 'straight', highCards: values, description: '顺子' };
  }

  // 三条
  if (counts[0] === 3) {
    const threeValue = Array.from(valueCounts.entries()).find(([_, count]) => count === 3)[0];
    const kickers = values.filter(v => v !== threeValue).sort((a, b) => b - a).slice(0, 2);
    return { rank: 'three_of_a_kind', highCards: [threeValue, ...kickers], description: '三条' };
  }

  // 两对
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = Array.from(valueCounts.entries())
      .filter(([_, count]) => count === 2)
      .map(([v]) => v)
      .sort((a, b) => b - a);
    const kicker = Math.max(...values.filter(v => v !== pairs[0] && v !== pairs[1]));
    return { rank: 'two_pair', highCards: [...pairs, kicker], description: '两对' };
  }

  // 一对
  if (counts[0] === 2) {
    const pairValue = Array.from(valueCounts.entries()).find(([_, count]) => count === 2)[0];
    const kickers = values.filter(v => v !== pairValue).sort((a, b) => b - a).slice(0, 3);
    return { rank: 'pair', highCards: [pairValue, ...kickers], description: '一对' };
  }

  // 高牌
  return { rank: 'high_card', highCards: values.slice(0, 5), description: '高牌' };
}

// 比较牌型
function compareHands(hand1, hand2) {
  const result1 = evaluateHand(hand1);
  const result2 = evaluateHand(hand2);

  const rankOrder = {
    'high_card': 0,
    'pair': 1,
    'two_pair': 2,
    'three_of_a_kind': 3,
    'straight': 4,
    'flush': 5,
    'full_house': 6,
    'four_of_a_kind': 7,
    'straight_flush': 8,
    'royal_flush': 9
  };

  const rankDiff = rankOrder[result1.rank] - rankOrder[result2.rank];
  if (rankDiff !== 0) return rankDiff;

  for (let i = 0; i < Math.min(result1.highCards.length, result2.highCards.length); i++) {
    const diff = result1.highCards[i] - result2.highCards[i];
    if (diff !== 0) return diff;
  }

  return 0;
}

module.exports = {
  createDeck,
  shuffleDeck,
  evaluateHand,
  compareHands
};
