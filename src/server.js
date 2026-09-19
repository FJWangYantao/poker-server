const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createDeck, shuffleDeck, evaluateHand, compareHands } = require('./game/pokerLogic');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 房间存储
const rooms = new Map();

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 游戏阶段
const PHASE = {
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown'
};

// 创建新房间
function createRoom(roomId, bigBlind = 100) {
  const room = {
    id: roomId,
    players: [],
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    bigBlind,
    smallBlind: bigBlind / 2,
    dealerIndex: 0,
    currentPlayerIndex: -1,
    phase: PHASE.WAITING,
    waitingPlayers: [],
    winners: [],
    handNumber: 0
  };
  rooms.set(roomId, room);
  return room;
}

// 获取玩家可视的手牌（只返回自己的手牌）
function getPlayerVisibleState(room, socketId) {
  const player = room.players.find(p => p.socketId === socketId);
  const visiblePlayers = room.players.map((p, idx) => ({
    ...p,
    hand: p.socketId === socketId ? p.hand : p.hand.map(() => null),  // 只显示自己的手牌
    isFolded: p.isFolded,
    isAllIn: p.isAllIn,
    isConnected: p.isConnected
  }));

  return {
    roomId: room.id,
    phase: room.phase,
    communityCards: room.communityCards,
    players: visiblePlayers,
    currentPlayerIndex: room.currentPlayerIndex,
    pot: room.pot,
    currentBet: room.currentBet,
    bigBlind: room.bigBlind,
    smallBlind: room.smallBlind,
    dealerIndex: room.dealerIndex,
    waitingPlayers: room.waitingPlayers,
    showResult: room.phase === PHASE.SHOWDOWN,
    winners: room.winners,
    handNumber: room.handNumber,
    myIndex: player ? room.players.indexOf(player) : -1
  };
}

// 发手牌
function dealHands(room) {
  room.deck = shuffleDeck(createDeck());
  room.players.forEach((player, idx) => {
    player.hand = [room.deck[idx], room.deck[idx + room.players.length]];
  });
}

// 开始新的一局
function startNewHand(room) {
  // 重置玩家状态
  room.players.forEach(player => {
    player.currentBet = 0;
    player.isFolded = false;
    player.isAllIn = false;
    player.lastAction = undefined;
  });

  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 0;
  room.winners = [];
  room.handNumber++;

  // 发牌
  dealHands(room);

  // 设置大小盲注
  const dealerIdx = room.dealerIndex;
  const smallBlindIdx = (dealerIdx + 1) % room.players.length;
  const bigBlindIdx = (dealerIdx + 2) % room.players.length;

  const sb = room.players[smallBlindIdx];
  const bb = room.players[bigBlindIdx];

  if (sb.chips >= room.smallBlind) {
    sb.currentBet = room.smallBlind;
    sb.chips -= room.smallBlind;
    room.pot += room.smallBlind;
  }

  if (bb.chips >= room.bigBlind) {
    bb.currentBet = room.bigBlind;
    bb.chips -= room.bigBlind;
    room.pot += room.bigBlind;
  }

  room.currentBet = room.bigBlind;
  room.phase = PHASE.PREFLOP;
  room.currentPlayerIndex = (bigBlindIdx + 1) % room.players.length;
  room.waitingPlayers = room.players.map((_, idx) => idx);
}

// 处理玩家动作
function handlePlayerAction(room, playerIndex, action, amount) {
  const player = room.players[playerIndex];
  if (!player || player.isFolded) return;

  switch (action) {
    case 'fold':
      player.isFolded = true;
      player.lastAction = 'fold';
      break;

    case 'check':
      if (player.currentBet === room.currentBet) {
        player.lastAction = 'check';
      }
      break;

    case 'call':
      const callAmount = room.currentBet - player.currentBet;
      if (callAmount >= player.chips) {
        // 全下
        room.pot += player.chips;
        player.currentBet += player.chips;
        player.chips = 0;
        player.isAllIn = true;
        player.lastAction = 'all-in';
      } else {
        room.pot += callAmount;
        player.currentBet = room.currentBet;
        player.chips -= callAmount;
        player.lastAction = 'call';
      }
      break;

    case 'raise':
      const raiseAmount = amount || room.currentBet * 2;
      const totalBet = player.currentBet + raiseAmount;
      if (totalBet > player.chips + player.currentBet) return;

      const actualRaise = Math.min(raiseAmount, player.chips - (room.currentBet - player.currentBet));
      room.pot += actualRaise;
      room.currentBet = player.currentBet + actualRaise;

      if (player.chips - actualRaise <= 0) {
        player.currentBet += actualRaise;
        player.chips = 0;
        player.isAllIn = true;
        player.lastAction = 'all-in';
      } else {
        player.currentBet += actualRaise;
        player.chips -= actualRaise;
        player.lastAction = 'raise';
      }
      break;

    case 'all-in':
      room.pot += player.chips;
      player.currentBet += player.chips;
      player.chips = 0;
      player.isAllIn = true;
      player.lastAction = 'all-in';
      if (player.currentBet > room.currentBet) {
        room.currentBet = player.currentBet;
      }
      break;
  }

  // 移除等待列表
  const waitIdx = room.waitingPlayers.indexOf(playerIndex);
  if (waitIdx > -1) {
    room.waitingPlayers.splice(waitIdx, 1);
  }

  // 检查是否进入下一轮
  checkNextPhase(room);
}

