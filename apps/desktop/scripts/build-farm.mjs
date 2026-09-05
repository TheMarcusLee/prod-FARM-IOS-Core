#!/usr/bin/env node
/**
 * Builds `apps/desktop/farm-dist`: the farm as the packaged app ships it.
 *
 * The .app used to carry the checkout plus the whole 784 MB `node_modules`, so
 * it also carried TypeScript, tsx and every development dependency. Here the
 * farm is compiled ahead of time and the module tree is installed from the
 * lockfile with `--omit=dev`, then pruned of binaries for platforms the app can
 * never run on.
 *
 *   node scripts/build-farm.mjs [--modules-only] [--no-modules] [--force]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktop, '..', '..');
const outDir = path.join(desktop, 'farm-dist');
const staging = path.join(desktop, '.farm-modules');
const stamp = path.join(outDir, '.modules-stamp');

const flags = new Set(process.argv.slice(2));
const wantSources = !flags.has('--modules-only');
const wantModules = !flags.has('--no-modules');

/** Everything copied verbatim: entry points resolve these relative to import.meta.url. */
const COPIED = [
    // Dashboard assets, TikTok/runbook HTML fragments, uploaded media roots.
    'static',
    // drizzle migration SQL, read by src/database/migrate.ts.
    'drizzle',
    // WebDriverAgent patches, read by src/devices/wda/prepare.ts via packageRoot.
    'Patches',
    // The Help links in the Rig window open these.
    'docs',
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
];

/**
 * Binaries for platforms the app cannot run on. The .dmg is arm64 macOS only, so
 * a Linux ffprobe is 99 MB of nothing. Every entry is a directory that the
 * package resolves by platform at runtime, so removing a foreign one is inert.
 */
const PLATFORM_PRUNE = [
    'ffprobe-static/bin/linux',
    'ffprobe-static/bin/win32',
    'node-native-ocr/prebuilds/linux-x64',
    'node-native-ocr/prebuilds/win32-x64',
];

/**
 * Tesseract language data. src/tiktok/ocr.ts never passes `lang`, so tesseract
 * uses `eng`; `osd` is the orientation model it also loads. The rest are 44 MB
 * of languages nothing asks for.
 */
const TESSDATA_KEEP = new Set(['eng.traineddata', 'osd.traineddata', 'equ.traineddata']);

/** Packages whose payload arrives from a postinstall script, so `--ignore-scripts` leaves them empty. */
const SCRIPT_INSTALLED = ['ffmpeg-static'];

/** Kept even though it is a devDependency: the desktop app supervises it as a service. */
const EXTRA_RUNTIME_PACKAGES = ['appium'];

function run(file, args, cwd) {
    execFileSync(file, args, { cwd, stdio: 'inherit' });
}

function bytes(target) {
    if (!existsSync(target)) return 0;
    const stats = statSync(target);
    if (!stats.isDirectory()) return stats.size;
    let total = 0;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        total += bytes(path.join(target, entry.name));
    }
    return total;
}

export function formatSize(count) {
    return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

/** Node's own resolution: walk up `node_modules` directories from `from`. */
function resolvePackage(name, from, root) {
    let directory = from;
    for (;;) {
        const candidate = path.join(directory, 'node_modules', name);
        if (existsSync(path.join(candidate, 'package.json'))) return candidate;
        const parent = path.dirname(directory);
        if (parent === directory || !directory.startsWith(root)) return null;
        directory = parent;
    }
}

/**
 * Every package `roots` needs, transitively. `--omit=dev` drops appium, but the
 * app still supervises it, so its closure is copied back out of the checkout.
 */
export function dependencyClosure(roots, root) {
    const found = new Map();
    const queue = [...roots];
    while (queue.length > 0) {
        const name = queue.shift();
        if (found.has(name)) continue;
        const directory = resolvePackage(name, root, root);
        if (!directory) continue;
        found.set(name, directory);
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
        } catch {
            continue;
        }
        for (const key of ['dependencies', 'optionalDependencies']) {
            for (const dependency of Object.keys(manifest[key] ?? {})) queue.push(dependency);
        }
    }
    return found;
}

function buildSources() {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // The dashboard's browser bundle is emitted into static/, so it must be built first.
    console.log('farm-dist: building the dashboard assets');
    run('npm', ['run', 'build:web'], repoRoot);

    // The checkout's own TypeScript, not the desktop app's: they are different
    // major versions and disagree about the DOM lib.
    console.log('farm-dist: compiling the farm to JavaScript');
    run(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', path.join(desktop, 'tsconfig.farm.json')], desktop);

    for (const entry of COPIED) {
        const source = path.join(repoRoot, entry);
        if (!existsSync(source)) continue;
        cpSync(source, path.join(outDir, entry), { recursive: true, dereference: false });
    }
    // The farm is ESM and the compiled tree keeps `.js` specifiers, so Node needs this.
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'package.json'), 'utf8'));
    if (manifest.type !== 'module') throw new Error('the farm package.json must stay type: module');
}

function lockHash() {
    return createHash('sha256')
        .update(readFileSync(path.join(repoRoot, 'package-lock.json')))
        .update(JSON.stringify({ PLATFORM_PRUNE, TESSDATA_KEEP: [...TESSDATA_KEEP], EXTRA_RUNTIME_PACKAGES }))
        .digest('hex');
}

function buildModules() {
    const target = path.join(outDir, 'node_modules');
    const wanted = lockHash();
    if (!flags.has('--force') && existsSync(target) && existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) {
        console.log('farm-dist: node_modules is up to date');
        return;
    }

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
        cpSync(path.join(repoRoot, file), path.join(staging, file));
    }
    console.log('farm-dist: installing production dependencies');
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging);

    const stagedModules = path.join(staging, 'node_modules');
    const rootModules = path.join(repoRoot, 'node_modules');

    // `--ignore-scripts` leaves these packages without the binary their postinstall
    // fetches; the checkout already has it, so copy it rather than downloading again.
    for (const name of SCRIPT_INSTALLED) {
        const source = path.join(rootModules, name);
        if (!existsSync(source)) continue;
        cpSync(source, path.join(stagedModules, name), { recursive: true, force: true });
    }

    for (const [name, directory] of dependencyClosure(EXTRA_RUNTIME_PACKAGES, repoRoot)) {
        const destination = path.join(stagedModules, name);
        if (existsSync(destination)) continue;
        cpSync(directory, destination, { recursive: true });
    }

    for (const relative of PLATFORM_PRUNE) {
        rmSync(path.join(stagedModules, relative), { recursive: true, force: true });
    }
    const tessdata = path.join(stagedModules, 'node-native-ocr', 'tessdata');
    if (existsSync(tessdata)) {
        for (const entry of readdirSync(tessdata)) {
            if (!TESSDATA_KEEP.has(entry)) rmSync(path.join(tessdata, entry), { force: true });
        }
    }

    rmSync(target, { recursive: true, force: true });
    cpSync(stagedModules, target, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(stamp, wanted);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (wantSources) buildSources();
    if (wantModules) buildModules();
    console.log([
        'farm-dist: done',
        `  sources      ${formatSize(bytes(path.join(outDir, 'src')))}`,
        `  static+docs  ${formatSize(bytes(path.join(outDir, 'static')) + bytes(path.join(outDir, 'docs')))}`,
        `  node_modules ${formatSize(bytes(path.join(outDir, 'node_modules')))}`,
        `  total        ${formatSize(bytes(outDir))}`,
        `  (the checkout's own node_modules is ${formatSize(bytes(path.join(repoRoot, 'node_modules')))})`,
    ].join('\n'));
}
