// Turns white-background JPGs into trimmed, transparent PNGs for the background decor.
// Usage: node scripts/process-decor.mjs <srcDir>
import sharp from 'sharp';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'client', 'public', 'decor');
const srcDir = process.argv[2];
if (!srcDir) throw new Error('Pass the source image directory');
mkdirSync(outDir, { recursive: true });

// `crop` trims stray borders (fractions of each edge) before keying.
const jobs = [
  { match: '6c83d395', out: 'flower-blue.png' },
  { match: '400538960631722972', out: 'hummingbird.png' },
  { match: '988540186965042608', out: 'butterfly-watercolor.png' },
  { match: '1031113277160744835', out: 'lotus.png' },
  { match: '71602af7', out: 'star.png', crop: { top: 0.02 } },
  { match: 'butterfly-cf917987', out: 'butterfly-purple.png' },
  { match: '810085051764238604', out: 'butterfly-green.png' },
];

const MAX_SIDE = 500;
// "Whiteness" distance thresholds: below LO -> fully transparent, above HI -> opaque.
const LO = 18;
const HI = 70;
// Max whiteness distance a pixel can have and still be flood-filled as background.
const FLOOD = 45;

const files = readdirSync(srcDir);

for (const job of jobs) {
  const file = files.find((f) => f.includes(job.match));
  if (!file) {
    console.warn('missing', job.match);
    continue;
  }
  let img = sharp(join(srcDir, file)).removeAlpha();
  const meta = await img.metadata();
  if (job.crop) {
    const t = Math.round((job.crop.top ?? 0) * meta.height);
    img = sharp(await img.extract({ left: 0, top: t, width: meta.width, height: meta.height - t }).toBuffer());
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;
  const rgba = Buffer.alloc(n * 4);

  // Distance from white, weighted toward the darkest channel so pale tints survive.
  const dist = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    dist[p] = Math.max(255 - Math.min(r, g, b), (255 * 3 - r - g - b) / 1.5);
  }

  // Only near-white regions connected to the image border count as background,
  // so white highlights inside the subject stay opaque.
  const bgMask = new Uint8Array(n);
  const stack = [];
  const seed = (p) => {
    if (!bgMask[p] && dist[p] < FLOOD) { bgMask[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (p >= width) seed(p - width);
    if (p < n - width) seed(p + width);
  }
  // Grow the mask a couple of pixels so the anti-aliased rim can fade out too.
  let edge = bgMask;
  for (let k = 0; k < 2; k++) {
    const next = edge.slice();
    for (let p = 0; p < n; p++) {
      if (edge[p]) continue;
      const x = p % width;
      if ((x > 0 && edge[p - 1]) || (x < width - 1 && edge[p + 1]) ||
          (p >= width && edge[p - width]) || (p < n - width && edge[p + width])) next[p] = 1;
    }
    edge = next;
  }

  for (let p = 0, i = 0, j = 0; p < n; p++, i += 3, j += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let a = 1;
    if (edge[p]) {
      a = (dist[p] - LO) / (HI - LO);
      a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
    }
    // Un-premultiply against white so semi-transparent edges don't keep a white halo.
    let R = r, G = g, B = b;
    if (a > 0 && a < 1) {
      R = Math.max(0, Math.min(255, (r - 255 * (1 - a)) / a));
      G = Math.max(0, Math.min(255, (g - 255 * (1 - a)) / a));
      B = Math.max(0, Math.min(255, (b - 255 * (1 - a)) / a));
    }
    rgba[j] = R; rgba[j + 1] = G; rgba[j + 2] = B; rgba[j + 3] = Math.round(a * 255);
  }

  // Drop isolated specks: trim to the bounding box of reasonably opaque pixels.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, job.out));
  console.log('wrote', job.out, `${maxX - minX + 1}x${maxY - minY + 1}`);
}

const bg = files.find((f) => f === 'background.jpg');
if (bg) {
  await sharp(join(srcDir, bg))
    .resize(1920, 1080, { fit: 'cover', kernel: 'lanczos3' })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(join(outDir, 'background.jpg'));
  console.log('wrote background.jpg');
}
