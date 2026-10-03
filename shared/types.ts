/**
 * Shared contract between server and client.
 *
 * COORDINATE CONVENTION (read this first):
 * - Everything lives in a fixed world space of WORLD_W x WORLD_H units, origin
 *   top-left, +x right, +y down. Each client scales the world to fit its window.
 * - A piece position (x, y) is the TOP-LEFT CORNER OF THE PIECE'S GRID CELL in
 *   world space, i.e. the rectangle WITHOUT tab overhang. A piece is correctly
 *   placed when (x, y) === slotPosition(layout, id).
 * - Jigsaw tabs stick out of the cell by up to TAB_PAD_RATIO * min(pieceW, pieceH)
 *   on each side. The client draws each piece canvas with that padding and offsets
 *   it by -pad, but the logical position stays the cell top-left.
 *
 * PIECE IDS: id = row * cols + col (row-major, 0-based).
 *
 * SHARE LINK: `${origin}/?room=CODE`. The client stores its playerId per room under
 * `puzzle-player:${CODE}` (sessionStorage per tab, localStorage as a fallback when
 * the room is full) and sends it with joinRoom to rejoin.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORLD_W = 1600;
export const WORLD_H = 1000;

/** Max distance (world units) between drop position and slot position to snap. See snapDistance(). */
export const SNAP_DISTANCE = 25;
/** Snap radius never exceeds this fraction of min(pieceW, pieceH). */
export const SNAP_PIECE_RATIO = 0.35;

/**
 * Difficulty choices: the MINIMUM number of pieces. The actual count is
 * cols * rows from computeGrid, which may be up to GRID_COUNT_SLACK higher so
 * that cells stay close to square for any photo aspect.
 */
export const PIECE_COUNTS = [48, 96, 150, 200] as const;
export type PieceCount = (typeof PIECE_COUNTS)[number];
export const DEFAULT_PIECE_COUNT: PieceCount = 48;
export const DIFFICULTY_LABELS: Record<PieceCount, string> = { 48: 'Easy', 96: 'Medium', 150: 'Hard', 200: 'Expert' };
/** computeGrid may exceed the requested count by at most this fraction. */
export const GRID_COUNT_SLACK = 0.1;

/** Client downscales uploads so the long side is at most this many pixels. */
export const MAX_IMAGE_LONG_SIDE = 1200;
/** Max accepted image data URL length (chars). Server rejects larger payloads. */
export const MAX_IMAGE_DATA_URL_LENGTH = 6 * 1024 * 1024;
/** Socket.IO maxHttpBufferSize; must exceed MAX_IMAGE_DATA_URL_LENGTH. */
export const SOCKET_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The area the board (slot outlines) may occupy, centered in the world.
 * The actual board is the image fitted inside this rect (see computeLayout).
 * The margins around it are where scattered / pile pieces go.
 */
export const BOARD_AREA: Rect = {
  x: (WORLD_W - 900) / 2,
  y: (WORLD_H - 620) / 2,
  w: 900,
  h: 620,
};

/** Tab overhang as a fraction of min(pieceW, pieceH). Clients pad canvases by this. */
export const TAB_PAD_RATIO = 0.25;

export const MAX_PLAYERS = 2;
export const PLAYER_COLORS = ['#ff5a7a', '#3ab0ff'] as const;
export const ROOM_CODE_LENGTH = 5;
/** Alphabet for room codes (no ambiguous characters like 0/O, 1/I). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** How long an empty / fully-disconnected room is kept for rejoin. */
export const ROOM_TTL_MS = 5 * 60 * 1000;
/** Client throttle for `move` emits while dragging (~30/s). */
export const MOVE_THROTTLE_MS = 33;
/** Duration of the wrong-drop jiggle before the piece flies back to the pile. */
export const JIGGLE_MS = 400;

// ---------------------------------------------------------------------------
// Geometry / layout helpers (server and client MUST use these to agree)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  cols: number;
  rows: number;
  /** Board rect in world space: the image fitted & centered inside BOARD_AREA. */
  board: Rect;
  /** Size of one grid cell in world units (cols * pieceW === board.w). */
  pieceW: number;
  pieceH: number;
}

/**
 * Choose cols x rows with pieceCount <= cols * rows <= pieceCount * (1 + GRID_COUNT_SLACK),
 * trading off how square the cells are (for image aspect w / h) against extra pieces.
 * E.g. 200 pieces on a square photo gives 14x15 = 210 instead of 20x10 (2:1 cells).
 */
