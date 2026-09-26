// 牌桌状态机：只管规则，不涉及网络与计时（由 server.js 负责）
const { createDeck, shuffleDeck, evaluateHand, compareResults } = require('./pokerLogic');

const PHASE = {
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown'
};
const BETTING_PHASES = [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER];

const MAX_PLAYERS = 9;

class Table {
  constructor({ id, bigBlind = 100, startingChips = 2000, random = Math.random } = {}) {
    this.id = id;
    this.bigBlind = bigBlind;
    this.smallBlind = Math.floor(bigBlind / 2);
    this.startingChips = startingChips;
    this.random = random;

    this.players = [];
    this.hostId = null;
    this.phase = PHASE.WAITING;
    this.handNumber = 0;
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.deck = [];
    this.communityCards = [];
    this.currentBet = 0;   // 本街最高下注
    this.minRaise = bigBlind; // 本街最小加注幅度
    this.result = null;    // 上一局结算
    this.actionCount = 0;  // 每次有人行动 +1，服务器据此重置行动计时
  }

  // ---------- 玩家管理 ----------

  get seatedCount() {
    return this.players.filter(p => !p.left).length;
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  addPlayer({ id, name }) {
    if (this.seatedCount >= MAX_PLAYERS) return { ok: false, error: '房间已满' };
    const player = {
      id,
      name,
      chips: this.startingChips,
      hand: [],
      bet: 0,          // 本街已下注
      totalBet: 0,     // 本局累计下注（用于计算边池）
      folded: false,
      allIn: false,
      inHand: false,   // 是否参与当前这局（中途加入的玩家下一局才参与）
      hasActed: false,
      lastAction: null,
      connected: true,
      sittingOut: false, // 暂离：不参与发牌，回来后可继续
      left: false,       // 已离开：等这局结束后移除
      timeouts: 0
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    return { ok: true, player };
  }

  // 玩家主动离开或被清理
  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;
    const p = this.players[idx];

    if (this.isHandLive() && p.inHand && !p.folded) {
      // 牌局进行中：先弃牌，这局结束后再真正移除
      p.left = true;
      p.connected = false;
      if (idx === this.currentPlayerIndex) {
        this._applyAction(p, 'fold');
      } else {
        p.folded = true;
        p.lastAction = 'fold';
        this._checkUncontested();
      }
    } else if (this.isHandLive() && p.inHand) {
      // 已弃牌但本局筹码仍在底池中，结算后再移除
      p.left = true;
      p.connected = false;
    } else {
      this._removeAt(idx);
    }
    this._ensureHost();
  }

  _removeAt(idx) {
    this.players.splice(idx, 1);
    if (idx < this.dealerIndex) this.dealerIndex--;
    else if (idx === this.dealerIndex) this.dealerIndex--; // 让下一局从原庄家的下一位开始
    if (idx < this.currentPlayerIndex) this.currentPlayerIndex--;
    this._ensureHost();
  }

  _ensureHost() {
    const host = this.getPlayer(this.hostId);
    if (host && !host.left) return;
    const next = this.players.find(p => !p.left);
    this.hostId = next ? next.id : null;
  }

  setConnected(id, connected) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.connected = connected;
    if (connected) {
      p.sittingOut = false;
      p.timeouts = 0;
    }
  }

  sitIn(id) {
    const p = this.getPlayer(id);
    if (!p) return { ok: false, error: '玩家不存在' };
    p.sittingOut = false;
    p.timeouts = 0;
    return { ok: true };
  }

  rebuy(id) {
    const p = this.getPlayer(id);
    if (!p) return { ok: false, error: '玩家不存在' };
    if (p.chips > 0) return { ok: false, error: '还有筹码时不能补充' };
    if (this.isHandLive() && p.inHand && !p.folded) return { ok: false, error: '请等这局结束' };
    p.chips = this.startingChips;
    p.sittingOut = false;
    return { ok: true };
  }