// 发下一街公共牌，推进阶段（河牌后进入摊牌）
function dealNextStreet(room) {
  switch (room.phase) {
    case PHASE.PREFLOP:
      room.communityCards = [room.deck[room.players.length * 2], room.deck[room.players.length * 2 + 1], room.deck[room.players.length * 2 + 2]];
      room.phase = PHASE.FLOP;
      break;
    case PHASE.FLOP:
      room.communityCards.push(room.deck[room.players.length * 2 + 3]);
      room.phase = PHASE.TURN;
      break;
    case PHASE.TURN:
      room.communityCards.push(room.deck[room.players.length * 2 + 4]);
      room.phase = PHASE.RIVER;
      break;
    case PHASE.RIVER:
      room.phase = PHASE.SHOWDOWN;
      break;
  }
}

// 检查是否进入下一阶段
function checkNextPhase(room) {
  const activePlayers = room.players.filter(p => !p.isFolded && !p.isAllIn);
  const unfolded = room.players.filter(p => !p.isFolded);
  const allBetsEqual = activePlayers.every(p => p.currentBet === room.currentBet);
  const allActed = room.waitingPlayers.length === 0;

  // 剩余玩家全部全下：无人可再行动，直接发完剩余公共牌摊牌
  if (unfolded.length >= 2 && activePlayers.length === 0 && allActed) {
    while (room.phase !== PHASE.SHOWDOWN) {
      dealNextStreet(room);
    }
    evaluateWinners(room);
    return;
  }

  if (allBetsEqual && allActed && activePlayers.length > 0) {
    // 进入下一阶段
    dealNextStreet(room);
    if (room.phase === PHASE.SHOWDOWN) {
      evaluateWinners(room);
      return;
    }

    // 重置下注与上街动作标记
    room.players.forEach(p => { p.currentBet = 0; p.lastAction = undefined; });
    room.currentBet = 0;

    // 确定下一轮行动玩家
    const nextPlayer = room.players.findIndex((p, idx) => !p.isFolded && !p.isAllIn && idx !== room.currentPlayerIndex);
    room.currentPlayerIndex = nextPlayer > -1 ? nextPlayer : room.currentPlayerIndex;

    // 更新等待列表
    room.waitingPlayers = [];
    room.players.forEach((_, idx) => {
      if (!room.players[idx].isFolded && !room.players[idx].isAllIn) {
        room.waitingPlayers.push(idx);
      }
    });
  } else {
    // 下一位玩家
    let nextIdx = (room.currentPlayerIndex + 1) % room.players.length;
    let attempts = 0;
    while ((room.players[nextIdx].isFolded || room.players[nextIdx].isAllIn) && attempts < room.players.length) {
      nextIdx = (nextIdx + 1) % room.players.length;
      attempts++;
    }
    room.currentPlayerIndex = nextIdx;
  }

  // 广播游戏状态
  broadcastGameState(room);
}

// 评估赢家
function evaluateWinners(room) {
  const results = [];
  const activePlayers = room.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.isFolded);

  if (activePlayers.length === 0) {
    // 所有人都弃牌
    const lastBetter = room.players.findIndex(p => p.currentBet > 0);
    if (lastBetter > -1) {
      results.push({
        playerIndex: lastBetter,
        hand: [],
        rank: 'high_card',
        description: '对手弃牌获胜'
      });
      room.players[lastBetter].chips += room.pot;
    }
  } else if (activePlayers.length === 1) {
    const { player, index } = activePlayers[0];
    const result = evaluateHand([...player.hand, ...room.communityCards]);
    results.push({
      playerIndex: index,
      hand: [...player.hand, ...room.communityCards],
      rank: result.rank,
      description: result.description
    });
    player.chips += room.pot;
  } else {
    // 比牌
    let bestIndex = -1;
    let bestHand = [];
    let bestResult = { rank: 'high_card', highCards: [], description: '' };

    activePlayers.forEach(({ player, index }) => {
      const fullHand = [...player.hand, ...room.communityCards];
      const result = evaluateHand(fullHand);

      if (bestIndex === -1 || compareHands(fullHand, bestHand) > 0) {
        bestIndex = index;
        bestHand = fullHand;
        bestResult = result;
      }
    });

    // 检查平手
    const tiedPlayers = activePlayers.filter(({ player, index }) => {
      if (index === bestIndex) return false;
      const hand = [...player.hand, ...room.communityCards];
      return compareHands(hand, bestHand) === 0;
    });

    if (tiedPlayers.length > 0) {
      const splitPot = Math.floor(room.pot / (tiedPlayers.length + 1));
      results.push({
        playerIndex: bestIndex,
        hand: bestHand,
        rank: bestResult.rank,
        description: `与${tiedPlayers.length}人平分底池`
      });
      room.players[bestIndex].chips += splitPot;

      tiedPlayers.forEach(({ index, player }) => {
        const hand = [...player.hand, ...room.communityCards];
        const result = evaluateHand(hand);
        results.push({
          playerIndex: index,
          hand,
          rank: result.rank,
          description: '平分底池'
        });
        player.chips += splitPot;
      });
    } else {
      results.push({
        playerIndex: bestIndex,
        hand: bestHand,
        rank: bestResult.rank,
        description: bestResult.description
      });
      room.players[bestIndex].chips += room.pot;
    }
  }

  room.winners = results;
  room.phase = PHASE.SHOWDOWN;

  broadcastGameState(room);
}

