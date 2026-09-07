/**
 * What a post is made of, and what each network will take.
 *
 * Today a post is one video. `photo` is one image and `slideshow` is an ordered
 * set of images, so every consumer — the drip planner, the TikTok post task, the
 * MCP tools and the dashboard — has to agree on the same three words and the same
 * limits. That agreement lives here rather than in each of them.
 *
 * The table is per network because the second network is already being built: an
 * Instagram plugin lands beside the TikTok one, and its carousel is 2–20 images
 * where TikTok's slideshow is 2–35. Adding a network is adding an entry to
 * `NETWORKS`; nothing below it is TikTok-specific.
 */

export const POST_FORMATS = ['video', 'photo', 'slideshow'] as const;

export type PostFormat = (typeof POST_FORMATS)[number];

/** The default a manifest without a `format` means — every post predating formats was a video. */
export const DEFAULT_POST_FORMAT: PostFormat = 'video';

/**
 * HEIC is on the list because an iPhone hands one over untouched; the phone-side
 * routine converts it. What is *not* here is deliberate: GIF and AVIF are refused
 * rather than silently uploaded as a still.
 */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** The container ingest normalises to, plus what a phone or a browser commonly hands over. */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;

export class FormatError extends Error {
    readonly statusCode = 400;
}

function fail(message: string): never {
    throw new FormatError(message);
}

/** An aspect ratio as width ÷ height, which is how every check below compares them. */
export interface AspectRatio {
    label: string;
    ratio: number;
}

export const RATIO_9_16: AspectRatio = { label: '9:16', ratio: 9 / 16 };
export const RATIO_3_4: AspectRatio = { label: '3:4', ratio: 3 / 4 };
export const RATIO_4_5: AspectRatio = { label: '4:5', ratio: 4 / 5 };
export const RATIO_1_91_1: AspectRatio = { label: '1.91:1', ratio: 1.91 };

export interface FormatLimits {
    /** Which of the two media kinds every file in the post has to be. */
    mediaKind: 'video' | 'image';
    minFiles: number;
    maxFiles: number;
    /** Exact types accepted. A video format additionally accepts any `video/*`. */
    mimeTypes: readonly string[];
    /** Shapes that look right in the feed. Outside them is a warning, never a rejection. */
    recommendedRatios: readonly AspectRatio[];
    /** The band the network itself accepts, when it has one. */
    ratioRange?: { min: number; max: number };
}

export interface NetworkFormats {
    label: string;
    formats: Partial<Record<PostFormat, FormatLimits>>;
}

/**
 * TikTok photo mode takes up to 35 images. Instagram is here so the plugin being
 * built alongside this one has the same table to read; its carousel stops at 20
 * and its feed crops anything outside 4:5 … 1.91:1.
 */
export const NETWORKS = {
    tiktok: {
        label: 'TikTok',
        formats: {
            // TikTok's composer stitches up to three clips into one video, and the phone routines
            // already select more than one, so the old one-to-three allowance stays.
            video: {
                mediaKind: 'video', minFiles: 1, maxFiles: 3, mimeTypes: VIDEO_MIME_TYPES,
                recommendedRatios: [RATIO_9_16],
            },
            photo: {
                mediaKind: 'image', minFiles: 1, maxFiles: 1, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_9_16, RATIO_3_4],
            },
            slideshow: {
                mediaKind: 'image', minFiles: 2, maxFiles: 35, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_9_16, RATIO_3_4],
            },
        },
    },
    instagram: {
        label: 'Instagram',
        formats: {
            video: {
                mediaKind: 'video', minFiles: 1, maxFiles: 1, mimeTypes: VIDEO_MIME_TYPES,
                recommendedRatios: [RATIO_9_16],
            },
            photo: {
                mediaKind: 'image', minFiles: 1, maxFiles: 1, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_4_5], ratioRange: { min: RATIO_4_5.ratio, max: RATIO_1_91_1.ratio },
            },
            slideshow: {
                mediaKind: 'image', minFiles: 2, maxFiles: 20, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_4_5], ratioRange: { min: RATIO_4_5.ratio, max: RATIO_1_91_1.ratio },
            },
        },
    },
    /**
     * A Short is one vertical clip and nothing else — no photo surface, no
     * carousel. The absence matters: a cross-post rule that fans a slideshow out
     * across a creator's accounts has to be told YouTube will not take it, and an
     * empty entry here is how it finds that out.
     */
    youtube: {
        label: 'YouTube',
        formats: {
            video: {
                mediaKind: 'video', minFiles: 1, maxFiles: 1, mimeTypes: VIDEO_MIME_TYPES,
                recommendedRatios: [RATIO_9_16],
            },
        },
    },
    /** Threads takes one video, one image, or up to twenty images as a carousel. */
    threads: {
        label: 'Threads',
        formats: {
            video: {
                mediaKind: 'video', minFiles: 1, maxFiles: 1, mimeTypes: VIDEO_MIME_TYPES,
                recommendedRatios: [RATIO_9_16],
            },
            photo: {
                mediaKind: 'image', minFiles: 1, maxFiles: 1, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_4_5],
            },
            slideshow: {
                mediaKind: 'image', minFiles: 2, maxFiles: 20, mimeTypes: IMAGE_MIME_TYPES,
                recommendedRatios: [RATIO_4_5],
            },
        },
    },
} as const satisfies Record<string, NetworkFormats>;

