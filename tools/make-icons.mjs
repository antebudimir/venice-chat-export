/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Dev-only icon generator (run via `npm run icons`). Emits 16/32/48/128 px
 * RGBA PNGs using only Node's built-in zlib. Not shipped: excluded from the
 * build by the webExt.ignoreFiles list in package.json.
 *
 * Design: rounded accent tile, dark inner door, light dial ring, accent hub.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const COLORS = {
  tile: [194, 65, 12, 255], // #c2410c
  door: [23, 20, 18, 255], // #171412
  dial: [242, 236, 230, 255], // #f2ece6
  hub: [194, 65, 12, 255],
};

// ---- minimal PNG writer -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function pngFromPixels(pixels, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ------------------------------------------------------------

function insideRoundedRect(x, y, size, radius) {
  const rx = Math.min(x, size - 1 - x);
  const ry = Math.min(y, size - 1 - y);
  if (rx >= radius || ry >= radius) return true;
  const dx = radius - rx;
  const dy = radius - ry;
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const supersample = 3;
  const tileRadius = Math.max(2, Math.round(size * 0.22));
  const doorInset = Math.round(size * 0.22);
  const doorRadius = Math.max(1, Math.round(size * 0.10));
  const center = (size - 1) / 2;
  const dialRadius = size * 0.18;
  const hubRadius = size * 0.07;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const counts = { tile: 0, door: 0, dial: 0, hub: 0 };
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const px = x + (sx + 0.5) / supersample;
          const py = y + (sy + 0.5) / supersample;
          if (!insideRoundedRect(px, py, size, tileRadius)) continue;
          counts.tile++;
          if (px >= doorInset && px <= size - 1 - doorInset && py >= doorInset && py <= size - 1 - doorInset
            && insideRoundedRect(Math.round(px - doorInset), Math.round(py - doorInset), size - 2 * doorInset, doorRadius)) {
            counts.door++;
            if (insideCircle(px, py, center, center, dialRadius)) {
              counts.dial++;
              if (insideCircle(px, py, center, center, hubRadius)) counts.hub++;
            }
          }
        }
      }
      const total = supersample * supersample;
      let color = [0, 0, 0, 0];
      for (const layer of ['tile', 'door', 'dial', 'hub']) {
        const share = counts[layer] / total;
        const base = COLORS[layer];
        color = [
          color[0] * (1 - share) + base[0] * share,
          color[1] * (1 - share) + base[1] * share,
          color[2] * (1 - share) + base[2] * share,
          color[3] * (1 - share) + base[3] * share,
        ];
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(color[0]);
      pixels[offset + 1] = Math.round(color[1]);
      pixels[offset + 2] = Math.round(color[2]);
      pixels[offset + 3] = Math.round(color[3]);
    }
  }
  return pixels;
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });
for (const size of SIZES) {
  const png = pngFromPixels(drawIcon(size), size, size);
  const target = join(ROOT, 'icons', `icon-${size}.png`);
  writeFileSync(target, png);
  console.log(`wrote ${target} (${png.length} bytes)`);
}
