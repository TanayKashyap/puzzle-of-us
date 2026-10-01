import { type Layout, mulberry32, randRange, slotPosition, tabPad } from '../../../shared/types';

type Pt = { x: number; y: number };
/** Cubic bezier segment: [control1, control2, end]. Start is the previous end. */
type Seg = [Pt, Pt, Pt];

/** One edge in world space. `segs` empty means a straight (border) edge. */
export interface Edge {
  start: Pt;
  end: Pt;
  segs: Seg[];
}

export interface PuzzleCut {
  layout: Layout;
  /** Canvas padding around each cell, world units (= tabPad(layout)). */
  pad: number;
  /** Horizontal edges, [rows + 1][cols]; row 0 and row `rows` are the flat border. */
  hEdges: Edge[][];
  /** Vertical edges, [rows][cols + 1]; col 0 and col `cols` are the flat border. */
  vEdges: Edge[][];
  /** Outline of each piece in WORLD space at its slot position, indexed by piece id. */
  paths: Path2D[];
}

function flatEdge(start: Pt, end: Pt): Edge {
  return { start, end, segs: [] };
}

/**
 * Classic jigsaw tab from A to B, bulging along unit normal `n`.
 * `s` is min(pieceW, pieceH); the bulge never exceeds 0.22 * s (< tabPad).
 * Always consumes the same number of PRNG values so edges stay deterministic.
 */
function tabEdge(a: Pt, b: Pt, n: Pt, s: number, rand: () => number): Edge {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const c = len * (0.5 + randRange(rand, -0.06, 0.06));
  const h = s * randRange(rand, 0.17, 0.22);
  const nw = s * randRange(rand, 0.07, 0.09);
  const hw = s * randRange(rand, 0.12, 0.15);
  const ch = c + s * randRange(rand, -0.02, 0.02);
  const w1 = s * randRange(rand, -0.02, 0.02);
  const w2 = s * randRange(rand, -0.02, 0.02);

  const p = (u: number, v: number): Pt => ({ x: a.x + d.x * u + n.x * v, y: a.y + d.y * u + n.y * v });
  const segs: Seg[] = [
    [p(c * 0.45, w1), p(c - nw * 1.3, -h * 0.06), p(c - nw, h * 0.18)],
    [p(c - nw * 0.75, h * 0.38), p(ch - hw, h * 0.42), p(ch - hw, h * 0.66)],
    [p(ch - hw, h * 0.92), p(ch - hw * 0.55, h), p(ch, h)],
    [p(ch + hw * 0.55, h), p(ch + hw, h * 0.92), p(ch + hw, h * 0.66)],
    [p(ch + hw, h * 0.42), p(c + nw * 0.75, h * 0.38), p(c + nw, h * 0.18)],
    [p(c + nw * 1.3, -h * 0.06), p(c + (len - c) * 0.55, w2), b],
  ];
  return { start: a, end: b, segs };
}

function reverseEdge(e: Edge): Edge {
  const segs: Seg[] = [];
  for (let i = e.segs.length - 1; i >= 0; i--) {
    const [c1, c2] = e.segs[i];
    const start = i === 0 ? e.start : e.segs[i - 1][2];
    segs.push([c2, c1, start]);
  }
  return { start: e.end, end: e.start, segs };
}

function traceEdge(path: Path2D | CanvasRenderingContext2D, e: Edge): void {
  if (e.segs.length === 0) {
    path.lineTo(e.end.x, e.end.y);
    return;
  }
  for (const [c1, c2, end] of e.segs) path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
}

