import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildNormalizeArgs, buildPosterArgs, buildProbeArgs, buildScaleFilter, buildYtDlpArgs, interpretProbe,
    posterSecondsFor, rotationOf,
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

test('stream selection is explicit, so a cover-art still cannot become the video', () => {
    const args = buildNormalizeArgs({ input: '/in/song-with-cover.mp4', output: '/out/a.mp4' });
    const maps = args.reduce<string[]>((all, value, index) => (
        args[index - 1] === '-map' ? [...all, value] : all
    ), []);
    assert.deepEqual(maps, ['0:v:0', '0:a:0?']);
    // The optional '?' is what keeps an audio-less clip from failing the encode.
    assert.ok(maps[1]?.endsWith('?'));
    // -map must come after the input it selects from.
    assert.ok(args.indexOf('-map') > args.indexOf('-i'));
});

test('a poster is sampled inside the clip, never past the end of a very short one', () => {
    assert.equal(posterSecondsFor(15_000), 1);
    assert.equal(posterSecondsFor(500), 0.25);
    assert.equal(posterSecondsFor(120), 0.06);
    assert.equal(posterSecondsFor(0), 0);
    assert.equal(posterSecondsFor(undefined), 0);
    // A negative or nonsense seek would make ffmpeg fail rather than produce a frame.
    assert.equal(buildPosterArgs({ input: 'a.mp4', output: 'a.jpg', atSeconds: -5 })[
        buildPosterArgs({ input: 'a.mp4', output: 'a.jpg', atSeconds: -5 }).indexOf('-ss') + 1], '0');
});

test('a rotated recording reports the dimensions the player will show', () => {
    const portrait = interpretProbe({
        streams: [{
            codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
            side_data_list: [{ rotation: -90 }],
        }],
        format: { duration: '8' },
    });
    assert.deepEqual([portrait.width, portrait.height], [1080, 1920]);

    const legacyTag = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, tags: { rotate: '270' } }],
        format: { duration: '8' },
    });
    assert.deepEqual([legacyTag.width, legacyTag.height], [1080, 1920]);

    const upright = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, side_data_list: [{ rotation: 180 }] }],
        format: { duration: '8' },
    });
    assert.deepEqual([upright.width, upright.height], [1080, 1920]);
    assert.equal(rotationOf(undefined), 0);
});

test('an "N/A" container duration falls through to the stream duration', () => {
    const probe = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'vp9', width: 720, height: 1280, duration: '31.4' }],
        format: { duration: 'N/A' },
    });
    assert.equal(probe.kind, 'video');
    assert.equal(probe.durationMs, 31_400);

    const noDurationAnywhere = interpretProbe({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, duration: 'N/A' }],
        format: { duration: 'N/A' },
    });
    assert.equal(noDurationAnywhere.kind, 'image');
});
