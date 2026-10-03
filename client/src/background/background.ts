import './background.css';

const BASE = import.meta.env.BASE_URL;
const decor = (name: string): string => `${BASE}decor/${name}`;

const SCENE = { src: decor('background.jpg'), w: 1920, h: 1080, focusY: 0.7 };

/** Top edge of the grassy hill in scene-image fractions (v = y / height) as a function of u = x / width. */
const hillTop = (u: number): number => 0.555 + 0.335 * u;

interface FlowerDef {
  src: string;
  /** Head height / width. */
  aspect: number;
  /** Horizontal position as a fraction of the viewport. */
  x: number;
  /** How far down from the hill line toward the bottom edge the stem base sits (0..1). */
  depth: number;
  /** Size multiplier. */
  scale: number;
  sway: { amp: number; dur: number; delay: number };
  /** Hidden on narrow (phone) viewports to avoid crowding. */
  wideOnly?: boolean;
}

const FLOWERS: FlowerDef[] = [
  { src: decor('lotus.png'), aspect: 0.776, x: 0.09, depth: 0.78, scale: 1.15, sway: { amp: 3.5, dur: 5.8, delay: -1.2 } },
  { src: decor('flower-blue.png'), aspect: 1.063, x: 0.22, depth: 0.5, scale: 0.85, sway: { amp: 4.5, dur: 4.9, delay: -3.1 } },
  { src: decor('flower-blue.png'), aspect: 1.063, x: 0.8, depth: 0.7, scale: 0.95, sway: { amp: 4, dur: 6.4, delay: -0.4 } },
  { src: decor('lotus.png'), aspect: 0.776, x: 0.93, depth: 0.55, scale: 0.8, sway: { amp: 3, dur: 5.3, delay: -2.5 }, wideOnly: true },
];

type SpriteKind = 'butterfly' | 'hummingbird' | 'star';

interface SpriteDef {
  kind: SpriteKind;
  src: string;
  aspect: number;
  /** Direction the artwork faces: 1 = right, -1 = left. */
  facing: 1 | -1;
  flap?: 'side' | 'top';
}

const BUTTERFLIES: SpriteDef[] = [
  { kind: 'butterfly', src: decor('butterfly-watercolor.png'), aspect: 1.176, facing: -1, flap: 'side' },
  { kind: 'butterfly', src: decor('butterfly-purple.png'), aspect: 1.18, facing: -1, flap: 'side' },
  { kind: 'butterfly', src: decor('butterfly-green.png'), aspect: 1.07, facing: -1, flap: 'top' },
];
const HUMMINGBIRD: SpriteDef = { kind: 'hummingbird', src: decor('hummingbird.png'), aspect: 1.09, facing: 1 };
const STAR: SpriteDef = { kind: 'star', src: decor('star.png'), aspect: 1.06, facing: 1 };

const MAX_ACTIVE: Record<SpriteKind, number> = { butterfly: 2, hummingbird: 1, star: 2 };
/** Seconds between respawn attempts, [min, max]. */
const SPAWN_GAP: Record<SpriteKind, [number, number]> = {
  butterfly: [2, 7],
  hummingbird: [9, 20],
  star: [3, 9],
};

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeInCubic = (t: number): number => t ** 3;

interface Sprite {
  def: SpriteDef;
  el: HTMLDivElement;
  face: HTMLDivElement;
  size: number;
  age: number;
  /** Returns false once the sprite has left the screen. */
  step(dt: number): boolean;
}

let mounted = false;