/** Deterministically cut the board into jigsaw pieces from the game seed. */
export function buildCut(seed: number, layout: Layout): PuzzleCut {
  const { cols, rows, board, pieceW, pieceH } = layout;
  const rand = mulberry32(seed);
  const s = Math.min(pieceW, pieceH);
  const corner = (c: number, r: number): Pt => ({ x: board.x + c * pieceW, y: board.y + r * pieceH });

  const hEdges: Edge[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c < cols; c++) {
      const a = corner(c, r);
      const b = corner(c + 1, r);
      if (r === 0 || r === rows) {
        row.push(flatEdge(a, b));
      } else {
        const sign = rand() < 0.5 ? 1 : -1;
        row.push(tabEdge(a, b, { x: 0, y: sign }, s, rand));
      }
    }
    hEdges.push(row);
  }

  const vEdges: Edge[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c <= cols; c++) {
      const a = corner(c, r);
      const b = corner(c, r + 1);
      if (c === 0 || c === cols) {
        row.push(flatEdge(a, b));
      } else {
        const sign = rand() < 0.5 ? 1 : -1;
        row.push(tabEdge(a, b, { x: sign, y: 0 }, s, rand));
      }
    }
    vEdges.push(row);
  }

  const paths: Path2D[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const top = hEdges[r][c];
      const path = new Path2D();
      path.moveTo(top.start.x, top.start.y);
      traceEdge(path, top);
      traceEdge(path, vEdges[r][c + 1]);
      traceEdge(path, reverseEdge(hEdges[r + 1][c]));
      traceEdge(path, reverseEdge(vEdges[r][c]));
      path.closePath();
      paths.push(path);
    }
  }

  return { layout, pad: tabPad(layout), hEdges, vEdges, paths };
}

/** CSS size (world units) of a piece canvas, including tab padding. */
export function pieceCanvasSize(cut: PuzzleCut): { w: number; h: number } {
  return { w: cut.layout.pieceW + 2 * cut.pad, h: cut.layout.pieceH + 2 * cut.pad };
}

/**
 * Render one piece into `canvas` (created if omitted). The canvas covers the cell
 * plus `pad` on every side; `pxPerUnit` is backing-store pixels per world unit.
 */
export function renderPiece(
  cut: PuzzleCut,
  id: number,
  image: CanvasImageSource,
  pxPerUnit: number,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): HTMLCanvasElement {
  const { layout, pad } = cut;
  const size = pieceCanvasSize(cut);
  canvas.width = Math.max(1, Math.ceil(size.w * pxPerUnit));
  canvas.height = Math.max(1, Math.ceil(size.h * pxPerUnit));
  canvas.style.width = `${size.w}px`;
  canvas.style.height = `${size.h}px`;

  const ctx = canvas.getContext('2d')!;
  const slot = slotPosition(layout, id);
  const path = cut.paths[id];
  const s = Math.min(layout.pieceW, layout.pieceH);
  const { board } = layout;

  ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);
  ctx.translate(-(slot.x - pad), -(slot.y - pad));
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  ctx.clip(path);
  ctx.drawImage(image, board.x, board.y, board.w, board.h);

  // Bevel: shifted strokes inside the clip give a light top-left and dark bottom-right rim.
  const bevel = Math.max(0.8, s * 0.035);
  const shift = bevel * 0.45;
  ctx.lineJoin = 'round';
  ctx.lineWidth = bevel;
  ctx.translate(-shift, -shift);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.stroke(path);
  ctx.translate(2 * shift, 2 * shift);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.stroke(path);
  ctx.restore();

  ctx.lineWidth = Math.max(0.5, s * 0.012);
  ctx.strokeStyle = 'rgba(20, 10, 30, 0.45)';
  ctx.stroke(path);
  return canvas;
}

/**
 * Stroke every internal piece edge once (plus the border) for the outline guide.
 * `ctx` must already be transformed so that it draws in world coordinates.
 */
export function drawGuideEdges(ctx: CanvasRenderingContext2D, cut: PuzzleCut): void {
  const s = Math.min(cut.layout.pieceW, cut.layout.pieceH);
  const edges: Edge[] = [];
  for (let r = 1; r < cut.hEdges.length - 1; r++) edges.push(...cut.hEdges[r]);
  for (const row of cut.vEdges) edges.push(...row.slice(1, -1));

  const strokeAll = (width: number, style: string) => {
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(e.start.x, e.start.y);
      traceEdge(ctx, e);
    }
    const b = cut.layout.board;
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.stroke();
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  strokeAll(Math.max(1, s * 0.03), 'rgba(0, 0, 0, 0.22)');
  strokeAll(Math.max(0.6, s * 0.012), 'rgba(255, 255, 255, 0.32)');
  ctx.restore();
}
