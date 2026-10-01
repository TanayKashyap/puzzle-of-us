import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import {
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_PLAYERS,
  PIECE_COUNTS,
  PLAYER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_TTL_MS,
  WORLD_H,
  WORLD_W,
  clampToWorld,
  computeLayout,
  isOverBoard,
  mulberry32,
  randRange,
  randomSeed,
  slotPosition,
  snapDistance,
  tabPad,
  type ClientToServerEvents,
  type CreateRoomAck,
  type InterServerEvents,
  type JoinRoomAck,
  type Layout,
  type PieceCount,
  type PieceState,
  type PlayerId,
  type PlayerInfo,
  type RoomCode,
  type RoomState,
  type ServerToClientEvents,
  type SocketData,
  type StartPayload,
} from '../../shared/types';
import type { IO } from './index';

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

interface Player extends PlayerInfo {
  /** Socket currently bound to this player, or null while disconnected. */
  socketId: string | null;
}

interface Room extends Omit<RoomState, 'players'> {
  players: Player[];
  layout: Layout | null;
  deleteTimer: NodeJS.Timeout | null;
}

const rooms = new Map<RoomCode, Room>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPieceCount(v: unknown): v is PieceCount {
  return (PIECE_COUNTS as readonly unknown[]).includes(v);
}

function generateRoomCode(): RoomCode {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function publicPlayer(p: Player): PlayerInfo {
  return { id: p.id, color: p.color, isHost: p.isHost, connected: p.connected };
}

function toState(room: Room): RoomState {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(publicPlayer),
    image: room.image,
    imageW: room.imageW,
    imageH: room.imageH,
    pieceCount: room.pieceCount,
    game: room.game,
  };
}

/**
 * Allowed top-left ranges in the margins around the board, such that the piece
 * cell plus its tab overhang never overlaps the board and stays inside the world.
 * Left/right bands span the full height; top/bottom bands fill the gap between them.
 */
function marginBands(layout: Layout): { x0: number; x1: number; y0: number; y1: number; area: number }[] {
  const { board, pieceW, pieceH } = layout;
  const pad = tabPad(layout);
  const gap = 4;
  const minX = pad;
  const maxX = WORLD_W - pieceW - pad;
  const minY = pad;
  const maxY = WORLD_H - pieceH - pad;
  const leftX1 = board.x - pieceW - pad - gap;
  const rightX0 = board.x + board.w + pad + gap;
  const topY1 = board.y - pieceH - pad - gap;
  const bottomY0 = board.y + board.h + pad + gap;
  const innerX0 = Math.max(minX, leftX1);
  const innerX1 = Math.min(maxX, rightX0);
  const raw = [
    { x0: minX, x1: leftX1, y0: minY, y1: maxY },
    { x0: rightX0, x1: maxX, y0: minY, y1: maxY },
    { x0: innerX0, x1: innerX1, y0: minY, y1: topY1 },
    { x0: innerX0, x1: innerX1, y0: bottomY0, y1: maxY },
  ];
  return raw
    .filter((b) => b.x1 >= b.x0 && b.y1 >= b.y0)
    .map((b) => ({ ...b, area: (b.x1 - b.x0 + pieceW) * (b.y1 - b.y0 + pieceH) }));
}

function randomMarginPoint(layout: Layout, rand: () => number): { x: number; y: number } {
  const bands = marginBands(layout);
  if (bands.length === 0) {
    // No room around the board (should not happen with the fixed BOARD_AREA): anywhere in the world.
    return clampToWorld(layout, rand() * WORLD_W, rand() * WORLD_H);
  }
  const total = bands.reduce((s, b) => s + b.area, 0);
  let pick = rand() * total;
  let band = bands[bands.length - 1];
  for (const b of bands) {
    if (pick < b.area) {
      band = b;
      break;
    }
    pick -= b.area;
  }
  return clampToWorld(layout, randRange(rand, band.x0, band.x1), randRange(rand, band.y0, band.y1));
}

