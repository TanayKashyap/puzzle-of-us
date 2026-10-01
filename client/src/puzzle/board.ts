import {
  type DropResultPayload,
  type GrabDeniedPayload,
  type Layout,
  type PieceCount,
  type PieceGrabbedPayload,
  type PieceMovedPayload,
  type PieceReleasedPayload,
  type PieceState,
  type PlayerId,
  JIGGLE_MS,
  MOVE_THROTTLE_MS,
  WORLD_H,
  WORLD_W,
  clampToWorld,
  computeLayout,
  slotPosition,
} from '../../../shared/types';
import type { GameClientSocket } from '../net';
import { type PuzzleCut, buildCut, drawGuideEdges, renderPiece } from './generate';

export interface BoardSetup {
  image: HTMLImageElement;
  imageW: number;
  imageH: number;
  pieceCount: PieceCount;
  seed: number;
  pieces: PieceState[];
}

export interface BoardOptions {
  stage: HTMLElement;
  socket: GameClientSocket;
  myId: PlayerId;
  colorOf: (playerId: PlayerId) => string | undefined;
  onProgress: (placed: number, total: number) => void;
}

interface PieceView {
  id: number;
  el: HTMLDivElement;
  inner: HTMLDivElement;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  placed: boolean;
  heldBy: PlayerId | null;
  /** Local interaction blocked until this time (jiggle / fly-back in progress). */
  busyUntil: number;
  timers: number[];
}

interface DragState {
  piece: PieceView;
  pointerId: number;
  offX: number;
  offY: number;
  lastEmit: number;
  pendingTimer: number;
}

const EXPLODE_MS = 950;
const EXPLODE_STAGGER_MS = 14;
/** Cap on the whole stagger so big puzzles don't take ages to explode. */
const EXPLODE_STAGGER_TOTAL_MS = 1200;
const RETURN_MS = 550;
const SNAP_MS = 220;
const REMOTE_MOVE_TRANSITION = `transform ${MOVE_THROTTLE_MS * 2.5}ms linear`;

export class Board {
  private readonly opts: BoardOptions;
  private readonly setup: BoardSetup;
  private readonly layout: Layout;
  private readonly cut: PuzzleCut;
  private readonly world: HTMLDivElement;
  private readonly guide: HTMLCanvasElement;
  private readonly pieces: PieceView[] = [];
  private readonly hitCtx: CanvasRenderingContext2D;
  /** Pre-grab positions for optimistic grabs not yet confirmed by the server. */
  private readonly pendingGrabs = new Map<number, { x: number; y: number }>();
  private drag: DragState | null = null;
  private scale = 1;
  private renderedPx = 0;
  private zTop = 10;
  private interactiveAt = 0;
  private rerenderTimer = 0;
  private destroyed = false;

