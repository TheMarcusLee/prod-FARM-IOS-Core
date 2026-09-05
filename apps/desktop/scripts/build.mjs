#!/usr/bin/env node
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const shared = {
    bundle: true,
    platform: 'node',
    // Electron 44 ships Node 22; nothing newer is safe to emit.
    target: 'node22',
    sourcemap: true,
    logLevel: 'info',
};

// Main process: CommonJS. Electron's ESM main entry does not start reliably on
// every host (see docs/desktop.md), and CJS also keeps asar path resolution
// working. `embedded-postgres` stays external so its platform binaries survive
// packaging untouched; Node's require(esm) support loads it.
await build({
    ...shared,
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(out, 'main/main.cjs'),
    format: 'cjs',
    external: ['electron', 'embedded-postgres'],
});

// Preload must be CommonJS: it runs in a sandboxed context that has no ESM loader.
await build({
    ...shared,
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(out, 'preload/preload.cjs'),
    format: 'cjs',
    external: ['electron'],
});

await build({
    ...shared,
    entryPoints: [
        path.join(root, 'src/renderer/starting.ts'),
        path.join(root, 'src/renderer/services.ts'),
        path.join(root, 'src/renderer/settings.ts'),
        path.join(root, 'src/renderer/job.ts'),
    ],
    outdir: path.join(out, 'renderer'),
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
});

for (const asset of ['app.css', 'starting.html', 'services.html', 'settings.html', 'job.html']) {
    await cp(path.join(root, 'src/renderer', asset), path.join(out, 'renderer', asset));
}

console.log('desktop: build complete');
