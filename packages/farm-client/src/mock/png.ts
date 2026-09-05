/**
 * A ~100-line PNG encoder, so demo mode can hand `<Image>` a real picture of a
 * fake phone screen instead of a grey box.
 *
 * Deflate is used in "stored" mode (no compression), which is legal zlib and
 * costs nothing to implement. The frames are ~90×160, so the size does not
 * matter; correctness and having no native dependency do.
 */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xff_ff_ff_ff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        a = (a + bytes[i]!) % 65_521;
        b = (b + a) % 65_521;
    }
    return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
    return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new Uint8Array([...type].map((character) => character.charCodeAt(0)));
    const body = concat([typeBytes, data]);
    return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib stream wrapping uncompressed deflate blocks (BTYPE=00). */
function zlibStore(raw: Uint8Array): Uint8Array {
    const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
    const MAX = 0xff_ff;
    for (let offset = 0; offset < raw.length || offset === 0; offset += MAX) {
        const slice = raw.subarray(offset, Math.min(offset + MAX, raw.length));
        const final = offset + MAX >= raw.length ? 1 : 0;
        blocks.push(
            new Uint8Array([final, slice.length & 0xff, (slice.length >>> 8) & 0xff, ~slice.length & 0xff, (~slice.length >>> 8) & 0xff]),
            slice,
        );
        if (final) break;
    }
    blocks.push(u32(adler32(raw)));
    return concat(blocks);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]!;
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        out += BASE64_ALPHABET[a >>> 2];
        out += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >>> 4)];
        out += b === undefined ? '=' : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >>> 6)];
        out += c === undefined ? '=' : BASE64_ALPHABET[c & 0x3f];
    }
    return out;
}

export type RgbPixel = [number, number, number];

/** `paint(x, y)` returns the pixel. Returns a `data:image/png;base64,…` URI. */
export function encodePngDataUri(width: number, height: number, paint: (x: number, y: number) => RgbPixel): string {
    const stride = width * 3;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type 0 (None)
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = paint(x, y);
            const p = rowStart + 1 + x * 3;
            raw[p] = r & 0xff;
            raw[p + 1] = g & 0xff;
            raw[p + 2] = b & 0xff;
        }
    }

    const ihdr = concat([
        u32(width),
        u32(height),
        new Uint8Array([8 /* bit depth */, 2 /* colour type: truecolour */, 0, 0, 0]),
    ]);
    const png = concat([
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlibStore(raw)),
        chunk('IEND', new Uint8Array(0)),
    ]);
    return `data:image/png;base64,${toBase64(png)}`;
}