  constructor(opts: BoardOptions, setup: BoardSetup, explode: boolean) {
    this.opts = opts;
    this.setup = setup;
    this.layout = computeLayout(setup.pieceCount, setup.imageW, setup.imageH);
    this.cut = buildCut(setup.seed, this.layout);
    this.hitCtx = document.createElement('canvas').getContext('2d')!;

    this.world = document.createElement('div');
    this.world.className = 'world';
    this.world.style.width = `${WORLD_W}px`;
    this.world.style.height = `${WORLD_H}px`;

    const b = this.layout.board;
    const frame = document.createElement('div');
    frame.className = 'board-frame';
    Object.assign(frame.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    this.world.appendChild(frame);

    this.guide = document.createElement('canvas');
    this.guide.className = 'guide';
    Object.assign(this.guide.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    this.world.appendChild(this.guide);

    for (const ps of setup.pieces) this.pieces.push(this.createPiece(ps));

    opts.stage.appendChild(this.world);
    this.world.addEventListener('pointerdown', this.onPointerDown);
    this.world.addEventListener('pointermove', this.onPointerMove);
    this.world.addEventListener('pointerup', this.onPointerUp);
    this.world.addEventListener('pointercancel', this.onPointerUp);
    this.world.addEventListener('lostpointercapture', this.onPointerUp);
    window.addEventListener('resize', this.onResize);

    this.resize();
    this.renderAll();
    if (explode) this.explode();
    else for (const p of this.pieces) this.place(p, p.x, p.y, null);
    this.reportProgress();
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('resize', this.onResize);
    clearTimeout(this.rerenderTimer);
    if (this.drag) clearTimeout(this.drag.pendingTimer);
    for (const p of this.pieces) this.clearTimers(p);
    this.world.remove();
  }

  get placedCount(): number {
    return this.pieces.filter((p) => p.placed).length;
  }

  /** Re-apply holder colors (e.g. after the player list changes). */
  refreshHolders(): void {
    for (const p of this.pieces) this.applyHeld(p);
  }

  // -------------------------------------------------------------------------
  // Setup / rendering
  // -------------------------------------------------------------------------

  private createPiece(ps: PieceState): PieceView {
    const el = document.createElement('div');
    el.className = 'piece';
    const inner = document.createElement('div');
    inner.className = 'piece-inner';
    const canvas = document.createElement('canvas');
    inner.appendChild(canvas);
    el.appendChild(inner);
    this.world.appendChild(el);
    const p: PieceView = {
      id: ps.id,
      el,
      inner,
      canvas,
      x: ps.x,
      y: ps.y,
      placed: ps.placed,
      heldBy: ps.heldBy === this.opts.myId ? null : ps.heldBy,
      busyUntil: 0,
      timers: [],
    };
    this.applyPlaced(p);
    this.applyHeld(p);
    if (!p.placed) el.style.zIndex = String(++this.zTop);
    return p;
  }

  private onResize = (): void => {
    this.resize();
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = window.setTimeout(() => this.renderAll(), 150);
  };

  private resize(): void {
    const { stage } = this.opts;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    this.scale = Math.max(0.05, Math.min(w / WORLD_W, h / WORLD_H));
    const ox = (w - WORLD_W * this.scale) / 2;
    const oy = (h - WORLD_H * this.scale) / 2;
    this.world.style.transform = `translate(${ox}px, ${oy}px) scale(${this.scale})`;
  }

  private renderAll(): void {
    if (this.destroyed) return;
    const px = Math.min(3, Math.max(0.5, this.scale * (window.devicePixelRatio || 1)));
    if (this.renderedPx && Math.abs(px - this.renderedPx) / this.renderedPx < 0.1) return;
    this.renderedPx = px;

    const b = this.layout.board;
    this.guide.width = Math.ceil(b.w * px);
    this.guide.height = Math.ceil(b.h * px);
    const g = this.guide.getContext('2d')!;
    // Slot outlines only: drawing the photo here would give the picture away.
    g.setTransform(px, 0, 0, px, -b.x * px, -b.y * px);
    drawGuideEdges(g, this.cut);

    for (const p of this.pieces) this.renderOne(p);
  }

  private renderOne(p: PieceView): void {
    renderPiece(this.cut, p.id, this.setup.image, this.renderedPx, p.canvas, !p.placed);
  }

  // -------------------------------------------------------------------------
  // Positioning helpers
  // -------------------------------------------------------------------------

  /** Move a piece's element to world (x, y) with an optional CSS transition. */
  private place(p: PieceView, x: number, y: number, transition: string | null): void {
    p.x = x;
    p.y = y;
    p.el.style.transition = transition ?? 'none';
    p.el.style.transform = `translate(${x - this.cut.pad}px, ${y - this.cut.pad}px)`;
  }

  private bringToFront(p: PieceView): void {
    if (!p.placed) p.el.style.zIndex = String(++this.zTop);
  }

  private applyPlaced(p: PieceView): void {
    const changed = p.el.classList.contains('placed') !== p.placed;
    p.el.classList.toggle('placed', p.placed);
    if (p.placed) p.el.style.zIndex = '1';
    if (changed && this.renderedPx) this.renderOne(p);
  }

  private applyHeld(p: PieceView): void {
    const other = p.heldBy !== null && p.heldBy !== this.opts.myId;
    p.el.classList.toggle('held-other', other);
    if (other) p.el.style.setProperty('--holder', this.opts.colorOf(p.heldBy!) ?? '#ffd34d');
  }

  private clearTimers(p: PieceView): void {
    for (const t of p.timers) clearTimeout(t);
    p.timers = [];
  }

  private later(p: PieceView, ms: number, fn: () => void): void {
    p.timers.push(window.setTimeout(fn, ms));
  }

  /** Restart a one-shot CSS animation class on a piece. */
  private flashClass(p: PieceView, cls: string, ms: number): void {
    p.el.classList.remove(cls);
    void p.el.offsetWidth;
    p.el.classList.add(cls);
    this.later(p, ms, () => p.el.classList.remove(cls));
  }

  private reportProgress(): void {
    this.opts.onProgress(this.placedCount, this.pieces.length);
  }

  // -------------------------------------------------------------------------
  // Explosion intro
  // -------------------------------------------------------------------------

  private explode(): void {
    const { board, pieceW, pieceH } = this.layout;
    const cx = board.x + board.w / 2 - pieceW / 2;
    const cy = board.y + board.h / 2 - pieceH / 2;
    const order = this.pieces.map((p) => p.id).sort(() => Math.random() - 0.5);

    const targets = this.pieces.map((p) => ({ x: p.x, y: p.y }));
    for (const p of this.pieces) {
      this.place(p, cx + (Math.random() - 0.5) * 6, cy + (Math.random() - 0.5) * 6, null);
      p.inner.style.transition = 'none';
      p.inner.style.transform = `rotate(${(Math.random() - 0.5) * 50}deg) scale(0.85)`;
    }

    const boom = document.createElement('div');
    boom.className = 'boom';
    boom.style.left = `${board.x + board.w / 2}px`;
    boom.style.top = `${board.y + board.h / 2}px`;
    this.world.appendChild(boom);
    window.setTimeout(() => boom.remove(), 1200);

    for (const p of this.pieces) {
      p.x = targets[p.id].x;
      p.y = targets[p.id].y;
    }

    void this.world.offsetWidth;
    const startDelay = 350;
    const stagger = Math.min(EXPLODE_STAGGER_MS, EXPLODE_STAGGER_TOTAL_MS / Math.max(1, order.length));
    const total = startDelay + order.length * stagger + EXPLODE_MS + 250;
    this.interactiveAt = Infinity;
    // rAF is paused in background tabs; targets use p.x/p.y at that moment so the partner's
    // moves made in the meantime aren't overwritten.
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      order.forEach((id, i) => {
        const p = this.pieces[id];
        const delay = startDelay + i * stagger;
        const spin = (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 480);
        p.el.style.transition = `transform ${EXPLODE_MS}ms cubic-bezier(0.22, 1.35, 0.4, 1) ${delay}ms`;
        p.el.style.transform = `translate(${p.x - this.cut.pad}px, ${p.y - this.cut.pad}px)`;
        p.inner.style.transition = 'none';
        p.inner.style.transform = `rotate(${spin}deg) scale(0.85)`;
        void p.inner.offsetWidth;
        p.inner.style.transition = `transform ${EXPLODE_MS + 250}ms cubic-bezier(0.2, 0.9, 0.3, 1.15) ${delay}ms`;
        p.inner.style.transform = 'rotate(0deg) scale(1)';
      });
      this.interactiveAt = performance.now() + total;
      window.setTimeout(() => {
        if (this.destroyed) return;
        for (const p of this.pieces) {
          p.inner.style.transition = '';
          p.inner.style.transform = '';
        }
      }, total + 50);
    });
  }