export function mountBackground(container: HTMLElement = document.body): void {
  if (mounted) return;
  mounted = true;

  const root = document.createElement('div');
  root.className = 'bg-root';
  root.setAttribute('aria-hidden', 'true');

  const world = document.createElement('div');
  world.className = 'bg-world';

  const stage = document.createElement('div');
  stage.className = 'bg-stage';
  const sceneImg = document.createElement('img');
  sceneImg.src = SCENE.src;
  sceneImg.alt = '';
  sceneImg.decoding = 'async';
  stage.append(sceneImg);
  world.append(stage);

  const flowerEls = FLOWERS.map((def) => {
    const el = document.createElement('div');
    el.className = 'bg-flower';
    const sway = document.createElement('div');
    sway.className = 'bg-flower-sway';
    sway.style.setProperty('--sway-amp', `${def.sway.amp}deg`);
    sway.style.setProperty('--sway-dur', `${def.sway.dur}s`);
    sway.style.setProperty('--sway-delay', `${def.sway.delay}s`);
    const stem = document.createElement('div');
    stem.className = 'bg-flower-stem';
    const leafL = document.createElement('div');
    leafL.className = 'bg-flower-leaf left';
    const leafR = document.createElement('div');
    leafR.className = 'bg-flower-leaf right';
    const head = document.createElement('img');
    head.className = 'bg-flower-head';
    head.src = def.src;
    head.alt = '';
    sway.append(stem, leafL, leafR, head);
    el.append(sway);
    world.append(el);
    return { def, el, stem };
  });

  const spriteLayer = document.createElement('div');
  spriteLayer.style.cssText = 'position:absolute;inset:0;';

  root.append(world, spriteLayer);
  container.prepend(root);

  let vw = window.innerWidth;
  let vh = window.innerHeight;

  const layout = (): void => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    const s = Math.max(vw / SCENE.w, vh / SCENE.h);
    const sw = SCENE.w * s;
    const sh = SCENE.h * s;
    const ox = (vw - sw) / 2;
    const oy = (vh - sh) * SCENE.focusY;
    Object.assign(stage.style, { width: `${sw}px`, height: `${sh}px`, left: `${ox}px`, top: `${oy}px` });

    const unit = clamp(Math.min(vw, vh) * 0.2, 70, 210);
    for (const { def, el, stem } of flowerEls) {
      el.style.display = def.wideOnly && vw < 600 ? 'none' : '';
      const x = def.x * vw;
      const hillY = oy + hillTop((x - ox) / sw) * sh;
      const baseY = Math.min(hillY + (vh - hillY) * def.depth, vh + 4);
      // Flowers further down the hill are closer to the viewer, so slightly larger.
      const w = unit * def.scale * (0.85 + def.depth * 0.3);
      const headH = w * def.aspect;
      const stemLen = w * 0.45;
      const h = headH + stemLen;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.transform = `translate3d(${x - w / 2}px, ${baseY - h}px, 0)`;
      stem.style.height = `${stemLen + headH * 0.45}px`;
      stem.style.setProperty('--stem-w', `${Math.max(3, w * 0.035)}px`);
    }
  };
  layout();
  window.addEventListener('resize', layout);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const sprites: Sprite[] = [];
  const nextSpawn: Record<SpriteKind, number> = { butterfly: 0.4, hummingbird: rand(3, 6), star: 1.2 };
  let clock = 0;

  const baseUnit = (): number => Math.min(vw, vh);

  const makeEl = (def: SpriteDef, size: number): { el: HTMLDivElement; face: HTMLDivElement } => {
    const el = document.createElement('div');
    el.className = `bg-sprite bg-${def.kind}${def.flap ? ` bg-flap-${def.flap}` : ''}`;
    el.style.width = `${size}px`;
    el.style.height = `${size * def.aspect}px`;
    const face = document.createElement('div');
    face.className = 'bg-sprite-face';
    const anim = document.createElement('div');
    anim.className = 'bg-sprite-anim';
    const img = document.createElement('img');
    img.src = def.src;
    img.alt = '';
    anim.append(img);
    face.append(anim);
    el.append(face);
    spriteLayer.append(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    return { el, face };
  };

  const place = (sp: Sprite, x: number, y: number, rot: number, dir: number): void => {
    sp.el.style.transform = `translate3d(${x - sp.size / 2}px, ${y - (sp.size * sp.def.aspect) / 2}px, 0) rotate(${rot}deg)`;
    sp.face.style.transform = dir === sp.def.facing ? '' : 'scaleX(-1)';
  };

  const spawnButterfly = (): Sprite => {
    const def = pick(BUTTERFLIES);
    const size = clamp(baseUnit() * rand(0.09, 0.13), 44, 130);
    const { el, face } = makeEl(def, size);
    el.style.setProperty('--flap', `${rand(0.22, 0.34)}s`);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const margin = size * 1.5;
    let x = dir === 1 ? -margin : vw + margin;
    const baseY = rand(0.1, 0.65) * vh;
    const speed = vw / rand(14, 24);
    const drift = rand(-0.008, 0.008) * vh;
    const a1 = rand(0.04, 0.09) * vh, w1 = rand(0.5, 0.9), p1 = rand(0, Math.PI * 2);
    const a2 = rand(0.01, 0.03) * vh, w2 = rand(1.8, 2.8), p2 = rand(0, Math.PI * 2);
    let prevY = baseY;
    const sp: Sprite = {
      def, el, face, size, age: 0,
      step(dt) {
        sp.age += dt;
        const t = sp.age;
        // Speed surges slightly with each "flap cycle" for an organic, bouncy flight.
        x += dir * speed * (0.8 + 0.35 * Math.sin(t * 2.3 + p2)) * dt;
        const y = baseY + drift * t + a1 * Math.sin(w1 * t + p1) + a2 * Math.sin(w2 * t + p2);
        const vy = (y - prevY) / Math.max(dt, 1e-3);
        prevY = y;
        const tilt = clamp((vy / speed) * 25, -18, 18) * dir;
        place(sp, x, y, tilt, dir);
        return dir === 1 ? x < vw + margin : x > -margin;
      },
    };
    return sp;
  };

  const spawnHummingbird = (): Sprite => {
    const def = HUMMINGBIRD;
    const size = clamp(baseUnit() * rand(0.11, 0.15), 55, 150);
    const { el, face } = makeEl(def, size);
    const fromLeft = Math.random() < 0.5;
    const margin = size * 1.5;
    const edgeX = (left: boolean): number => (left ? -margin : vw + margin);

    type Leg = { x0: number; y0: number; x1: number; y1: number; dur: number; kind: 'dart' | 'hover' | 'exit' };
    const legs: Leg[] = [];
    let cx = edgeX(fromLeft);
    let cy = rand(0.12, 0.5) * vh;
    const hoverCount = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < hoverCount; i++) {
      const nx = rand(0.15, 0.85) * vw;
      const ny = rand(0.12, 0.55) * vh;
      legs.push({ x0: cx, y0: cy, x1: nx, y1: ny, dur: rand(0.7, 1.1), kind: 'dart' });
      legs.push({ x0: nx, y0: ny, x1: nx + rand(-0.02, 0.02) * vw, y1: ny + rand(-0.02, 0.02) * vh, dur: rand(1.8, 3.5), kind: 'hover' });
      cx = legs[legs.length - 1].x1;
      cy = legs[legs.length - 1].y1;
    }
    const exitLeft = Math.random() < 0.5;
    legs.push({ x0: cx, y0: cy, x1: edgeX(exitLeft), y1: cy + rand(-0.2, 0.1) * vh, dur: rand(0.9, 1.4), kind: 'exit' });

    let legIdx = 0;
    let legT = 0;
    let dir = fromLeft ? 1 : -1;
    const sp: Sprite = {
      def, el, face, size, age: 0,
      step(dt) {
        sp.age += dt;
        legT += dt;
        let leg = legs[legIdx];
        while (legT >= leg.dur) {
          legT -= leg.dur;
          legIdx++;
          if (legIdx >= legs.length) return false;
          leg = legs[legIdx];
        }
        const p = legT / leg.dur;
        const e = leg.kind === 'dart' ? easeOutCubic(p) : leg.kind === 'exit' ? easeInCubic(p) : 0.5 - Math.cos(p * Math.PI) / 2;
        let x = leg.x0 + (leg.x1 - leg.x0) * e;
        let y = leg.y0 + (leg.y1 - leg.y0) * e;
        let rot = 0;
        if (leg.kind === 'hover') {
          x += Math.sin(sp.age * 3.1) * size * 0.04;
          y += Math.sin(sp.age * 5.3) * size * 0.05;
          rot = Math.sin(sp.age * 2.2) * 3;
        } else {
          const dx = leg.x1 - leg.x0;
          if (Math.abs(dx) > 1) dir = dx > 0 ? 1 : -1;
          rot = clamp(((leg.y1 - leg.y0) / Math.max(Math.abs(dx), 1)) * 20, -15, 15) * dir;
        }
        place(sp, x, y, rot, dir);
        return true;
      },
    };
    return sp;
  };

  const spawnStar = (): Sprite => {
    const def = STAR;
    const size = clamp(baseUnit() * rand(0.045, 0.07), 26, 72);
    const { el, face } = makeEl(def, size);
    el.style.setProperty('--twinkle', `${rand(1.6, 3)}s`);
    const margin = size * 1.5;
    const dir = Math.random() < 0.5 ? 1 : -1;
    let x = dir === 1 ? -margin : vw + margin;
    let y = rand(0.05, 0.5) * vh;
    const vx = dir * vw / rand(35, 55);
    const vy = rand(-0.004, 0.008) * vh;
    const spin = rand(8, 22) * (Math.random() < 0.5 ? 1 : -1);
    let rot = rand(0, 360);
    const sp: Sprite = {
      def, el, face, size, age: 0,
      step(dt) {
        sp.age += dt;
        x += vx * dt;
        y += vy * dt + Math.sin(sp.age * 0.7) * 0.15;
        rot += spin * dt;
        place(sp, x, y, rot, 1);
        return dir === 1 ? x < vw + margin : x > -margin;
      },
    };
    return sp;
  };

  const spawners: Record<SpriteKind, () => Sprite> = {
    butterfly: spawnButterfly,
    hummingbird: spawnHummingbird,
    star: spawnStar,
  };

  let rafId = 0;
  let last = 0;

  const frame = (now: number): void => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    clock += dt;

    for (const kind of Object.keys(spawners) as SpriteKind[]) {
      if (clock < nextSpawn[kind]) continue;
      const active = sprites.filter((s) => s.def.kind === kind).length;
      if (active < MAX_ACTIVE[kind] && sprites.length < 5) sprites.push(spawners[kind]());
      nextSpawn[kind] = clock + rand(...SPAWN_GAP[kind]);
    }

    for (let i = sprites.length - 1; i >= 0; i--) {
      const sp = sprites[i];
      if (!sp.step(dt)) {
        sp.el.remove();
        sprites.splice(i, 1);
      }
    }
    rafId = requestAnimationFrame(frame);
  };

  const running = (): boolean => rafId !== 0;
  const start = (): void => {
    if (running() || document.hidden || reducedMotion.matches) return;
    last = 0;
    rafId = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    cancelAnimationFrame(rafId);
    rafId = 0;
  };
  const clearSprites = (): void => {
    for (const sp of sprites) sp.el.remove();
    sprites.length = 0;
  };

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      stop();
      clearSprites();
    } else {
      start();
    }
  });
  start();
}