export function computeGrid(pieceCount: number, imageAspect: number): { cols: number; rows: number } {
  const maxCount = Math.floor(pieceCount * (1 + GRID_COUNT_SLACK));
  let best = { cols: pieceCount, rows: 1 };
  let bestScore = Infinity;
  for (let rows = 1; rows <= maxCount; rows++) {
    const minCols = Math.ceil(pieceCount / rows);
    const maxCols = Math.floor(maxCount / rows);
    for (let cols = minCols; cols <= maxCols; cols++) {
      const cellAspect = (imageAspect * rows) / cols;
      const score = Math.abs(Math.log(cellAspect)) + (1.5 * (cols * rows - pieceCount)) / pieceCount;
      if (score < bestScore) {
        bestScore = score;
        best = { cols, rows };
      }
    }
  }
  return best;
}

/** Full layout from piece count and image pixel size. Deterministic. */
export function computeLayout(pieceCount: number, imageW: number, imageH: number): Layout {
  const aspect = imageW / imageH;
  const { cols, rows } = computeGrid(pieceCount, aspect);
  const scale = Math.min(BOARD_AREA.w / imageW, BOARD_AREA.h / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  const board: Rect = {
    x: BOARD_AREA.x + (BOARD_AREA.w - w) / 2,
    y: BOARD_AREA.y + (BOARD_AREA.h - h) / 2,
    w,
    h,
  };
  return { cols, rows, board, pieceW: w / cols, pieceH: h / rows };
}

/** Correct (snapped) top-left position of a piece in world space. */
export function slotPosition(layout: Layout, pieceId: number): { x: number; y: number } {
  const col = pieceId % layout.cols;
  const row = Math.floor(pieceId / layout.cols);
  return { x: layout.board.x + col * layout.pieceW, y: layout.board.y + row * layout.pieceH };
}

/** Snap radius for this layout: small pieces get a tighter radius. */
export function snapDistance(layout: Layout): number {
  return Math.min(SNAP_DISTANCE, SNAP_PIECE_RATIO * Math.min(layout.pieceW, layout.pieceH));
}

/** Tab overhang in world units for this layout. */
export function tabPad(layout: Layout): number {
  return TAB_PAD_RATIO * Math.min(layout.pieceW, layout.pieceH);
}

/** True if the piece's CENTER (given its top-left x, y) lies inside the board rect. */
export function isOverBoard(layout: Layout, x: number, y: number): boolean {
  const cx = x + layout.pieceW / 2;
  const cy = y + layout.pieceH / 2;
  const b = layout.board;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}

/** Clamp a top-left position so the piece cell stays fully inside the world. */
export function clampToWorld(layout: Layout, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, 0), WORLD_W - layout.pieceW),
    y: Math.min(Math.max(y, 0), WORLD_H - layout.pieceH),
  };
}

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/** mulberry32: fast deterministic PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in [min, max) from a PRNG. */
export function randRange(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

/** Random uint32 seed (non-deterministic; for the server to pick a seed). */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type PlayerId = string;
export type RoomCode = string;

export interface PlayerInfo {
  id: PlayerId;
  /** One of PLAYER_COLORS; used to highlight pieces this player holds. */
  color: string;
  isHost: boolean;
  /** False while the player is disconnected but still within the rejoin window. */
  connected: boolean;
}

export interface PieceState {
  /** row * cols + col */
  id: number;
  /** Top-left of the piece cell in world space (see convention at top of file). */
  x: number;
  y: number;
  /** Snapped into its slot; permanently locked, cannot be grabbed. */
  placed: boolean;
  /** Player currently dragging this piece, or null. */
  heldBy: PlayerId | null;
}

export type RoomPhase = 'waiting' | 'playing' | 'won';

export interface GameState {
  seed: number;
  cols: number;
  rows: number;
  /** Indexed by piece id (pieces[i].id === i). */
  pieces: PieceState[];
  /** Server epoch ms when the game started. */
  startedAt: number;
  /** Set once phase === 'won'. */
  elapsedMs: number | null;
}

export interface RoomState {
  code: RoomCode;
  phase: RoomPhase;
  players: PlayerInfo[];
  /** Image as a data URL (already downscaled by the host client). */
  image: string;
  /** Image pixel size, so both sides compute identical layouts. */
  imageW: number;
  imageH: number;
  /** Requested difficulty; the actual piece count is game.cols * game.rows. */
  pieceCount: PieceCount;
  /** null while phase === 'waiting'. */
  game: GameState | null;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface CreateRoomPayload {
  /** Data URL (e.g. image/jpeg), long side <= MAX_IMAGE_LONG_SIDE. */
  image: string;
  imageW: number;
  imageH: number;
  pieceCount: PieceCount;
}

export type CreateRoomError = 'invalid_image' | 'image_too_large' | 'invalid_piece_count';

export type CreateRoomAck =
  | { ok: true; roomCode: RoomCode; playerId: PlayerId; state: RoomState }
  | { ok: false; error: CreateRoomError };

export interface JoinRoomPayload {
  roomCode: RoomCode;
  /** Send the stored id to rejoin as the same player (host or guest). */
  playerId?: PlayerId;
}

export type JoinRoomError = 'not_found' | 'full';

export interface LeaveRoomPayload {
  roomCode: RoomCode;
  playerId: PlayerId;
}

export type JoinRoomAck =
  | { ok: true; playerId: PlayerId; state: RoomState }
  | { ok: false; error: JoinRoomError };

/** Sent to both players when the game starts (and again after playAgain). */
export interface StartPayload {
  seed: number;
  image: string;
  imageW: number;
  imageH: number;
  pieceCount: PieceCount;
  cols: number;
  rows: number;
  /**
   * Pieces at their SCATTER positions (explosion targets). Clients animate
   * from the board center outward to these positions.
   */
  pieces: PieceState[];
  startedAt: number;
}

export interface PieceGrabbedPayload {
  pieceId: number;
  playerId: PlayerId;
}

export interface GrabDeniedPayload {
  pieceId: number;
  /** Who holds it, or null if denied because it's already placed / invalid. */
  heldBy: PlayerId | null;
}

export interface PieceMovedPayload {
  pieceId: number;
  playerId: PlayerId;
  x: number;
  y: number;
}

/**
 * - snapped:  x, y = exact slot position; piece.placed = true.
 * - rejected: dropped on the board in the wrong spot. x, y = the PILE position
 *             the piece returns to. Clients jiggle for JIGGLE_MS at the drop
 *             spot, then animate to (x, y).
 * - free:     dropped off the board; x, y = where it stays (clamped to world).
 */
export type DropResultKind = 'snapped' | 'rejected' | 'free';

export interface DropResultPayload {
  pieceId: number;
  playerId: PlayerId;
  result: DropResultKind;
  x: number;
  y: number;
}

/** Piece released without a drop (e.g. holder disconnected). */
export interface PieceReleasedPayload {
  pieceId: number;
  x: number;
  y: number;
}

export interface WinPayload {
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Creates a room; the creator becomes host and is auto-joined to it. */
  createRoom: (payload: CreateRoomPayload, ack: (res: CreateRoomAck) => void) => void;
  /** Join (or rejoin with playerId). When the 2nd player joins a waiting room, server emits `start`. */
  joinRoom: (payload: JoinRoomPayload, ack: (res: JoinRoomAck) => void) => void;
  /** Request the lock on a piece. Server replies pieceGrabbed (to room) or grabDenied (to sender). */
  grab: (pieceId: number) => void;
  /** Throttled drag updates (top-left, world space). Only valid while holding the piece. */
  move: (pieceId: number, x: number, y: number) => void;
  /** Release a held piece at (x, y). Server broadcasts dropResult to the room. */
  drop: (pieceId: number, x: number, y: number) => void;
  /** After a win: restart with a new seed (same image). Optional new difficulty. */
  playAgain: (pieceCount?: PieceCount) => void;
  /**
   * Leave the room for good (the Exit button). The server releases held pieces,
   * removes the player's seat, emits `partnerExited` to whoever remains, and
   * deletes the room once nobody is left. A new player can take the free seat.
   * The payload identifies the seat so an exit buffered while the socket was
   * reconnecting still works. The ack fires once the server has processed it.
   */
  leaveRoom: (payload: LeaveRoomPayload, ack?: () => void) => void;
}

export interface ServerToClientEvents {
  /** A player joined or reconnected (connected = true). */
  playerJoined: (player: PlayerInfo) => void;
  /** A player disconnected (still within the rejoin window). */
  playerLeft: (playerId: PlayerId) => void;
  /** A player exited on purpose (leaveRoom); their seat is gone and can be taken by a new player. */
  partnerExited: (playerId: PlayerId) => void;
  start: (payload: StartPayload) => void;
  pieceGrabbed: (payload: PieceGrabbedPayload) => void;
  grabDenied: (payload: GrabDeniedPayload) => void;
  /** Relayed to the OTHER player only (sender already shows its own drag). */
  pieceMoved: (payload: PieceMovedPayload) => void;
  dropResult: (payload: DropResultPayload) => void;
  pieceReleased: (payload: PieceReleasedPayload) => void;
  win: (payload: WinPayload) => void;
}

export interface InterServerEvents {}

/** Per-socket data stored by the server (socket.data). */
export interface SocketData {
  roomCode?: RoomCode;
  playerId?: PlayerId;
}