  // 满足开局条件的玩家（掉线的人等回来后下一局再参与）
  eligiblePlayers() {
    return this.players.filter(p => !p.left && !p.sittingOut && p.connected && p.chips > 0);
  }

  isHandLive() {
    return BETTING_PHASES.includes(this.phase);
  }

  // ---------- 开局 ----------

  startHand() {
    if (this.isHandLive()) return { ok: false, error: '当前牌局尚未结束' };

    // 清理上一局离开的玩家
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].left) this._removeAt(i);
    }

    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) {
      this.phase = PHASE.WAITING;
      this.currentPlayerIndex = -1;
      return { ok: false, error: '至少需要 2 名有筹码的玩家' };
    }

    this.players.forEach(p => {
      p.hand = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.hasActed = false;
      p.lastAction = null;
      p.inHand = eligible.includes(p);
    });

    this.handNumber++;
    this.communityCards = [];
    this.result = null;
    this.deck = shuffleDeck(createDeck(), this.random);

    // 庄家顺移到下一位参与者
    this.dealerIndex = this._nextIndex(this.dealerIndex, p => p.inHand);

    // 单挑时庄家下小盲，翻牌前先行动；否则庄家下家小盲、再下家大盲
    let sbIdx, bbIdx;
    if (eligible.length === 2) {
      sbIdx = this.dealerIndex;
      bbIdx = this._nextIndex(sbIdx, p => p.inHand);
    } else {
      sbIdx = this._nextIndex(this.dealerIndex, p => p.inHand);
      bbIdx = this._nextIndex(sbIdx, p => p.inHand);
    }

    // 从小盲开始每人发两张
    for (let round = 0; round < 2; round++) {
      let idx = sbIdx;
      for (let k = 0; k < eligible.length; k++) {
        this.players[idx].hand.push(this.deck.pop());
        idx = this._nextIndex(idx, p => p.inHand);
      }
    }

    this._putChips(this.players[sbIdx], this.smallBlind);
    this._putChips(this.players[bbIdx], this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.phase = PHASE.PREFLOP;

    this._advance(bbIdx);
    return { ok: true };
  }

  // ---------- 行动 ----------

  // 当前行动玩家可执行的操作（给前端显示用）
  legalActions(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (!this.isHandLive() || idx !== this.currentPlayerIndex) return null;
    const p = this.players[idx];
    const toCall = Math.min(this.currentBet - p.bet, p.chips);
    const maxTo = p.bet + p.chips;
    // 其他人都已全下时加注没有意义
    const othersCanAct = this.players.some(o => o !== p && o.inHand && !o.folded && !o.allIn);
    const canRaise = maxTo > this.currentBet && othersCanAct;
    return {
      canCheck: this.currentBet === p.bet,
      toCall,
      canRaise,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, maxTo),
      maxRaiseTo: maxTo
    };
  }

  act(id, action, amount) {
    if (!this.isHandLive()) return { ok: false, error: '当前不在下注阶段' };
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: '你不在这张牌桌上' };
    if (idx !== this.currentPlayerIndex) return { ok: false, error: '还没轮到你' };
    const p = this.players[idx];
    p.timeouts = 0;
    return this._applyAction(p, action, amount);
  }

  // 行动超时：能过牌就过牌，否则弃牌
  autoAct() {
    if (!this.isHandLive()) return null;
    const p = this.players[this.currentPlayerIndex];
    if (!p) return null;
    const action = p.bet === this.currentBet ? 'check' : 'fold';
    p.timeouts++;
    // 掉线或连续两次超时的玩家下一局起暂离，避免反复拖慢牌局
    if (!p.connected || p.timeouts >= 2) p.sittingOut = true;
    this._applyAction(p, action);
    return { player: p, action };
  }

  _applyAction(p, action, amount) {
    const idx = this.players.indexOf(p);
    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold':
        p.folded = true;
        break;

      case 'check':
        if (toCall > 0) return { ok: false, error: '当前需要跟注，不能过牌' };
        break;

      case 'call':
        if (toCall <= 0) {
          action = 'check';
          break;
        }
        this._putChips(p, toCall);
        if (p.allIn) action = 'all-in';
        break;

      case 'raise': {
        const raiseTo = Math.floor(Number(amount));
        if (!Number.isFinite(raiseTo)) return { ok: false, error: '加注金额无效' };
        const maxTo = p.bet + p.chips;
        if (raiseTo >= maxTo) return this._applyAction(p, 'all-in');
        if (raiseTo <= this.currentBet) return { ok: false, error: '加注额必须高于当前下注' };
        if (raiseTo - this.currentBet < this.minRaise) {
          return { ok: false, error: `最少加注到 ${this.currentBet + this.minRaise}` };
        }
        this._putChips(p, raiseTo - p.bet);
        this._raiseTo(p, raiseTo);
        break;
      }

      case 'all-in': {
        if (p.chips <= 0) return { ok: false, error: '没有筹码可以全下' };
        this._putChips(p, p.chips);
        if (p.bet > this.currentBet) this._raiseTo(p, p.bet);
        break;
      }

      default:
        return { ok: false, error: '未知操作' };
    }

    p.hasActed = true;
    p.lastAction = action;
    this.actionCount++;
    this._advance(idx);
    return { ok: true };
  }

  _raiseTo(p, raiseTo) {
    const raiseSize = raiseTo - this.currentBet;
    // 不足最小加注幅度的全下不重新开放加注，但其他人仍需补齐差额
    if (raiseSize >= this.minRaise) {
      this.minRaise = raiseSize;
      this.players.forEach(o => { if (o !== p) o.hasActed = false; });
    }
    this.currentBet = raiseTo;
  }

  _putChips(p, amount) {
    const amt = Math.max(0, Math.min(amount, p.chips));
    p.chips -= amt;
    p.bet += amt;
    p.totalBet += amt;
    if (p.chips === 0) p.allIn = true;
  }

  // ---------- 流程推进 ----------

  _canAct(p) {
    return p.inHand && !p.folded && !p.allIn;
  }

  _nextIndex(from, predicate) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (((from + i) % n) + n) % n;
      if (predicate(this.players[idx])) return idx;
    }
    return -1;
  }

  _roundComplete() {
    const actors = this.players.filter(p => this._canAct(p));
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= this.currentBet) {
      // 只剩一个人能行动且无需补齐：没人可以再和他对抗
      return true;
    }
    return actors.every(p => p.hasActed && p.bet === this.currentBet);
  }

  _checkUncontested() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    if (live.length === 1 && this.isHandLive()) {
      this._finishUncontested(live[0]);
      return true;
    }
    return false;
  }

  _advance(fromIdx) {
    if (this._checkUncontested()) return;
    if (this._roundComplete()) {
      this._nextStreet();
      return;
    }
    this.currentPlayerIndex = this._nextIndex(fromIdx,
      p => this._canAct(p) && (!p.hasActed || p.bet < this.currentBet));
  }

  _nextStreet() {
    this.players.forEach(p => {
      p.bet = 0;
      p.hasActed = false;
      if (!p.folded && p.lastAction !== 'all-in') p.lastAction = null;
    });
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    switch (this.phase) {
      case PHASE.PREFLOP:
        this.deck.pop(); // 烧牌
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.phase = PHASE.FLOP;
        break;
      case PHASE.FLOP:
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = PHASE.TURN;
        break;
      case PHASE.TURN:
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.phase = PHASE.RIVER;
        break;
      case PHASE.RIVER:
        this._showdown();
        return;
    }

    // 能行动的人不足 2 个：直接发完剩余公共牌
    const actors = this.players.filter(p => this._canAct(p));
    if (actors.length < 2) {
      this._nextStreet();
      return;
    }
    // 翻牌后从庄家左手第一位仍可行动的玩家开始
    this.currentPlayerIndex = this._nextIndex(this.dealerIndex, p => this._canAct(p));
  }

  get pot() {
    return this.players.reduce((sum, p) => sum + p.totalBet, 0);
  }

  _finishUncontested(winner) {
    const amount = this.pot;
    winner.chips += amount;
    this.result = {
      uncontested: true,
      pots: [{ amount, winners: [{ id: winner.id, name: winner.name, amount }] }],
      hands: []
    };
    this._endHand();
  }

  // 按各人本局投入额切分主池与边池
  buildPots() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    const levels = [...new Set(live.map(p => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      this.players.forEach(p => {
        amount += Math.max(0, Math.min(p.totalBet, level) - prev);
      });
      const eligible = live.filter(p => p.totalBet >= level);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // 理论上不会出现：弃牌者投入超过所有未弃牌者，余额并入最后一个池
    const leftover = this.players.reduce((s, p) => s + Math.max(0, p.totalBet - prev), 0);
    if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  _showdown() {
    const live = this.players.filter(p => p.inHand && !p.folded);
    const evals = new Map();
    live.forEach(p => evals.set(p, evaluateHand([...p.hand, ...this.communityCards])));

    const pots = this.buildPots().map(({ amount, eligible }) => {
      let best = [];
      eligible.forEach(p => {
        if (!best.length) { best = [p]; return; }
        const cmp = compareResults(evals.get(p), evals.get(best[0]));
        if (cmp > 0) best = [p];
        else if (cmp === 0) best.push(p);
      });

      // 平分，除不尽的零头按庄家左手顺序依次给
      const share = Math.floor(amount / best.length);
      let remainder = amount - share * best.length;
      const ordered = [];
      for (let i = 1; i <= this.players.length; i++) {
        const p = this.players[(this.dealerIndex + i) % this.players.length];
        if (best.includes(p)) ordered.push(p);
      }
      const winners = ordered.map(p => {
        const won = share + (remainder-- > 0 ? 1 : 0);
        p.chips += won;
        return { id: p.id, name: p.name, amount: won };
      });
      return { amount, winners };
    });

    this.result = {
      uncontested: false,
      pots,
      hands: live.map(p => {
        const e = evals.get(p);
        return {
          id: p.id,
          name: p.name,
          cards: p.hand,
          best: e.cards,
          rank: e.rank,
          description: e.description
        };
      })
    };
    this._endHand();
  }

  _endHand() {
    this.phase = PHASE.SHOWDOWN;
    this.currentPlayerIndex = -1;
    this.currentBet = 0;
    // 底池已分配完毕
    this.players.forEach(p => { p.bet = 0; p.totalBet = 0; });
  }

  // ---------- 对外状态 ----------

  // 为某位玩家生成视图：只能看到自己的手牌，摊牌时能看到亮出的牌
  getState(viewerId) {
    const shown = new Set(this.result ? this.result.hands.map(h => h.id) : []);
    const myIndex = this.players.findIndex(p => p.id === viewerId);
    return {
      roomId: this.id,
      phase: this.phase,
      handNumber: this.handNumber,
      hostId: this.hostId,
      myId: viewerId,
      myIndex,
      bigBlind: this.bigBlind,
      smallBlind: this.smallBlind,
      startingChips: this.startingChips,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      pot: this.pot,
      communityCards: this.communityCards,
      legal: this.legalActions(viewerId),
      result: this.result,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        lastAction: p.lastAction,
        connected: p.connected,
        sittingOut: p.sittingOut,
        left: p.left,
        hand: p.id === viewerId || shown.has(p.id)
          ? p.hand
          : p.hand.map(() => null)
      }))
    };
  }
}

module.exports = { Table, PHASE, MAX_PLAYERS };
