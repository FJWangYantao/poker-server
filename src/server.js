const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Table, PHASE } = require('./game/table');

const DEFAULTS = {
  turnSeconds: Number(process.env.TURN_SECONDS) || 30,             // 每次行动时限
  disconnectedTurnSeconds: Number(process.env.DISCONNECTED_TURN_SECONDS) || 15, // 掉线玩家的行动时限（留时间刷新重连）
  sittingOutTurnSeconds: 2,                                         // 暂离/已离开玩家的行动时限
  nextHandSeconds: Number(process.env.NEXT_HAND_SECONDS) || 8,     // 摊牌后自动开下一局
  lobbyDisconnectSeconds: 60,                                       // 等待阶段掉线多久后移出房间
  gameDisconnectSeconds: 5 * 60,                                    // 游戏阶段掉线多久后移出房间
  emptyRoomSeconds: 10 * 60                                         // 所有人都掉线多久后删除房间
};

function createPokerServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  const app = express();
  app.use(cors());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // 手机切后台时心跳可能暂停，放宽超时减少误判掉线
    pingInterval: 20000,
    pingTimeout: 25000
  });

  // roomId -> { table, tokens: Map(token -> playerId), sockets: Map(playerId -> socketId), timers }
  const rooms = new Map();

  function generateRoomId() {
    let id;
    do {
      id = Math.random().toString(36).substring(2, 8).toUpperCase().padEnd(6, 'X');
    } while (rooms.has(id));
    return id;
  }

  function cleanName(name) {
    const n = String(name || '').trim().slice(0, 12);
    return n || '玩家';
  }

  function createRoom(bigBlind) {
    const bb = Math.floor(Number(bigBlind));
    const room = {
      table: new Table({
        id: generateRoomId(),
        bigBlind: Number.isFinite(bb) && bb >= 2 && bb <= 10000 ? bb : 100
      }),
      tokens: new Map(),
      sockets: new Map(),
      timers: { turn: null, turnKey: null, nextHand: null, away: new Map(), empty: null },
      turnDeadline: null,
      nextHandAt: null
    };
    rooms.set(room.table.id, room);
    return room;
  }

  function deleteRoom(room) {
    const t = room.timers;
    clearTimeout(t.turn);
    clearTimeout(t.nextHand);
    clearTimeout(t.empty);
    t.away.forEach(clearTimeout);
    rooms.delete(room.table.id);
  }

  function seatPlayer(room, socket, name) {
    const playerId = uuidv4().slice(0, 8);
    const token = uuidv4();
    const res = room.table.addPlayer({ id: playerId, name: cleanName(name) });
    if (!res.ok) return res;
    room.tokens.set(token, playerId);
    attach(room, socket, playerId);
    return { ok: true, token, playerId };
  }

  function attach(room, socket, playerId) {
    const oldSocketId = room.sockets.get(playerId);
    if (oldSocketId && oldSocketId !== socket.id) {
      // 同一玩家在新页面登录，踢掉旧连接
      const old = io.sockets.sockets.get(oldSocketId);
      if (old) {
        old.data = {};
        old.emit('kicked', { reason: '你已在其他页面进入该房间' });
        old.leave(room.table.id);
      }
    }
    room.sockets.set(playerId, socket.id);
    socket.data = { roomId: room.table.id, playerId };
    socket.join(room.table.id);
    clearTimeout(room.timers.away.get(playerId));
    room.timers.away.delete(playerId);
    clearTimeout(room.timers.empty);
    room.timers.empty = null;
    room.table.setConnected(playerId, true);
  }

  function currentRoom(socket) {
    const { roomId, playerId } = socket.data || {};
    const room = roomId && rooms.get(roomId);
    if (!room || !playerId || room.sockets.get(playerId) !== socket.id) return null;
    if (!room.table.getPlayer(playerId)) return null;
    return { room, playerId };
  }

  // 广播状态 + 维护计时器
  function sync(room) {
    const { table } = room;
    if (!rooms.has(table.id)) return;
    scheduleTimers(room);
    const now = Date.now();
    table.players.forEach(p => {
      const sid = room.sockets.get(p.id);
      if (!sid || !p.connected) return;
      io.to(sid).emit('gameState', {
        ...table.getState(p.id),
        turnDeadline: room.turnDeadline,
        nextHandAt: room.nextHandAt,
        serverNow: now
      });
    });
  }

  function scheduleTimers(room) {
    const { table, timers } = room;

    // 行动计时
    if (table.isHandLive()) {
      const cur = table.players[table.currentPlayerIndex];
      const key = `${table.handNumber}:${table.actionCount}:${table.currentPlayerIndex}`;
      if (cur && key !== timers.turnKey) {
        clearTimeout(timers.turn);
        timers.turnKey = key;
        const secs = cur.sittingOut || cur.left ? cfg.sittingOutTurnSeconds
          : cur.connected ? cfg.turnSeconds : cfg.disconnectedTurnSeconds;
        room.turnDeadline = Date.now() + secs * 1000;
        timers.turn = setTimeout(() => {
          timers.turnKey = null;
          if (table.isHandLive() && table.players[table.currentPlayerIndex] === cur) {
            table.autoAct();
            sync(room);
          }
        }, secs * 1000);
      }
    } else {
      clearTimeout(timers.turn);
      timers.turnKey = null;
      room.turnDeadline = null;
    }

    // 摊牌后自动开下一局
    if (table.phase === PHASE.SHOWDOWN) {
      if (!timers.nextHand) {
        room.nextHandAt = Date.now() + cfg.nextHandSeconds * 1000;
        timers.nextHand = setTimeout(() => startNextHand(room), cfg.nextHandSeconds * 1000);
      }
    } else {
      clearTimeout(timers.nextHand);
      timers.nextHand = null;
      room.nextHandAt = null;
    }
  }

  function startNextHand(room) {
    clearTimeout(room.timers.nextHand);
    room.timers.nextHand = null;
    // 已离开/掉线的人不再占座
    const res = room.table.startHand();
    sync(room);
    return res;
  }

  // 房主不在线时，其他玩家也可以开局
  function canControl(room, playerId) {
    const host = room.table.getPlayer(room.table.hostId);
    return playerId === room.table.hostId || !host || !host.connected;
  }

  function handleLeave(room, playerId) {
    const { table } = room;
    table.removePlayer(playerId);
    for (const [token, id] of room.tokens) {
      if (id === playerId) room.tokens.delete(token);
    }
    room.sockets.delete(playerId);
    clearTimeout(room.timers.away.get(playerId));
    room.timers.away.delete(playerId);

    if (table.players.every(p => p.left)) {
      // 所有人都离开了（包括牌局中离开、尚未移除的人）
      deleteRoom(room);
      return;
    }
    // 等待阶段只剩 1 人时不会自动开局；牌局阶段由 table 自行处理
    sync(room);
  }

  io.on('connection', (socket) => {
    const reply = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

    socket.on('createRoom', (data = {}, cb) => {
      const room = createRoom(data.bigBlind);
      const res = seatPlayer(room, socket, data.name);
      reply(cb, { success: true, roomId: room.table.id, token: res.token, playerId: res.playerId });
      sync(room);
    });

    socket.on('joinRoom', (data = {}, cb) => {
      const roomId = String(data.roomId || '').trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return reply(cb, { success: false, error: '房间不存在' });
      const res = seatPlayer(room, socket, data.name);
      if (!res.ok) return reply(cb, { success: false, error: res.error });
      reply(cb, { success: true, roomId, token: res.token, playerId: res.playerId });
      sync(room);
    });

    // 刷新页面 / 断线重连后回到原座位
    socket.on('resume', (data = {}, cb) => {
      const roomId = String(data.roomId || '').trim().toUpperCase();
      const room = rooms.get(roomId);
      const playerId = room && room.tokens.get(data.token);
      const player = playerId && room.table.getPlayer(playerId);
      if (!player || player.left) return reply(cb, { success: false, error: '座位已失效，请重新加入' });
      attach(room, socket, playerId);
      reply(cb, { success: true, roomId, playerId });
      sync(room);
    });

    socket.on('leaveRoom', (data, cb) => {
      const ctx = currentRoom(socket);
      if (ctx) {
        socket.leave(ctx.room.table.id);
        socket.data = {};
        handleLeave(ctx.room, ctx.playerId);
      }
      reply(cb, { success: true });
    });

    socket.on('startGame', (data, cb) => {
      const ctx = currentRoom(socket);
      if (!ctx) return reply(cb, { success: false, error: '你不在房间中' });
      const { room, playerId } = ctx;
      if (!canControl(room, playerId)) return reply(cb, { success: false, error: '只有房主可以开始游戏' });
      if (room.table.isHandLive()) return reply(cb, { success: false, error: '牌局进行中' });
      const res = startNextHand(room);
      reply(cb, res.ok ? { success: true } : { success: false, error: res.error });
    });

    // 摊牌后立即开下一局（不等倒计时）
    socket.on('nextHand', (data, cb) => {
      const ctx = currentRoom(socket);
      if (!ctx) return reply(cb, { success: false, error: '你不在房间中' });
      const { room, playerId } = ctx;
      if (room.table.phase !== PHASE.SHOWDOWN) return reply(cb, { success: false, error: '这局还没结束' });
      if (!canControl(room, playerId)) return reply(cb, { success: false, error: '只有房主可以开始下一局' });
      const res = startNextHand(room);
      reply(cb, res.ok ? { success: true } : { success: false, error: res.error });
    });

    socket.on('playerAction', (data = {}, cb) => {
      const ctx = currentRoom(socket);
      if (!ctx) return reply(cb, { success: false, error: '你不在房间中' });
      const res = ctx.room.table.act(ctx.playerId, data.action, data.amount);
      reply(cb, res.ok ? { success: true } : { success: false, error: res.error });
      if (res.ok) sync(ctx.room);
    });

    socket.on('rebuy', (data, cb) => {
      const ctx = currentRoom(socket);
      if (!ctx) return reply(cb, { success: false, error: '你不在房间中' });
      const res = ctx.room.table.rebuy(ctx.playerId);
      reply(cb, res.ok ? { success: true } : { success: false, error: res.error });
      if (res.ok) sync(ctx.room);
    });

    socket.on('sitIn', (data, cb) => {
      const ctx = currentRoom(socket);
      if (!ctx) return reply(cb, { success: false, error: '你不在房间中' });
      const res = ctx.room.table.sitIn(ctx.playerId);
      reply(cb, res.ok ? { success: true } : { success: false, error: res.error });
      if (res.ok) sync(ctx.room);
    });

    socket.on('disconnect', () => {
      const ctx = currentRoom(socket);
      if (!ctx) return;
      const { room, playerId } = ctx;
      const { table, timers } = room;
      table.setConnected(playerId, false);

      // 给一段时间刷新/重连回来，否则移出房间，避免一直占座
      const awaySecs = table.phase === PHASE.WAITING ? cfg.lobbyDisconnectSeconds : cfg.gameDisconnectSeconds;
      clearTimeout(timers.away.get(playerId));
      timers.away.set(playerId, setTimeout(() => {
        timers.away.delete(playerId);
        const p = table.getPlayer(playerId);
        if (p && !p.connected && rooms.has(table.id)) handleLeave(room, playerId);
      }, awaySecs * 1000));

      if (table.players.every(p => !p.connected) && !timers.empty) {
        timers.empty = setTimeout(() => {
          if (table.players.every(p => !p.connected)) deleteRoom(room);
        }, cfg.emptyRoomSeconds * 1000);
      }

      // 掉线的是当前行动者时，缩短其行动时限
      if (table.isHandLive() && table.players[table.currentPlayerIndex]?.id === playerId) {
        timers.turnKey = null;
      }
      sync(room);
    });
  });

  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createPokerServer();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
  });
}

module.exports = { createPokerServer };
