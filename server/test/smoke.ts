/**
 * Server smoke test: runs the room handlers on an ephemeral port and plays a
 * full 12-piece game with two socket.io clients.  Run: npm run test:server
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import {
  SOCKET_MAX_BUFFER,
  computeLayout,
  isOverBoard,
  slotPosition,
  tabPad,
  type ClientToServerEvents,
  type CreateRoomAck,
  type DropResultPayload,
  type JoinRoomAck,
  type ServerToClientEvents,
  type StartPayload,
  type WinPayload,
} from '../../shared/types';
import type { IO } from '../src/index';
import { registerRoomHandlers } from '../src/rooms';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  console.log(`  ok - ${msg}`);
}

function once<T>(sock: Client, event: keyof ServerToClientEvents, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), timeoutMs);
    (sock as unknown as { once: (e: string, cb: (v: T) => void) => void }).once(event, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

async function main(): Promise<void> {
  const httpServer = createServer();
  const io: IO = new Server(httpServer, { maxHttpBufferSize: SOCKET_MAX_BUFFER });
  io.on('connection', (socket) => registerRoomHandlers(io, socket));
  await new Promise<void>((r) => httpServer.listen(0, r));
  const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

  const a: Client = connect(url, { transports: ['websocket'] });
  const b: Client = connect(url, { transports: ['websocket'] });
  const c: Client = connect(url, { transports: ['websocket'] });

  try {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const imageW = 400;
    const imageH = 300;

    const bad = await a.emitWithAck('createRoom', { image: 'nope', imageW, imageH, pieceCount: 12 });
    assert(!bad.ok && bad.error === 'invalid_image', 'rejects non data URL');
    const badCount = await a.emitWithAck('createRoom', { image, imageW, imageH, pieceCount: 13 as 12 });
    assert(!badCount.ok && badCount.error === 'invalid_piece_count', 'rejects bad piece count');

    const created: CreateRoomAck = await a.emitWithAck('createRoom', { image, imageW, imageH, pieceCount: 12 });
    assert(created.ok, 'createRoom ok');
    if (!created.ok) return;
    assert(created.state.phase === 'waiting' && created.state.players.length === 1, 'room waiting with host');
    const code = created.roomCode;

    const notFound = await b.emitWithAck('joinRoom', { roomCode: 'ZZZZZ' });
    assert(!notFound.ok && notFound.error === 'not_found', 'unknown code -> not_found');

    const startA = once<StartPayload>(a, 'start');
    const startB = once<StartPayload>(b, 'start');
    const joined: JoinRoomAck = await b.emitWithAck('joinRoom', { roomCode: code.toLowerCase() });
    assert(joined.ok, 'guest joins (lowercase code)');
    if (!joined.ok) return;
    const [start] = await Promise.all([startA, startB]);
    assert(start.pieces.length === 12 && start.cols * start.rows === 12, 'start received with 12 pieces');

    const full = await c.emitWithAck('joinRoom', { roomCode: code });
    assert(!full.ok && full.error === 'full', 'third player -> full');

    const layout = computeLayout(12, imageW, imageH);
    const pad = tabPad(layout);
    const b0 = layout.board;
    const scatteredOk = start.pieces.every(
      (p) =>
        p.x + layout.pieceW + pad <= b0.x ||
        p.x - pad >= b0.x + b0.w ||
        p.y + layout.pieceH + pad <= b0.y ||
        p.y - pad >= b0.y + b0.h,
    );
    assert(scatteredOk, 'scatter positions avoid the board (incl. tab pad)');

    // Grab, move, and snap piece 0.
    const grabbed = once<{ pieceId: number; playerId: string }>(b, 'pieceGrabbed');
    a.emit('grab', 0);
    assert((await grabbed).pieceId === 0, 'pieceGrabbed broadcast');

    const denied = once<{ pieceId: number; heldBy: string | null }>(b, 'grabDenied');
    b.emit('grab', 0);
    assert((await denied).heldBy === created.playerId, 'second grab denied');

    const moved = once<{ x: number; y: number }>(b, 'pieceMoved');
    a.emit('move', 0, 700, 50);
    const mv = await moved;
    assert(mv.x === 700 && mv.y === 50, 'pieceMoved relayed to other');

    const s0 = slotPosition(layout, 0);
    let dropped = once<DropResultPayload>(b, 'dropResult');
    a.emit('drop', 0, s0.x + 5, s0.y - 5);
    let dr = await dropped;
    assert(dr.result === 'snapped' && dr.x === s0.x && dr.y === s0.y, 'drop near slot -> snapped');

    // Wrong spot on the board -> rejected back to pile.
    b.emit('grab', 1);
    await once(a, 'pieceGrabbed');
    const wrong = slotPosition(layout, 11);
    dropped = once<DropResultPayload>(a, 'dropResult');
    b.emit('drop', 1, wrong.x, wrong.y);
    dr = await dropped;
    assert(dr.result === 'rejected' && !isOverBoard(layout, dr.x, dr.y), 'wrong board spot -> rejected to pile');

    // Off-board drop -> free.
    b.emit('grab', 1);
    await once(a, 'pieceGrabbed');
    dropped = once<DropResultPayload>(a, 'dropResult');
    b.emit('drop', 1, 20, 20);
    dr = await dropped;
    assert(dr.result === 'free' && dr.x === 20 && dr.y === 20, 'off-board drop -> free');

    // Bad input is ignored silently.
    a.emit('grab', 999);
    a.emit('move', 2, NaN, 1);
    a.emit('drop', 2, 1, 1);

    // Rejoin as host via new socket mid-game.
    a.disconnect();
    const a2: Client = connect(url, { transports: ['websocket'] });
    const rejoin: JoinRoomAck = await a2.emitWithAck('joinRoom', { roomCode: code, playerId: created.playerId });
    assert(rejoin.ok && rejoin.state.phase === 'playing' && rejoin.state.game?.pieces[0].placed, 'host rejoins with game state');

    // Snap the rest; expect win.
    const win = once<WinPayload>(b, 'win', 5000);
    for (let id = 1; id < 12; id++) {
      const who = id % 2 ? b : a2;
      who.emit('grab', id);
      await once(who, 'pieceGrabbed');
      const s = slotPosition(layout, id);
      const r = once<DropResultPayload>(who, 'dropResult');
      who.emit('drop', id, s.x, s.y);
      assert((await r).result === 'snapped', `piece ${id} snapped`);
    }
    const w = await win;
    assert(typeof w.elapsedMs === 'number' && w.elapsedMs >= 0, 'win received');

    const again = once<StartPayload>(b, 'start');
    a2.emit('playAgain', 24);
    const st2 = await again;
    assert(st2.pieces.length === 24 && st2.pieces.every((p) => !p.placed), 'playAgain restarts with 24 pieces');

    a2.disconnect();
    console.log('\nAll smoke tests passed.');
  } finally {
    a.disconnect();
    b.disconnect();
    c.disconnect();
    io.close();
    httpServer.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
