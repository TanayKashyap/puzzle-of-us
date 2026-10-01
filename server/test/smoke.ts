/**
 * Server smoke test: runs the room handlers on an ephemeral port and plays a
 * full 48-piece game with socket.io clients (including a partner leaving and a
 * new player taking the seat).  Run: npm run test:server
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import {
  PIECE_COUNTS,
  SOCKET_MAX_BUFFER,
  WORLD_H,
  WORLD_W,
  computeLayout,
  isOverBoard,
  slotPosition,
  snapDistance,
  tabPad,
  type ClientToServerEvents,
  type CreateRoomAck,
  type DropResultPayload,
  type JoinRoomAck,
  type Layout,
  type PieceCount,
  type PieceReleasedPayload,
  type PieceState,
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

/** Every piece fully in the world (incl. tabs) and its padded footprint clear of the board. */
function scatterOk(layout: Layout, pieces: PieceState[]): boolean {
  const pad = tabPad(layout);
  const b = layout.board;
  return pieces.every(
    (p) =>
      p.x - pad >= -0.001 &&
      p.y - pad >= -0.001 &&
      p.x + layout.pieceW + pad <= WORLD_W + 0.001 &&
      p.y + layout.pieceH + pad <= WORLD_H + 0.001 &&
      (p.x + layout.pieceW + pad <= b.x ||
        p.x - pad >= b.x + b.w ||
        p.y + layout.pieceH + pad <= b.y ||
        p.y - pad >= b.y + b.h),
  );
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
  const extra: Client[] = [];

  try {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const imageW = 400;
    const imageH = 300;
    const N: PieceCount = 48;

    const bad = await a.emitWithAck('createRoom', { image: 'nope', imageW, imageH, pieceCount: N });
    assert(!bad.ok && bad.error === 'invalid_image', 'rejects non data URL');
    const badCount = await a.emitWithAck('createRoom', { image, imageW, imageH, pieceCount: 12 as PieceCount });
    assert(!badCount.ok && badCount.error === 'invalid_piece_count', 'rejects piece count below 48');

    // Every difficulty x common photo aspect: sane grid and a clean scatter.
    for (const count of PIECE_COUNTS) {
      for (const [w, h] of [
        [675, 1200],
        [900, 1200],
        [1000, 1000],
        [1200, 900],
        [1200, 800],
        [1200, 675],
      ]) {
        const h1: Client = connect(url, { transports: ['websocket'] });
        const g1: Client = connect(url, { transports: ['websocket'] });
        extra.push(h1, g1);
        const cr = await h1.emitWithAck('createRoom', { image, imageW: w, imageH: h, pieceCount: count });
        if (!cr.ok) throw new Error('createRoom failed');
        const st = once<StartPayload>(h1, 'start');
        const gj = await g1.emitWithAck('joinRoom', { roomCode: cr.roomCode });
        if (!gj.ok) throw new Error('joinRoom failed');
        const s = await st;
        const layout = computeLayout(count, w, h);
        const cellAspect = layout.pieceW / layout.pieceH;
        assert(
          s.cols === layout.cols &&
            s.rows === layout.rows &&
            s.pieces.length === s.cols * s.rows &&
            s.pieces.length >= count &&
            s.pieces.length <= count * 1.1 &&
            cellAspect > 0.8 &&
            cellAspect < 1.25 &&
            scatterOk(layout, s.pieces),
          `${count} @ ${w}x${h}: ${s.cols}x${s.rows}=${s.pieces.length}, cell ${layout.pieceW.toFixed(1)}x${layout.pieceH.toFixed(1)}, snap ${snapDistance(layout).toFixed(1)}, scatter in-world & off-board`,
        );
        await h1.emitWithAck('leaveRoom', { roomCode: cr.roomCode, playerId: cr.playerId });
        await g1.emitWithAck('leaveRoom', { roomCode: cr.roomCode, playerId: gj.playerId });
        h1.disconnect();
        g1.disconnect();
      }
    }

    const created: CreateRoomAck = await a.emitWithAck('createRoom', { image, imageW, imageH, pieceCount: N });
    assert(created.ok, 'createRoom ok');
    if (!created.ok) return;
    assert(created.state.phase === 'waiting' && created.state.players.length === 1, 'room waiting with host');
    const code = created.roomCode;

    const notFound = await b.emitWithAck('joinRoom', { roomCode: 'ZZZZZ' });
    assert(!notFound.ok && notFound.error === 'not_found', 'unknown code -> not_found');

    const layout = computeLayout(N, imageW, imageH);
    const total = layout.cols * layout.rows;

    const startA = once<StartPayload>(a, 'start');
    const startB = once<StartPayload>(b, 'start');
    const joined: JoinRoomAck = await b.emitWithAck('joinRoom', { roomCode: code.toLowerCase() });
    assert(joined.ok, 'guest joins (lowercase code)');
    if (!joined.ok) return;
    const [start] = await Promise.all([startA, startB]);
    assert(start.pieces.length === total && total >= N, `start received with ${total} pieces`);

    const full = await c.emitWithAck('joinRoom', { roomCode: code });
    assert(!full.ok && full.error === 'full', 'third player -> full');
    assert(scatterOk(layout, start.pieces), 'scatter positions avoid the board (incl. tab pad)');

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

    // Just outside the snap radius -> rejected (on the board, wrong spot).
    const snapR = snapDistance(layout);
    const s0 = slotPosition(layout, 0);
    let dropped = once<DropResultPayload>(b, 'dropResult');
    a.emit('drop', 0, s0.x + snapR + 1, s0.y);
    let dr = await dropped;
    assert(dr.result === 'rejected', `drop ${(snapR + 1).toFixed(1)} from slot (radius ${snapR.toFixed(1)}) -> rejected`);

    a.emit('grab', 0);
    await once(a, 'pieceGrabbed');
    dropped = once<DropResultPayload>(b, 'dropResult');
    a.emit('drop', 0, s0.x + 5, s0.y - 5);
    dr = await dropped;
    assert(dr.result === 'snapped' && dr.x === s0.x && dr.y === s0.y, 'drop near slot -> snapped');

    // Wrong spot on the board -> rejected back to pile.
    b.emit('grab', 1);
    await once(a, 'pieceGrabbed');
    const wrong = slotPosition(layout, total - 1);
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
    extra.push(a2);
    const rejoin: JoinRoomAck = await a2.emitWithAck('joinRoom', { roomCode: code, playerId: created.playerId });
    assert(rejoin.ok && rejoin.state.phase === 'playing' && rejoin.state.game?.pieces[0].placed, 'host rejoins with game state');

    // Guest grabs a piece, then exits for good.
    b.emit('grab', 2);
    await once(a2, 'pieceGrabbed');
    const released = once<PieceReleasedPayload>(a2, 'pieceReleased');
    const exited = once<string>(a2, 'partnerExited');
    await b.emitWithAck('leaveRoom', { roomCode: code, playerId: joined.playerId });
    assert((await released).pieceId === 2, 'leaveRoom releases the held piece');
    assert((await exited) === joined.playerId, 'partnerExited sent to remaining player');
    const stale = await b.emitWithAck('joinRoom', { roomCode: code, playerId: joined.playerId });
    assert(stale.ok && stale.playerId !== joined.playerId, 'old guest id no longer has a seat (joins as new player)');
    const exited2 = once<string>(a2, 'partnerExited');
    await b.emitWithAck('leaveRoom', { roomCode: code, playerId: stale.ok ? stale.playerId : '' });
    await exited2;

    // A new player takes the free seat and gets the current game.
    const cJoined = once<{ id: string }>(a2, 'playerJoined');
    const cj: JoinRoomAck = await c.emitWithAck('joinRoom', { roomCode: code });
    assert(
      cj.ok && cj.state.phase === 'playing' && cj.state.game?.pieces[0].placed && cj.state.players.length === 2,
      'new player takes the empty seat with current game state',
    );
    if (!cj.ok) return;
    assert((await cJoined).id === cj.playerId, 'remaining player notified of the new partner');
    const colors = cj.state.players.map((p) => p.color);
    assert(colors[0] !== colors[1], 'new player gets a different color');

    // Snap the rest; expect win.
    const win = once<WinPayload>(c, 'win', 10000);
    for (let id = 1; id < total; id++) {
      const who = id % 2 ? c : a2;
      who.emit('grab', id);
      await once(who, 'pieceGrabbed');
      const s = slotPosition(layout, id);
      const r = once<DropResultPayload>(who, 'dropResult');
      who.emit('drop', id, s.x, s.y);
      if ((await r).result !== 'snapped') throw new Error(`piece ${id} did not snap`);
    }
    assert(true, `all ${total} pieces snapped`);
    const w = await win;
    assert(typeof w.elapsedMs === 'number' && w.elapsedMs >= 0, 'win received');

    const again = once<StartPayload>(c, 'start');
    a2.emit('playAgain', 96);
    const st2 = await again;
    assert(st2.pieces.length >= 96 && st2.pieces.every((p) => !p.placed), `playAgain restarts with ${st2.pieces.length} pieces`);

    // Both leave -> room deleted.
    await a2.emitWithAck('leaveRoom', { roomCode: code, playerId: created.playerId });
    await c.emitWithAck('leaveRoom', { roomCode: code, playerId: cj.playerId });
    const afterAll = await b.emitWithAck('joinRoom', { roomCode: code });
    assert(!afterAll.ok && afterAll.error === 'not_found', 'room deleted once everyone exits');

    console.log('\nAll smoke tests passed.');
  } finally {
    for (const s of [a, b, c, ...extra]) s.disconnect();
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
