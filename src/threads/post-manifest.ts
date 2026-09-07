import type { DeviceIdentity } from '../types.js';

/** What a thread is made of. Derived from the media, never sent by the dashboard. */
export type ThreadFormat = 'text' | 'photo' | 'carousel' | 'video';

/** Threads' own limit on the body of a single post. */
export const MAX_THREAD_LENGTH = 500;

/** A thread may carry up to twenty images, or exactly one video, or no media at all. */
export const MAX_THREAD_IMAGES = 20;

export interface ThreadsPostManifest {
    device: DeviceIdentity;
    /** Ordered: files[0] is the first card of a carousel. Empty for a text-only thread. */
    files: Array<{ path: string; name: string; mimeType: string }>;
    /** The body of the thread. Required unless the post carries media. */
    text?: string;
    account?: string;
    destination: 'draft' | 'publish';
}

export function isVideo(mimeType: string): boolean {
    return mimeType.toLowerCase().startsWith('video/');
}

export function isImage(mimeType: string): boolean {
    return mimeType.toLowerCase().startsWith('image/');
}

/**
 * The one place that decides what shape a post is, so the plugin, the routines and the logs all
 * agree. Throws on anything Threads will not accept — in particular a mix of images and video,
 * which the composer silently drops rather than refusing.
 */
export function threadFormat(
    files: ReadonlyArray<{ name: string; mimeType: string }>,
    text?: string,
): ThreadFormat {
    const videos = files.filter(({ mimeType }) => isVideo(mimeType));
    const images = files.filter(({ mimeType }) => isImage(mimeType));
    if (videos.length + images.length !== files.length) {
        const other = files.find(({ mimeType }) => !isVideo(mimeType) && !isImage(mimeType))!;
        throw new Error(`${other.name} is ${other.mimeType}; a thread takes images or a video`);
    }
    if (videos.length && images.length) {
        throw new Error('A thread carries images or one video, not both');
    }
    if (videos.length > 1) throw new Error('A thread carries at most one video');
    if (images.length > MAX_THREAD_IMAGES) {
        throw new Error(`A thread carries at most ${MAX_THREAD_IMAGES} images; ${images.length} were given`);
    }
    if (videos.length === 1) return 'video';
    if (images.length > 1) return 'carousel';
    if (images.length === 1) return 'photo';
    if (!text?.trim()) throw new Error('A thread with no media needs text');
    return 'text';
}

export function describeFormat(format: ThreadFormat, files: number): string {
    return format === 'carousel' ? `carousel · ${files} images` : format;
}
