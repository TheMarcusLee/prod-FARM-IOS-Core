/**
 * What kind of post a manifest describes, and whether its files can actually make one.
 *
 * TikTok has three composers behind the same Upload button: a video post, a single photo post,
 * and a photo slideshow. They accept different media, and getting it wrong is only discovered
 * half way through the editor on the phone — after the media has been pushed or imported. Both
 * platform routines (and the plugin, before it ever schedules anything) run the manifest through
 * `assertPostFormat` first, so a bad combination fails as a sentence rather than as a stuck phone.
 *
 * A manifest with no `format` is a video post: that is what every manifest written before photo
 * mode existed meant, and nothing about the video path changes.
 */

export type PostFormat = 'video' | 'photo' | 'slideshow';

export const POST_FORMATS: readonly PostFormat[] = ['video', 'photo', 'slideshow'];

/** TikTok's own ceiling on a photo slideshow. */
export const MAX_SLIDESHOW_IMAGES = 35;

/** The image types TikTok's picker will hand to the photo composer. */
export const IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/** Enough of a manifest file entry to judge it; the real one carries a path as well. */
export interface PostMediaLike {
    name: string;
    mimeType: string;
}

function normalize(mimeType: string): string {
    // "image/jpeg; charset=binary" and "IMAGE/JPEG" are both things a multipart upload can send.
    return mimeType.split(';')[0]!.trim().toLowerCase();
}

export function isImage({ mimeType }: PostMediaLike): boolean {
    return normalize(mimeType).startsWith('image/');
}

export function isVideo({ mimeType }: PostMediaLike): boolean {
    return normalize(mimeType).startsWith('video/');
}

export function isSupportedImage({ mimeType }: PostMediaLike): boolean {
    return IMAGE_MIME_TYPES.includes(normalize(mimeType));
}

/** Absent means video — see the file comment. Anything else is a typo worth naming. */
export function resolvePostFormat(format: string | undefined): PostFormat {
    if (format === undefined || format === null || format === '') return 'video';
    if ((POST_FORMATS as readonly string[]).includes(format)) return format as PostFormat;
    throw new Error(`Unknown post format "${format}" — use ${POST_FORMATS.join(', ')}`);
}

export interface PostFormatInput {
    format?: string;
    files: readonly PostMediaLike[];
    /** Index into `files` of the slide to use as the post's cover. */
    cover?: number;
}

/**
 * The one validation both platforms and the plugin share. Returns the resolved format so a caller
 * can branch on it without re-deriving the default.
 */
export function assertPostFormat({ format, files, cover }: PostFormatInput): PostFormat {
    const resolved = resolvePostFormat(format);
    if (files.length === 0) throw new Error('A post needs at least one media file');

    const videos = files.filter(isVideo);
    const images = files.filter(isImage);
    // Mixed media has no composer at all: TikTok's picker refuses the selection, and by then the
    // files are already on the phone. Refuse it for every format, including video.
    if (videos.length > 0 && images.length > 0) {
        throw new Error(
            `A post is either one video or a set of images, not both — this one has ${videos.length} video(s) `
            + `and ${images.length} image(s): ${files.map(({ name }) => name).join(', ')}`,
        );
    }

    if (resolved !== 'video') {
        if (videos.length > 0) {
            throw new Error(`A ${resolved} post takes images, but ${videos.map(({ name }) => name).join(', ')} is video`);
        }
        const unsupported = files.filter((file) => !isSupportedImage(file));
        if (unsupported.length > 0) {
            throw new Error(
                `TikTok photo mode accepts ${IMAGE_MIME_TYPES.join(', ')}; `
                + `${unsupported.map(({ name, mimeType }) => `${name} is ${mimeType}`).join(', ')}`,
            );
        }
    }

    if (resolved === 'photo' && files.length !== 1) {
        throw new Error(`A photo post takes exactly one image; this one has ${files.length}. Use format "slideshow" for more.`);
    }
    if (resolved === 'slideshow' && (files.length < 2 || files.length > MAX_SLIDESHOW_IMAGES)) {
        throw new Error(
            `A slideshow takes 2 to ${MAX_SLIDESHOW_IMAGES} images; this one has ${files.length}.`
            + (files.length < 2 ? ' Use format "photo" for a single image.' : ''),
        );
    }

    if (cover !== undefined) {
        if (!Number.isInteger(cover) || cover < 0 || cover >= files.length) {
            throw new Error(`cover must be an index between 0 and ${files.length - 1}; got ${cover}`);
        }
    }

    return resolved;
}

/** True when the routine should drive TikTok's photo composer rather than the video one. */
export function isPhotoFormat(format: PostFormat): boolean {
    return format === 'photo' || format === 'slideshow';
}
