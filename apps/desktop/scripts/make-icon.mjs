#!/usr/bin/env node
// Generates build/icon.png — a placeholder app icon, so packaging needs no binary
// asset in git. Replace build/icon.png with real artwork before shipping.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const size = 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buffer) {
    let crc = ~0;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
        // Rounded "phone" plate on a vertical gradient.
        const inPlate = x > size * 0.3 && x < size * 0.7 && y > size * 0.18 && y < size * 0.82;
        const t = y / size;
        const r = inPlate ? 235 : Math.round(26 + 40 * t);
        const g = inPlate ? 236 : Math.round(28 + 52 * t);
        const b = inPlate ? 245 : Math.round(38 + 96 * t);
        const offset = rowStart + 1 + x * 4;
        raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = 255;
    }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(path.join(root, 'build'), { recursive: true });
writeFileSync(path.join(root, 'build/icon.png'), png);
console.log(`desktop: wrote build/icon.png (${size}x${size}, placeholder)`);
