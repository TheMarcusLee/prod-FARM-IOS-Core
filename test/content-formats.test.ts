import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_POST_FORMAT, FormatError, inferFormat, isImageMimeType, isVideoMimeType, limitsFor, postFormat,
    ratioNotes, recommendedRatioLabel, validatePostMedia, type MediaFile,
} from '../src/content/formats.js';

function image(name: string, mimeType = 'image/jpeg', size?: [number, number]): MediaFile {
    return { name, mimeType, ...(size ? { width: size[0], height: size[1] } : {}) };
}

function video(name = 'clip.mp4', mimeType = 'video/mp4'): MediaFile {
    return { name, mimeType };
}

function images(count: number): MediaFile[] {
    return Array.from({ length: count }, (_, index) => image(`shot-${index}.jpg`));
}

function refusal(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof FormatError, `expected a FormatError, got ${String(error)}`);
        assert.equal(error.statusCode, 400);
        return error.message;
    }
    return assert.fail('expected the media to be refused');
}

test('an absent format still means video, so every post written before formats keeps working', () => {
    assert.equal(DEFAULT_POST_FORMAT, 'video');
    assert.equal(postFormat(undefined), 'video');
    assert.equal(postFormat(null), 'video');
    assert.equal(postFormat(''), 'video');
    assert.equal(postFormat('slideshow'), 'slideshow');
    assert.match(refusal(() => postFormat('carousel')), /video, photo, slideshow/);
});

test('the format of a post is read off its files', () => {
    assert.equal(inferFormat([video()]), 'video');
    assert.equal(inferFormat([image('a.jpg')]), 'photo');
    assert.equal(inferFormat(images(2)), 'slideshow');
    assert.equal(inferFormat(images(35)), 'slideshow');
    assert.equal(inferFormat([]), null);
    // No format at all, which is what a caller has to reject rather than guess at.
    assert.equal(inferFormat([video(), image('a.jpg')]), null);
    assert.equal(inferFormat([video('one.mp4'), video('two.mp4')]), null);
});

test('mixed media is named as mixed media, not as a count problem', () => {
    const message = refusal(() => validatePostMedia({ network: 'tiktok', files: [video(), image('a.jpg')] }));
    assert.match(message, /one video or a set of images, never both/);
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: [video('a.mp4'), video('b.mp4')] })),
        /one video, not several/);
});

test('TikTok takes one video, one photo, and 2 to 35 slideshow images', () => {
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: [video()] }), { format: 'video' });
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: [image('a.jpg')] }), { format: 'photo' });
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: images(2) }), { format: 'slideshow' });
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: images(35) }), { format: 'slideshow' });
    assert.equal(limitsFor('tiktok', 'slideshow')?.maxFiles, 35);
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: images(36) })), /2 to 35 images/);
});

test('Instagram stops a carousel at 20, from the same table', () => {
    assert.deepEqual(validatePostMedia({ network: 'instagram', files: images(20) }), { format: 'slideshow' });
    assert.match(refusal(() => validatePostMedia({ network: 'instagram', files: images(21) })), /2 to 20 images/);
    assert.equal(limitsFor('instagram', 'slideshow')?.maxFiles, 20);
});

test('a declared format that disagrees with the files is refused, not quietly rewritten', () => {
    assert.match(
        refusal(() => validatePostMedia({ network: 'tiktok', format: 'slideshow', files: [image('a.jpg')] })),
        /a photo post, not a slideshow/,
    );
    assert.match(
        refusal(() => validatePostMedia({ network: 'tiktok', format: 'video', files: images(3) })),
        /a slideshow post, not a video/,
    );
    // Agreeing is the normal case and passes the declaration straight through.
    assert.deepEqual(validatePostMedia({ network: 'tiktok', format: 'slideshow', files: images(3) }),
        { format: 'slideshow' });
});

test('image types are an explicit list; video stays as permissive as it was', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
        assert.ok(isImageMimeType(type), type);
        assert.deepEqual(validatePostMedia({ network: 'tiktok', files: [image('a', type)] }), { format: 'photo' });
    }
    assert.equal(isImageMimeType('image/gif'), false);
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: [image('loop.gif', 'image/gif')] })),
        /must be an image this network accepts/);
    // A charset parameter is not a different type.
    assert.ok(isImageMimeType('image/jpeg; charset=binary'));
    assert.ok(isVideoMimeType('video/x-matroska'));
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: [video('a.mkv', 'video/x-matroska')] }),
        { format: 'video' });
});

test('a cover picks a slide, and only a slideshow has one', () => {
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: images(4), cover: 2 }),
        { format: 'slideshow', cover: 2 });
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: images(4), cover: '0' }),
        { format: 'slideshow', cover: 0 });
    assert.deepEqual(validatePostMedia({ network: 'tiktok', files: images(4) }), { format: 'slideshow' });
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: images(4), cover: 4 })), /between 0 and 3/);
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: images(4), cover: -1 })), /between 0 and 3/);
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: [video()], cover: 0 })),
        /only applies to a slideshow/);
});

test('an empty post is refused before anything else is inspected', () => {
    assert.match(refusal(() => validatePostMedia({ network: 'tiktok', files: [] })), /at least one file/);
});

test('ratios are advice: noted for the operator, never a rejection', () => {
    assert.equal(recommendedRatioLabel('tiktok', 'slideshow'), '9:16 or 3:4');
    assert.equal(recommendedRatioLabel('tiktok', 'video'), '9:16');
    assert.deepEqual(ratioNotes('tiktok', 'slideshow', [image('a.jpg', 'image/jpeg', [1080, 1920])]), []);
    assert.deepEqual(ratioNotes('tiktok', 'slideshow', [image('b.jpg', 'image/jpeg', [1080, 1440])]), []);
    const [note] = ratioNotes('tiktok', 'slideshow', [image('wide.jpg', 'image/jpeg', [1920, 1080])]);
    assert.equal(note?.name, 'wide.jpg');
    assert.equal(note?.outOfRange, false, 'TikTok has no hard band, so this is taste only');
    // Instagram does have one, and a 9:16 still is outside it.
    const [cropped] = ratioNotes('instagram', 'photo', [image('tall.jpg', 'image/jpeg', [1080, 1920])]);
    assert.equal(cropped?.outOfRange, true);
    // Dimensions we do not know cannot be judged.
    assert.deepEqual(ratioNotes('tiktok', 'slideshow', [image('unknown.jpg')]), []);
});
