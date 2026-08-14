/**
 * Generates the PWA placeholder icons in `public/icons/` with zero dependencies.
 *
 * The artwork is a procedural nod to what the app renders: a handful of
 * overlapping anisotropic gaussian "splats" on the app's neutral-950 ground.
 * Run with `npm run icons` after changing anything here.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BACKGROUND = [10, 10, 10];

/** Gaussian blobs: centre x/y and radii as fractions of the icon size. */
const SPLATS = [
  { x: 0.36, y: 0.4, rx: 0.3, ry: 0.19, rot: -0.4, color: [56, 189, 248], a: 0.95 },
  { x: 0.63, y: 0.36, rx: 0.22, ry: 0.28, rot: 0.6, color: [167, 139, 250], a: 0.9 },
  { x: 0.5, y: 0.64, rx: 0.34, ry: 0.2, rot: 0.15, color: [244, 114, 182], a: 0.85 },
  { x: 0.72, y: 0.66, rx: 0.16, ry: 0.16, rot: 0, color: [250, 204, 21], a: 0.8 },
  { x: 0.3, y: 0.68, rx: 0.15, ry: 0.11, rot: -0.2, color: [52, 211, 153], a: 0.8 },
];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter type: none
    rgb.copy(raw, rowStart + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** `inset` shrinks the artwork so maskable icons survive the safe-zone crop. */
function renderIcon(size, inset = 1) {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = ((x + 0.5) / size - 0.5) / inset + 0.5;
      const v = ((y + 0.5) / size - 0.5) / inset + 0.5;
      let [r, g, b] = BACKGROUND;
      for (const s of SPLATS) {
        const dx = u - s.x;
        const dy = v - s.y;
        const cos = Math.cos(s.rot);
        const sin = Math.sin(s.rot);
        const lx = (dx * cos + dy * sin) / s.rx;
        const ly = (-dx * sin + dy * cos) / s.ry;
        const alpha = s.a * Math.exp(-2 * (lx * lx + ly * ly));
        if (alpha <= 0.002) continue;
        r += (s.color[0] - r) * alpha;
        g += (s.color[1] - g) * alpha;
        b += (s.color[2] - b) * alpha;
      }
      const i = (y * size + x) * 3;
      px[i] = Math.max(0, Math.min(255, Math.round(r)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return encodePng(size, px);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.72],
  ['apple-touch-icon.png', 180, 1],
];
for (const [name, size, inset] of targets) {
  writeFileSync(resolve(OUT_DIR, name), renderIcon(size, inset));
  process.stdout.write(`wrote icons/${name} (${size}x${size})\n`);
}
