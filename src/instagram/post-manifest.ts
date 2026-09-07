import type { DeviceIdentity } from '../types.js';

/**
 * What one Instagram upload is, as the plugin hands it to a routine.
 *
 * Instagram keeps its own manifest rather than borrowing TikTok's: the two apps disagree about
 * what a post *is*. TikTok has one composer that takes a clip or a slideshow; Instagram makes the
 * operator choose a surface up front — a reel, a single photo, or a carousel — and the picker,
 * the editor and the confirmation string are different on each of them. `format` is therefore
 * part of the manifest, not something a routine infers halfway through the flow.
 */

export type InstagramFormat = 'reel' | 'photo' | 'carousel';

export const INSTAGRAM_FORMATS: readonly InstagramFormat[] = ['reel', 'photo', 'carousel'];

export interface InstagramMediaFile {
    path: string;
    name: string;
    mimeType: string;
}

export interface InstagramPostManifest {
    device: DeviceIdentity;
    files: InstagramMediaFile[];
    format: InstagramFormat;
    caption?: string;
    account?: string;
    destination: 'draft' | 'publish';
}

/** Instagram's own carousel bounds. */
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 20;

/** Instagram's caption limit. */
export const MAX_CAPTION_LENGTH = 2_200;

export function isInstagramFormat(value: unknown): value is InstagramFormat {
    return typeof value === 'string' && INSTAGRAM_FORMATS.includes(value as InstagramFormat);
}

type MediaLike = { mimeType: string };

function counts(files: readonly MediaLike[]): { videos: number; images: number } {
    return {
        videos: files.filter(({ mimeType }) => mimeType.startsWith('video/')).length,
        images: files.filter(({ mimeType }) => mimeType.startsWith('image/')).length,
    };
}

/**
 * Why this set of files cannot be posted in this format, or `undefined` when it can.
 *
 * A sentence rather than a boolean, because every caller — the task validator, the upload route
 * and the routine itself — shows it straight to an operator. Mixing a clip into a carousel is the
 * failure worth naming loudest: Instagram accepts it in its own composer but the automated flow
 * cannot drive the two different editors it opens.
 */
export function formatProblem(format: InstagramFormat, files: readonly MediaLike[]): string | undefined {
    const { videos, images } = counts(files);
    if (videos + images !== files.length) return 'Every file must be an image or a video';
    if (videos > 0 && images > 0) return 'A post is either video or images — Instagram cannot mix them in one upload';
    if (format === 'reel') {
        return files.length === 1 && videos === 1 ? undefined : 'A reel is exactly one video file';
    }
    if (format === 'photo') {
        return files.length === 1 && images === 1 ? undefined : 'A photo post is exactly one image file';
    }
    if (images !== files.length) return `A carousel is ${CAROUSEL_MIN}–${CAROUSEL_MAX} images`;
    if (files.length < CAROUSEL_MIN || files.length > CAROUSEL_MAX) {
        return `A carousel is ${CAROUSEL_MIN}–${CAROUSEL_MAX} images; this one has ${files.length}`;
    }
    return undefined;
}

export function assertFormat(format: InstagramFormat, files: readonly MediaLike[]): void {
    const problem = formatProblem(format, files);
    if (problem) throw new Error(problem);
}

/**
 * The format a set of files can only be, for the callers that upload first and ask later (the
 * Control Center's "Schedule post", the device panel). Throws when the files are not a valid post
 * in any format at all, so nothing is scheduled that cannot run.
 */
export function formatForMedia(files: readonly MediaLike[]): InstagramFormat {
    for (const format of INSTAGRAM_FORMATS) {
        if (!formatProblem(format, files)) return format;
    }
    throw new Error(formatProblem('carousel', files) ?? 'These files are not a valid Instagram post');
}
