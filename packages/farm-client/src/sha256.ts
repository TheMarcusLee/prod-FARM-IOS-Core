/**
 * sha256 over bytes, in the plainest way that works everywhere.
 *
 * The chunked upload protocol makes every chunk carry its own digest, and the
 * farm refuses a chunk without one. In a browser `crypto.subtle` does the work;
 * React Native has `globalThis.crypto` but no `subtle`, and pulling a native
 * crypto module into `@farm/client` would make the package unusable from
 * Electron and Node. So this is the fallback, and the only maths in the package.
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotate(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

/** Lower-case hex, the only form the farm accepts. */
export function sha256Bytes(input: Uint8Array): string {
    const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const bitLength = input.length * 8;
    // One 0x80 byte, then zeros, then the 64-bit length: the padding is what
    // makes the last block unambiguous.
    const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
    padded.set(input);
    padded[input.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);

    const words = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
            const a = words[index - 15] as number;
            const b = words[index - 2] as number;
            const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
            const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
            words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) >>> 0;
        }
        let a = state[0] as number, b = state[1] as number, c = state[2] as number, d = state[3] as number;
        let e = state[4] as number, f = state[5] as number, g = state[6] as number, h = state[7] as number;
        for (let index = 0; index < 64; index += 1) {
            const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choice + (K[index] as number) + (words[index] as number)) >>> 0;
            const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g; g = f; f = e;
            e = (d + temp1) >>> 0;
            d = c; c = b; b = a;
            a = (temp1 + temp2) >>> 0;
        }
        state[0] = ((state[0] as number) + a) >>> 0;
        state[1] = ((state[1] as number) + b) >>> 0;
        state[2] = ((state[2] as number) + c) >>> 0;
        state[3] = ((state[3] as number) + d) >>> 0;
        state[4] = ((state[4] as number) + e) >>> 0;
        state[5] = ((state[5] as number) + f) >>> 0;
        state[6] = ((state[6] as number) + g) >>> 0;
        state[7] = ((state[7] as number) + h) >>> 0;
    }
    return [...state].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * `crypto.subtle` when the platform has it — it is native and much faster on an
 * 8 MiB chunk — and the implementation above when it does not.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return sha256Bytes(new Uint8Array(bytes));
}