  // -------------------------------------------------------------------------
  // Local pointer interaction
  // -------------------------------------------------------------------------

  private toWorld(e: PointerEvent): { x: number; y: number } {
    const r = this.world.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  private hitTest(wx: number, wy: number): PieceView | null {
    const loose = this.pieces.filter((p) => !p.placed);
    loose.sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
    for (const p of loose) {
      const slot = slotPosition(this.layout, p.id);
      if (this.hitCtx.isPointInPath(this.cut.paths[p.id], wx - (p.x - slot.x), wy - (p.y - slot.y))) return p;
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.drag || e.button > 0) return;
    const now = performance.now();
    if (now < this.interactiveAt) return;
    const w = this.toWorld(e);
    const p = this.hitTest(w.x, w.y);
    if (!p || p.heldBy !== null || now < p.busyUntil) return;
    e.preventDefault();

    this.clearTimers(p);
    this.pendingGrabs.set(p.id, { x: p.x, y: p.y });
    p.heldBy = this.opts.myId;
    this.place(p, p.x, p.y, null);
    this.bringToFront(p);
    p.el.classList.add('lifted');
    this.world.setPointerCapture(e.pointerId);
    this.drag = { piece: p, pointerId: e.pointerId, offX: w.x - p.x, offY: w.y - p.y, lastEmit: 0, pendingTimer: 0 };
    this.opts.socket.emit('grab', p.id);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const w = this.toWorld(e);
    const pos = clampToWorld(this.layout, w.x - d.offX, w.y - d.offY);
    this.place(d.piece, pos.x, pos.y, null);
    this.emitMove();
  };

  private emitMove(): void {
    const d = this.drag;
    if (!d) return;
    const now = performance.now();
    const wait = MOVE_THROTTLE_MS - (now - d.lastEmit);
    if (wait <= 0) {
      clearTimeout(d.pendingTimer);
      d.pendingTimer = 0;
      d.lastEmit = now;
      this.opts.socket.emit('move', d.piece.id, d.piece.x, d.piece.y);
    } else if (!d.pendingTimer) {
      d.pendingTimer = window.setTimeout(() => {
        if (this.drag !== d) return;
        d.pendingTimer = 0;
        this.emitMove();
      }, wait);
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    clearTimeout(d.pendingTimer);
    if (this.world.hasPointerCapture(e.pointerId)) this.world.releasePointerCapture(e.pointerId);
    const p = d.piece;
    p.el.classList.remove('lifted');
    // Keep heldBy until dropResult arrives so a quick re-grab can't race the server.
    if (p.heldBy === this.opts.myId) this.opts.socket.emit('drop', p.id, p.x, p.y);
  };

  // -------------------------------------------------------------------------
  // Server events
  // -------------------------------------------------------------------------

  onPieceGrabbed({ pieceId, playerId }: PieceGrabbedPayload): void {
    const p = this.pieces[pieceId];
    if (!p) return;
    if (playerId === this.opts.myId) {
      this.pendingGrabs.delete(pieceId);
      p.heldBy = playerId;
      return;
    }
    this.clearTimers(p);
    p.el.classList.remove('jiggle', 'snap');
    p.heldBy = playerId;
    p.busyUntil = 0;
    this.applyHeld(p);
    this.bringToFront(p);
  }

  onGrabDenied({ pieceId, heldBy }: GrabDeniedPayload): void {
    const p = this.pieces[pieceId];
    if (!p) return;
    const origin = this.pendingGrabs.get(pieceId);
    this.pendingGrabs.delete(pieceId);
    if (this.drag?.piece === p) {
      const d = this.drag;
      this.drag = null;
      clearTimeout(d.pendingTimer);
      if (this.world.hasPointerCapture(d.pointerId)) this.world.releasePointerCapture(d.pointerId);
    }
    p.el.classList.remove('lifted');
    p.heldBy = heldBy === this.opts.myId ? null : heldBy;
    this.applyHeld(p);
    if (origin && !p.placed) this.place(p, origin.x, origin.y, `transform 250ms ease-out`);
    this.flashClass(p, 'denied', 350);
  }

  onPieceMoved({ pieceId, playerId, x, y }: PieceMovedPayload): void {
    const p = this.pieces[pieceId];
    if (!p || p.placed || playerId === this.opts.myId) return;
    if (p.heldBy !== playerId) {
      p.heldBy = playerId;
      this.applyHeld(p);
    }
    this.place(p, x, y, REMOTE_MOVE_TRANSITION);
  }

  onDropResult({ pieceId, playerId, result, x, y }: DropResultPayload): void {
    const p = this.pieces[pieceId];
    if (!p) return;
    this.pendingGrabs.delete(pieceId);
    if (this.drag?.piece === p) {
      // Server dropped it out from under us (shouldn't normally happen).
      clearTimeout(this.drag.pendingTimer);
      this.drag = null;
    }
    this.clearTimers(p);
    p.heldBy = null;
    p.el.classList.remove('lifted', 'jiggle', 'snap');
    this.applyHeld(p);
    const mine = playerId === this.opts.myId;

    if (result === 'snapped') {
      p.placed = true;
      p.busyUntil = Infinity;
      this.place(p, x, y, `transform ${SNAP_MS}ms cubic-bezier(0.3, 1.4, 0.5, 1)`);
      this.later(p, SNAP_MS * 0.6, () => this.applyPlaced(p));
      this.flashClass(p, 'snap', 750);
      this.reportProgress();
      return;
    }

    if (result === 'rejected') {
      if (!mine) this.place(p, p.x, p.y, null);
      p.busyUntil = performance.now() + JIGGLE_MS + RETURN_MS;
      p.el.style.setProperty('--jiggle-ms', `${JIGGLE_MS}ms`);
      this.flashClass(p, 'jiggle', JIGGLE_MS);
      this.later(p, JIGGLE_MS, () => {
        this.place(p, x, y, `transform ${RETURN_MS}ms cubic-bezier(0.25, 0.9, 0.3, 1.05)`);
      });
      return;
    }

    p.busyUntil = 0;
    const same = Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5;
    if (!same) this.place(p, x, y, mine ? 'transform 150ms ease-out' : REMOTE_MOVE_TRANSITION);
  }

  onPieceReleased({ pieceId, x, y }: PieceReleasedPayload): void {
    const p = this.pieces[pieceId];
    if (!p) return;
    this.pendingGrabs.delete(pieceId);
    if (this.drag?.piece === p) {
      clearTimeout(this.drag.pendingTimer);
      this.drag = null;
    }
    p.heldBy = null;
    p.busyUntil = 0;
    p.el.classList.remove('lifted');
    this.applyHeld(p);
    if (!p.placed) this.place(p, x, y, 'transform 300ms ease-out');
  }

  /** Mark every piece placed (used if a win arrives while visuals lag behind). */
  settleAll(): void {
    for (const p of this.pieces) {
      if (p.placed) continue;
      const slot = slotPosition(this.layout, p.id);
      p.placed = true;
      p.heldBy = null;
      this.applyHeld(p);
      this.place(p, slot.x, slot.y, `transform ${SNAP_MS}ms ease-out`);
      this.applyPlaced(p);
    }
    this.reportProgress();
  }
}