export type Network = keyof typeof NETWORKS;

export function isPostFormat(value: unknown): value is PostFormat {
    return typeof value === 'string' && (POST_FORMATS as readonly string[]).includes(value);
}

/** An absent format is `video`: that is what every post written before this module was. */
export function postFormat(value: unknown): PostFormat {
    if (value === undefined || value === null || value === '') return DEFAULT_POST_FORMAT;
    if (!isPostFormat(value)) fail(`format must be one of ${POST_FORMATS.join(', ')}`);
    return value;
}

export function limitsFor(network: Network, format: PostFormat): FormatLimits | undefined {
    // The literal table narrows each network's `formats` to exactly the keys it
    // declares — YouTube has no `photo` at all — so the lookup is widened here
    // rather than forcing every network to carry entries it does not support.
    return (NETWORKS[network].formats as Partial<Record<PostFormat, FormatLimits>>)[format];
}

function normalizeMimeType(mimeType: string): string {
    return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

export function isImageMimeType(mimeType: string): boolean {
    return (IMAGE_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export function isVideoMimeType(mimeType: string): boolean {
    return normalizeMimeType(mimeType).startsWith('video/');
}

function accepts(limits: FormatLimits, mimeType: string): boolean {
    const normalized = normalizeMimeType(mimeType);
    if (limits.mimeTypes.includes(normalized)) return true;
    // A video is whatever the phone or the browser called it; the normalised copy
    // ingest produces is mp4 either way. Images stay on the explicit list.
    return limits.mediaKind === 'video' && normalized.startsWith('video/');
}

export interface MediaFile {
    name?: string;
    mimeType: string;
    width?: number;
    height?: number;
}

/**
 * The format a set of files *is*, before anyone declares one. One video is a
 * video, one image a photo, several images a slideshow. Mixed media has no
 * format, which is exactly the case callers have to reject.
 */
export function inferFormat(files: readonly MediaFile[]): PostFormat | null {
    if (!files.length) return null;
    // Several clips are still a video post; whether the network stitches them is its table's call.
    if (files.every(({ mimeType }) => isVideoMimeType(mimeType))) return 'video';
    if (files.every(({ mimeType }) => isImageMimeType(mimeType))) return files.length === 1 ? 'photo' : 'slideshow';
    return null;
}

export interface ValidatedPost {
    format: PostFormat;
    /** Index into `files` of the frame the post leads with. Slideshow only. */
    cover?: number;
}

export interface ValidatePostInput {
    network: Network;
    /** Omitted means "work it out from the files" — the backward-compatible path. */
    format?: unknown;
    files: readonly MediaFile[];
    cover?: unknown;
}

function coverIndex(value: unknown, format: PostFormat, count: number): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) fail('cover must be a whole number');
    if (format !== 'slideshow') fail('cover only applies to a slideshow');
    if (parsed < 0 || parsed >= count) fail(`cover must be between 0 and ${count - 1}`);
    return parsed;
}

/**
 * The one gate every caller goes through. It settles the format (declared or
 * inferred), refuses mixed media before anything else so the operator gets the
 * real reason rather than a count error, then checks the count, the types and the
 * cover index against the network's own table.
 */
export function validatePostMedia(input: ValidatePostInput): ValidatedPost {
    const { network, files } = input;
    if (!files.length) fail('A post needs at least one file');
    const inferred = inferFormat(files);
    if (!inferred) {
        const videos = files.filter(({ mimeType }) => isVideoMimeType(mimeType)).length;
        if (videos && videos < files.length) fail('A post is one video or a set of images, never both');
        fail('Every file in a post must be an image this network accepts');
    }
    const format = input.format === undefined || input.format === null || input.format === ''
        ? inferred
        : postFormat(input.format);
    const limits = limitsFor(network, format);
    if (!limits) fail(`${NETWORKS[network].label} does not support ${format} posts`);
    // A declared format that disagrees with the files is a mistake worth naming:
    // "slideshow" over a single image usually means an image did not upload.
    if (format !== inferred) {
        fail(`These files are a ${inferred} post, not a ${format} — ${describeCount(limits, format)}`);
    }
    if (files.length < limits.minFiles || files.length > limits.maxFiles) {
        fail(`${NETWORKS[network].label} ${format}: ${describeCount(limits, format)}`);
    }
    const offender = files.find((file) => !accepts(limits, file.mimeType));
    if (offender) {
        fail(`${offender.name ?? offender.mimeType} is not a ${format} ${NETWORKS[network].label} accepts`
            + ` — use ${limits.mimeTypes.map(shortType).join(', ')}`);
    }
    const cover = coverIndex(input.cover, format, files.length);
    return { format, ...(cover === undefined ? {} : { cover }) };
}

function shortType(mimeType: string): string {
    return mimeType.replace(/^(image|video)\//, '');
}

function describeCount(limits: FormatLimits, format: PostFormat): string {
    if (limits.minFiles === limits.maxFiles) {
        return `exactly ${limits.minFiles} ${limits.mediaKind === 'video' ? 'video' : 'image'}`;
    }
    return `${limits.minFiles} to ${limits.maxFiles} images make a ${format}`;
}

export interface RatioNote {
    name: string;
    ratio: number;
    recommended: readonly AspectRatio[];
    /** True when the network itself would crop or refuse it, not merely a taste note. */
    outOfRange: boolean;
}

const RATIO_TOLERANCE = 0.02;

/**
 * Shapes that will not look right. Advisory on purpose: a farm that refuses a
 * 1:1 image an operator deliberately chose is a farm they work around, so this
 * returns notes for the dashboard to show and never throws.
 */
export function ratioNotes(network: Network, format: PostFormat, files: readonly MediaFile[]): RatioNote[] {
    const limits = limitsFor(network, format);
    if (!limits) return [];
    const notes: RatioNote[] = [];
    for (const [index, file] of files.entries()) {
        if (!file.width || !file.height) continue;
        const ratio = file.width / file.height;
        const near = limits.recommendedRatios.some(({ ratio: wanted }) => Math.abs(ratio - wanted) <= RATIO_TOLERANCE);
        const outOfRange = Boolean(limits.ratioRange)
            && (ratio < limits.ratioRange!.min - RATIO_TOLERANCE || ratio > limits.ratioRange!.max + RATIO_TOLERANCE);
        if (near && !outOfRange) continue;
        notes.push({
            name: file.name ?? `file ${index + 1}`, ratio, recommended: limits.recommendedRatios, outOfRange,
        });
    }
    return notes;
}

/** "9:16 or 3:4" — the phrasing the dashboard and the docs both use. */
export function recommendedRatioLabel(network: Network, format: PostFormat): string {
    const labels = limitsFor(network, format)?.recommendedRatios.map(({ label }) => label) ?? [];
    if (labels.length < 2) return labels[0] ?? '';
    return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}
