import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../src/registry.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';
import type { JsonObject } from '../src/types.js';

const plugin = createTikTokPlugin({ doomscrollEntrypoint: '/example/doomscroll.js', postEntrypoint: '/example/post.js' });

test('built-in TikTok plugin validates versioned doomscroll tasks', () => {
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'doomscroll', taskVersion: 1,
            payload: { durationMinutes: 5, personality: 'casual', likeEnabled: true, saveEnabled: false },
        },
        timing: { kind: 'daily', localTime: '09:00', timezone: 'Asia/Kolkata' },
    });
    assert.equal(value.task.payload.durationMinutes, 5);
});

test('recurring public posts require confirmation', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'post', taskVersion: 1,
            payload: {
                media: [{ assetId: 'asset-1', name: 'video.mp4', mimeType: 'video/mp4' }],
                destination: 'publish', account: '@internal',
            },
        },
        timing: { kind: 'weekly', localTime: '10:00', timezone: 'Asia/Kolkata', weekdays: [1] },
    }), /explicit confirmation/);
});

/** Every post goes through the shared format table; these are the answers it gives back. */
function validatePost(payload: JsonObject) {
    return new PluginRegistry([plugin]).validate({
        deviceUdid: 'device-12345678',
        task: { pluginId: plugin.id, taskType: 'post', taskVersion: 1, payload },
        timing: { kind: 'now' },
    }).task.payload;
}

const CLIP = { assetId: 'asset-1', name: 'clip.mp4', mimeType: 'video/mp4' };

function shot(index: number) {
    return { assetId: `asset-${index}`, name: `shot-${index}.jpg`, mimeType: 'image/jpeg' };
}

test('a post task without a format is still a video, exactly as it was', () => {
    const payload = validatePost({ media: [CLIP], destination: 'draft', account: '@internal' });
    assert.equal(payload.format, 'video');
    assert.equal(payload.cover, undefined);
});

test('the post task accepts a photo and a slideshow of up to 35 images', () => {
    assert.equal(validatePost({ media: [shot(1)], destination: 'draft', account: '@internal' }).format, 'photo');
    const slideshow = validatePost({
        media: [shot(1), shot(2), shot(3)], format: 'slideshow', cover: 2, destination: 'draft', account: '@internal',
    });
    assert.equal(slideshow.format, 'slideshow');
    assert.equal(slideshow.cover, 2);
    // The order the media arrived in is the order it stays in — it is the post.
    assert.deepEqual((slideshow.media as Array<{ assetId: string }>).map(({ assetId }) => assetId),
        ['asset-1', 'asset-2', 'asset-3']);
    const many = Array.from({ length: 35 }, (_, index) => shot(index));
    assert.equal(validatePost({ media: many, destination: 'draft', account: '@internal' }).format, 'slideshow');
    assert.throws(() => validatePost({ media: [...many, shot(99)], destination: 'draft', account: '@internal' }),
        /2 to 35 images/);
});

test('the post task refuses a video and images in the same post', () => {
    assert.throws(() => validatePost({
        media: [CLIP, shot(1)], destination: 'draft', account: '@internal',
    }), /one video or a set of images, never both/);
    // Two clips are one video post: TikTok's composer stitches them.
    assert.equal(validatePost({
        media: [CLIP, { assetId: 'asset-2', name: 'b.mp4', mimeType: 'video/mp4' }],
        destination: 'draft', account: '@internal',
    }).format, 'video');
    // A cover on a video is a caller confusing the two formats.
    assert.throws(() => validatePost({ media: [CLIP], cover: 0, destination: 'draft', account: '@internal' }),
        /only applies to a slideshow/);
});