// 广播游戏状态到房间所有玩家
function broadcastGameState(room) {
  room.players.forEach(player => {
    const state = getPlayerVisibleState(room, player.socketId);
    io.to(player.socketId).emit('gameState', state);
  });
}

// 大厅阶段展示用的玩家信息（不含手牌）
function lobbyPlayers(room) {
  return room.players.map(p => ({
    name: p.name,
    chips: p.chips,
    isConnected: p.isConnected
  }));
}

// Socket.io 连接处理
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  // 创建房间
  socket.on('createRoom', (data, callback) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, data.bigBlind || 100);

    const player = {
      socketId: socket.id,
      name: data.name || '玩家',
      chips: 2000,
      currentBet: 0,
      hand: [],
      isFolded: false,
      isAllIn: false,
      isConnected: true,
      lastAction: undefined
    };

    room.players.push(player);
    socket.join(roomId);

    callback({ success: true, roomId, playerIndex: 0, players: lobbyPlayers(room) });
  });

  // 加入房间
  socket.on('joinRoom', (data, callback) => {
    const { roomId, name } = data;
    const room = rooms.get(roomId);

    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    if (room.players.length >= 9) {
      callback({ success: false, error: '房间已满' });
      return;
    }

    if (room.phase !== PHASE.WAITING) {
      callback({ success: false, error: '游戏已开始，无法加入' });
      return;
    }

    const player = {
      socketId: socket.id,
      name: name || '玩家',
      chips: 2000,
      currentBet: 0,
      hand: [],
      isFolded: false,
      isAllIn: false,
      isConnected: true,
      lastAction: undefined
    };

    room.players.push(player);
    socket.join(roomId);

    // 通知其他玩家
    socket.to(roomId).emit('playerJoined', {
      playerIndex: room.players.length - 1,
      player: { ...player, hand: [null, null] }
    });

    callback({ success: true, playerIndex: room.players.length - 1, players: lobbyPlayers(room) });
  });

  // 离开房间
  socket.on('leaveRoom', (data, callback) => {
    handlePlayerLeave(socket, callback);
  });

  // 开始游戏
  socket.on('startGame', (data, callback) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      callback({ success: false, error: '房间不存在' });
      return;
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.players.indexOf(player) !== 0) {
      callback({ success: false, error: '只有房主可以开始游戏' });
      return;
    }

    if (room.players.length < 2) {
      callback({ success: false, error: '需要至少2名玩家' });
      return;
    }

    startNewHand(room);
    broadcastGameState(room);

    callback({ success: true });
  });

  // 玩家动作
  socket.on('playerAction', (data) => {
    const { roomId, action, amount } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;

    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) return;

    handlePlayerAction(room, playerIndex, action, amount);
  });

  // 下一局
  socket.on('nextHand', (data, callback) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    // 检查是否所有玩家都准备好了
    const activePlayers = room.players.filter(p => p.chips > 0);
    if (activePlayers.length < 2) {
      callback({ success: false, error: '玩家不足' });
      return;
    }

    // 移动庄家
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

    // 重置玩家状态
    room.players.forEach(player => {
      player.currentBet = 0;
      player.hand = [];
      player.isFolded = false;
      player.isAllIn = false;
      player.lastAction = undefined;
    });

    startNewHand(room);
    broadcastGameState(room);

    callback({ success: true });
  });

  // 断开连接
  socket.on('disconnect', () => {
    handlePlayerLeave(socket);
  });

  function handlePlayerLeave(socket, callback) {
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIndex > -1) {
        const player = room.players[playerIndex];

        // 如果是游戏进行中，标记为断开连接
        if (room.phase !== PHASE.WAITING) {
          player.isConnected = false;
          socket.to(roomId).emit('playerDisconnected', { playerIndex });

          // 如果是当前行动玩家，自动弃牌
          if (playerIndex === room.currentPlayerIndex) {
            handlePlayerAction(room, playerIndex, 'fold');
          }
        } else {
          // 等待阶段，直接移除玩家
          room.players.splice(playerIndex, 1);
          socket.to(roomId).emit('playerLeft', { playerIndex });

          // 如果房间空了，删除房间
          if (room.players.length === 0) {
            rooms.delete(roomId);
          }
        }

        if (callback) {
          callback({ success: true });
        }
        break;
      }
    }
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
