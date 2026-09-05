#!/usr/bin/env node
// Draws the Backline brand mark and writes every raster the app needs, so no
// binary artwork has to live in git:
//
//   build/icon.png              1024²  the app / dmg icon
//   build/tray/trayTemplate.png     16²  the menu-bar item (macOS template image)
//   build/tray/trayTemplate@2x.png  32²  the same, for a Retina menu bar
//
// The mark is the one in docs/design/backline.md: an ink (#1e2430) rounded
// square carrying the `signal` glyph from src/ui/icons.ts in white — three bars
// on a 16 grid, 1.6 stroke, round caps. The tray image is the bare glyph in
// black on transparent; macOS recolours a template image for the menu bar it is
// drawn into. `npm run build` copies build/tray into dist/tray.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The `signal` glyph, byte for byte the geometry of src/ui/icons.ts. */
const SIGNAL_BARS = [
    { x: 3, y0: 12, y1: 6 },
    { x: 8, y0: 12, y1: 3 },
    { x: 13, y0: 12, y1: 8 },
];
const SIGNAL_STROKE = 1.6;
const INK = [0x1e, 0x24, 0x30];

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

/** RGBA8 pixels (`size²`, row-major) to a PNG buffer. */
function encodePng(size, pixels) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** Signed distance from a point to a rounded rectangle. */
function roundedRectDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
    const dx = Math.abs(px - cx) - (halfWidth - radius);
    const dy = Math.abs(py - cy) - (halfHeight - radius);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a round-capped segment: exactly how the glyph strokes read. */
function capsuleDistance(px, py, ax, ay, bx, by, radius) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const length = vx * vx + vy * vy;
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / length));
    return Math.hypot(wx - vx * t, wy - vy * t) - radius;
}

/** Coverage of a shape at one pixel, anti-aliased by 4×4 supersampling. */
function coverage(x, y, distance) {
    const steps = 4;
    let hits = 0;
    for (let sy = 0; sy < steps; sy += 1) {
        for (let sx = 0; sx < steps; sx += 1) {
            const px = x + (sx + 0.5) / steps;
            const py = y + (sy + 0.5) / steps;
            if (distance(px, py) <= 0) hits += 1;
        }
    }
    return hits / (steps * steps);
}

/**
 * Renders the mark.
 *
 * `plate` draws the ink rounded square with white bars (the app icon); without
 * it only the bars are drawn, in black on transparent (the tray template).
 */
function renderMark(size, { plate }) {
    const pixels = Buffer.alloc(size * size * 4);
    // The 16-unit grid, centred on the canvas. The glyph fills two thirds of a
    // plated icon, and the whole of a 16pt menu-bar image.
    const unit = plate ? (size * 0.66) / 16 : size / 16;
    const originX = size / 2 - 8 * unit;
    const originY = size / 2 - 7.5 * unit;
    const bars = SIGNAL_BARS.map((bar) => ({
        ax: originX + bar.x * unit,
        ay: originY + bar.y0 * unit,
        bx: originX + bar.x * unit,
        by: originY + bar.y1 * unit,
        radius: (SIGNAL_STROKE * unit) / 2,
    }));
    const barDistance = (px, py) => Math.min(
        ...bars.map((bar) => capsuleDistance(px, py, bar.ax, bar.ay, bar.bx, bar.by, bar.radius)),
    );
    // A macOS app icon is drawn inside the system's own grid: leave the margin.
    const half = plate ? (size * 0.82) / 2 : 0;
    const plateDistance = (px, py) => roundedRectDistance(px, py, size / 2, size / 2, half, half, size * 0.18);

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const offset = (y * size + x) * 4;
            const glyph = coverage(x, y, barDistance);
            if (!plate) {
                // Template image: black, and only the alpha carries the shape.
                pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0;
                pixels[offset + 3] = Math.round(glyph * 255);
                continue;
            }
            const ground = coverage(x, y, plateDistance);
            // White bars over ink, both faded out together at the plate's edge.
            const level = Math.min(glyph, ground);
            pixels[offset] = Math.round(INK[0] * (1 - level) + 255 * level);
            pixels[offset + 1] = Math.round(INK[1] * (1 - level) + 255 * level);
            pixels[offset + 2] = Math.round(INK[2] * (1 - level) + 255 * level);
            pixels[offset + 3] = Math.round(ground * 255);
        }
    }
    return encodePng(size, pixels);
}

mkdirSync(path.join(root, 'build/tray'), { recursive: true });
const targets = [
    ['build/icon.png', 1024, { plate: true }],
    ['build/tray/trayTemplate.png', 16, { plate: false }],
    ['build/tray/trayTemplate@2x.png', 32, { plate: false }],
];
for (const [file, size, options] of targets) {
    writeFileSync(path.join(root, file), renderMark(size, options));
    console.log(`desktop: wrote ${file} (${size}x${size})`);
}