/** Best-of-k candidate sampling: pick the margin point farthest from existing pieces. */
function pickPilePosition(
  layout: Layout,
  rand: () => number,
  others: { x: number; y: number }[],
): { x: number; y: number } {
  const candidates = others.length === 0 ? 1 : 16;
  let best = randomMarginPoint(layout, rand);
  let bestDist = -1;
  for (let i = 0; i < candidates; i++) {
    const c = i === 0 ? best : randomMarginPoint(layout, rand);
    let d = Infinity;
    for (const o of others) {
      const dx = (c.x - o.x) / layout.pieceW;
      const dy = (c.y - o.y) / layout.pieceH;
      d = Math.min(d, dx * dx + dy * dy);
    }
    if (d > bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function startGame(io: IO, room: Room): void {
  const seed = randomSeed();
  const layout = computeLayout(room.pieceCount, room.imageW, room.imageH);
  const rand = mulberry32(seed);
  const pieces: PieceState[] = [];
  for (let id = 0; id < layout.cols * layout.rows; id++) {
    const pos = pickPilePosition(layout, rand, pieces);
    pieces.push({ id, x: pos.x, y: pos.y, placed: false, heldBy: null });
  }
  const startedAt = Date.now();
  room.layout = layout;
  room.phase = 'playing';
  room.game = { seed, cols: layout.cols, rows: layout.rows, pieces, startedAt, elapsedMs: null };
  const payload: StartPayload = {
    seed,
    image: room.image,
    imageW: room.imageW,
    imageH: room.imageH,
    pieceCount: room.pieceCount,
    cols: layout.cols,
    rows: layout.rows,
    pieces,
    startedAt,
  };
  io.to(room.code).emit('start', payload);
}

function scheduleDeletionIfEmpty(room: Room): void {
  if (room.players.some((p) => p.connected) || room.deleteTimer) return;
  room.deleteTimer = setTimeout(() => {
    if (rooms.get(room.code) === room && !room.players.some((p) => p.connected)) {
      rooms.delete(room.code);
    }
  }, ROOM_TTL_MS);
  room.deleteTimer.unref?.();
}

function cancelDeletion(room: Room): void {
  if (room.deleteTimer) {
    clearTimeout(room.deleteTimer);
    room.deleteTimer = null;
  }
}

/** Release every piece held by playerId, notifying the room. */
function releaseHeldBy(io: IO, room: Room, playerId: PlayerId): void {
  if (!room.game) return;
  for (const piece of room.game.pieces) {
    if (piece.heldBy === playerId) {
      piece.heldBy = null;
      io.to(room.code).emit('pieceReleased', { pieceId: piece.id, x: piece.x, y: piece.y });
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerRoomHandlers(io: IO, socket: GameSocket): void {
  /** Room + player bound to this socket, if the binding is still current. */
  function current(): { room: Room; player: Player } | null {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return null;
    const room = rooms.get(roomCode);
    const player = room?.players.find((p) => p.id === playerId);
    if (!room || !player || player.socketId !== socket.id) return null;
    return { room, player };
  }

  /** Unbind this socket from whatever room it is in (disconnect or switching rooms). */
  function leaveCurrent(): void {
    const cur = current();
    const prevCode = socket.data.roomCode;
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    if (prevCode) socket.leave(prevCode);
    if (!cur) return;
    const { room, player } = cur;
    releaseHeldBy(io, room, player.id);
    player.connected = false;
    player.socketId = null;
    io.to(room.code).emit('playerLeft', player.id);
    scheduleDeletionIfEmpty(room);
  }

  function bind(room: Room, player: Player): void {
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    cancelDeletion(room);
  }

  function getPlayingPiece(pieceId: unknown): { room: Room; player: Player; piece: PieceState; layout: Layout } | null {
    const cur = current();
    if (!cur) return null;
    const { room, player } = cur;
    if (room.phase !== 'playing' || !room.game || !room.layout) return null;
    if (!Number.isInteger(pieceId)) return null;
    const piece = room.game.pieces[pieceId as number];
    if (!piece) return null;
    return { room, player, piece, layout: room.layout };
  }

  socket.on('createRoom', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const reply = ack as (res: CreateRoomAck) => void;
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'invalid_image' });
    const { image, imageW, imageH, pieceCount } = payload;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return reply({ ok: false, error: 'invalid_image' });
    }
    if (image.length > MAX_IMAGE_DATA_URL_LENGTH) return reply({ ok: false, error: 'image_too_large' });
    if (!isFiniteNumber(imageW) || !isFiniteNumber(imageH) || imageW <= 0 || imageH <= 0) {
      return reply({ ok: false, error: 'invalid_image' });
    }
    if (!isPieceCount(pieceCount)) return reply({ ok: false, error: 'invalid_piece_count' });

    leaveCurrent();
    const host: Player = { id: randomUUID(), color: PLAYER_COLORS[0], isHost: true, connected: true, socketId: null };
    const room: Room = {
      code: generateRoomCode(),
      phase: 'waiting',
      players: [host],
      image,
      imageW,
      imageH,
      pieceCount,
      game: null,
      layout: null,
      deleteTimer: null,
    };
    rooms.set(room.code, room);
    bind(room, host);
    reply({ ok: true, roomCode: room.code, playerId: host.id, state: toState(room) });
  });

  socket.on('joinRoom', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const reply = ack as (res: JoinRoomAck) => void;
    if (!payload || typeof payload !== 'object' || typeof payload.roomCode !== 'string') {
      return reply({ ok: false, error: 'not_found' });
    }
    const code = payload.roomCode.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'not_found' });

    const existing =
      typeof payload.playerId === 'string' ? room.players.find((p) => p.id === payload.playerId) : undefined;

    if (existing) {
      if (existing.socketId === socket.id) {
        return reply({ ok: true, playerId: existing.id, state: toState(room) });
      }
      if (socket.data.roomCode) leaveCurrent();
      // Kick a stale socket still bound to this player (e.g. an old tab).
      if (existing.socketId) {
        const old = io.sockets.sockets.get(existing.socketId);
        if (old) {
          old.leave(room.code);
          old.data.roomCode = undefined;
          old.data.playerId = undefined;
        }
      }
      releaseHeldBy(io, room, existing.id);
      bind(room, existing);
      io.to(room.code).emit('playerJoined', publicPlayer(existing));
      return reply({ ok: true, playerId: existing.id, state: toState(room) });
    }

    if (room.players.length >= MAX_PLAYERS) return reply({ ok: false, error: 'full' });

    if (socket.data.roomCode) leaveCurrent();
    const guest: Player = {
      id: randomUUID(),
      // The seat may have been freed by leaveRoom, so pick a color nobody is using.
      color: PLAYER_COLORS.find((c) => !room.players.some((p) => p.color === c)) ?? PLAYER_COLORS[1],
      isHost: false,
      connected: true,
      socketId: null,
    };
    room.players.push(guest);
    bind(room, guest);
    io.to(room.code).emit('playerJoined', publicPlayer(guest));
    // Ack first so the guest has its room state before `start` arrives and plays the explosion.
    reply({ ok: true, playerId: guest.id, state: toState(room) });
    if (room.phase === 'waiting' && room.players.length >= MAX_PLAYERS) startGame(io, room);
  });

  socket.on('grab', (pieceId) => {
    const ctx = getPlayingPiece(pieceId);
    if (!ctx) return;
    const { room, player, piece } = ctx;
    if (piece.placed || (piece.heldBy !== null && piece.heldBy !== player.id)) {
      socket.emit('grabDenied', { pieceId: piece.id, heldBy: piece.placed ? null : piece.heldBy });
      return;
    }
    if (piece.heldBy === player.id) return;
    for (const other of room.game!.pieces) {
      if (other.heldBy === player.id) {
        other.heldBy = null;
        io.to(room.code).emit('pieceReleased', { pieceId: other.id, x: other.x, y: other.y });
      }
    }
    piece.heldBy = player.id;
    io.to(room.code).emit('pieceGrabbed', { pieceId: piece.id, playerId: player.id });
  });

  socket.on('move', (pieceId, x, y) => {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return;
    const ctx = getPlayingPiece(pieceId);
    if (!ctx || ctx.piece.heldBy !== ctx.player.id) return;
    const { room, player, piece, layout } = ctx;
    const pos = clampToWorld(layout, x, y);
    piece.x = pos.x;
    piece.y = pos.y;
    socket.to(room.code).emit('pieceMoved', { pieceId: piece.id, playerId: player.id, x: pos.x, y: pos.y });
  });

  socket.on('drop', (pieceId, x, y) => {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return;
    const ctx = getPlayingPiece(pieceId);
    if (!ctx || ctx.piece.heldBy !== ctx.player.id) return;
    const { room, player, piece, layout } = ctx;
    const game = room.game!;
    const slot = slotPosition(layout, piece.id);
    let result: 'snapped' | 'rejected' | 'free';
    if (Math.hypot(x - slot.x, y - slot.y) <= snapDistance(layout)) {
      result = 'snapped';
      piece.x = slot.x;
      piece.y = slot.y;
      piece.placed = true;
    } else if (isOverBoard(layout, x, y)) {
      result = 'rejected';
      const others = game.pieces.filter((p) => p !== piece && !p.placed);
      const pos = pickPilePosition(layout, Math.random, others);
      piece.x = pos.x;
      piece.y = pos.y;
    } else {
      result = 'free';
      const pos = clampToWorld(layout, x, y);
      piece.x = pos.x;
      piece.y = pos.y;
    }
    piece.heldBy = null;
    io.to(room.code).emit('dropResult', { pieceId: piece.id, playerId: player.id, result, x: piece.x, y: piece.y });

    if (result === 'snapped' && game.pieces.every((p) => p.placed)) {
      room.phase = 'won';
      game.elapsedMs = Date.now() - game.startedAt;
      io.to(room.code).emit('win', { elapsedMs: game.elapsedMs });
    }
  });

  socket.on('playAgain', (pieceCount) => {
    const cur = current();
    if (!cur || cur.room.phase !== 'won') return;
    if (pieceCount !== undefined && pieceCount !== null && !isPieceCount(pieceCount)) return;
    if (isPieceCount(pieceCount)) cur.room.pieceCount = pieceCount;
    startGame(io, cur.room);
  });

  socket.on('leaveRoom', (payload, ack) => {
    const code = typeof payload?.roomCode === 'string' ? payload.roomCode.trim().toUpperCase() : '';
    const room = rooms.get(code);
    const player =
      typeof payload?.playerId === 'string' ? room?.players.find((p) => p.id === payload.playerId) : undefined;
    if (socket.data.roomCode === code) {
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      socket.leave(code);
    }
    if (room && player) {
      // Unbind whichever socket currently holds this seat (normally this one).
      const bound = player.socketId ? io.sockets.sockets.get(player.socketId) : undefined;
      if (bound && bound.data.roomCode === room.code && bound.data.playerId === player.id) {
        bound.data.roomCode = undefined;
        bound.data.playerId = undefined;
        bound.leave(room.code);
      }
      releaseHeldBy(io, room, player.id);
      room.players = room.players.filter((p) => p !== player);
      if (room.players.length === 0) {
        cancelDeletion(room);
        rooms.delete(room.code);
      } else {
        io.to(room.code).emit('partnerExited', player.id);
        scheduleDeletionIfEmpty(room);
      }
    }
    if (typeof ack === 'function') ack();
  });

  socket.on('disconnect', () => {
    leaveCurrent();
  });
}
