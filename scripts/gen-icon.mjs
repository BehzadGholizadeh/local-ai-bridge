// Generates assets/icon.png (256x256): a rounded indigo→purple square with two linked rings.
// No dependencies: writes the PNG by hand with zlib.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 256;
const px = Buffer.alloc(S * S * 4);
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const clamp = (v) => Math.max(0, Math.min(1, v));

function roundedRectAlpha(x, y, r) {
  const cx = Math.min(Math.max(x, r), S - r);
  const cy = Math.min(Math.max(y, r), S - r);
  const d = Math.hypot(x - cx, y - cy);
  return clamp(r - d + 0.5);
}

function ring(x, y, cx, cy, radius, width) {
  const d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
  return clamp(width / 2 - d + 0.5);
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const inside = roundedRectAlpha(x + 0.5, y + 0.5, 56);
    if (inside <= 0) continue;
    const t = (x + y) / (2 * S);
    let r = lerp(0x4f, 0x93, t);
    let g = lerp(0x46, 0x33, t);
    let b = lerp(0xe5, 0xea, t);
    const w = Math.max(ring(x, y, 100, 128, 46, 18), ring(x, y, 156, 128, 46, 18));
    r = lerp(r, 255, w);
    g = lerp(g, 255, w);
    b = lerp(b, 255, w);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.round(255 * inside);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out}`);
