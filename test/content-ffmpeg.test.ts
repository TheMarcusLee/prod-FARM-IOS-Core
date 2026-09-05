import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildNormalizeArgs, buildPosterArgs, buildProbeArgs, buildScaleFilter, buildYtDlpArgs, interpretProbe,
} from '../src/content/ffmpeg.js';

// No FFmpeg is executed anywhere in this file — the arguments are the contract.

test('normalisation pads to 9:16, caps duration, and strips metadata', () => {
    const args = buildNormalizeArgs({ input: '/in/clip.mov', output: '/out/clip.mp4' });
    const filter = args[args.indexOf('-vf') + 1] as string;
    assert.match(filter, /pad=1080:1920/);
    assert.doesNotMatch(filter, /crop=/);
    assert.equal(args[args.indexOf('-t') + 1], '180');
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
    assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
    assert.equal(args[args.indexOf('-i') + 1], '/in/clip.mov');
    assert.equal(args.at(-1), '/out/clip.mp4');
    // Every entry is a separate argv slot — nothing is ever handed to a shell.
    assert.ok(args.every((value) => typeof value === 'string' && !value.includes(' && ')));
});

test('crop mode fills the frame instead of padding it', () => {
    const args = buildNormalizeArgs({ input: 'a.mp4', output: 'b.mp4', crop: true, maxSeconds: 60 });
    const filter = args[args.indexOf('-vf') + 1] as string;
    assert.match(filter, /crop=1080:1920/);
    assert.doesNotMatch(filter, /pad=/);
    assert.equal(args[args.indexOf('-t') + 1], '60');
    assert.equal(buildScaleFilter(720, 1280, false).includes('pad=720:1280'), true);
});

test('probe and poster arguments name the input exactly once', () => {
    assert.deepEqual(buildProbeArgs('/in/a b.mp4').at(-1), '/in/a b.mp4');
    assert.ok(buildProbeArgs('x').includes('-show_streams'));
    const poster = buildPosterArgs({ input: '/in/a.mp4', output: '/out/a.jpg', atSeconds: 3 });
    assert.equal(poster[poster.indexOf('-ss') + 1], '3');
    assert.equal(poster[poster.indexOf('-frames:v') + 1], '1');
    assert.equal(poster.at(-1), '/out/a.jpg');
    assert.equal(buildYtDlpArgs('https://example.test/v', '/tmp/%(id)s.%(ext)s').at(-1), 'https://example.test/v');
});

test('interpretProbe separates a real video from a single-frame still', () => {
    const video = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }, { codec_type: 'audio' }],
        format: { duration: '12.5' },
    });
    assert.deepEqual(video, { kind: 'video', width: 1080, height: 1920, durationMs: 12_500, hasAudio: true });

    const still = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 1200, height: 1600, duration: '0.04' }],
        format: { duration: '0.04' },
    });
    assert.equal(still.kind, 'image');
    assert.equal(still.hasAudio, false);
    assert.equal(still.durationMs, undefined);

    const png = interpretProbe({ streams: [{ codec_type: 'video', codec_name: 'png', width: 800, height: 600 }] });
    assert.equal(png.kind, 'image');
});
