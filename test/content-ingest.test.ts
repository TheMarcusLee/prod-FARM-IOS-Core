import assert from 'node:assert/strict';
import test from 'node:test';

import { createLimiter, mimeTypeFor } from '../src/content/ingest.js';

test('the limiter releases its slot when a task throws synchronously', async () => {
    const limit = createLimiter(1);
    await assert.rejects(limit(() => { throw new Error('boom'); }), /boom/);
    // Before the fix the slot above was never released and this second call
    // hung forever, silently stopping every later transcode on the process.
    assert.equal(await limit(async () => 'still alive'), 'still alive');
    await assert.rejects(limit(async () => { throw new Error('async boom'); }), /async boom/);
    assert.equal(await limit(async () => 'ok'), 'ok');
});

test('the limiter never runs more than `concurrency` tasks at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () => limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
    }));
    await Promise.all(tasks);
    assert.equal(peak, 2);
    assert.equal(active, 0);
});

test('mime types follow the extension, defaulting to jpeg for unknown stills', () => {
    assert.equal(mimeTypeFor('clip.MOV'), 'video/mp4');
    assert.equal(mimeTypeFor('clip.webm'), 'video/webm');
    assert.equal(mimeTypeFor('shot.PNG'), 'image/png');
    assert.equal(mimeTypeFor('shot.heic'), 'image/heic');
    assert.equal(mimeTypeFor('no-extension'), 'image/jpeg');
});
