import type { DeviceIdentity } from '@git-agni/backline';

import type { PostFormat } from '../content/formats.js';

export interface PostManifest {
    device: DeviceIdentity;
    /**
     * One video for `video`, one image for `photo`, and the slides **in order**
     * for `slideshow`. The order is the post's order; nothing downstream sorts it.
     */
    files: Array<{ path: string; name: string; mimeType: string }>;
    /** Absent means `video` — every manifest written before formats existed was one. */
    format?: PostFormat;
    /** Index into `files` of the slide the post leads with. Slideshow only. */
    cover?: number;
    musicUrl?: string;
    caption?: string;
    account?: string;
    destination: 'draft' | 'publish';
    /** Which TikTok composer to drive. Absent means 'video' — see src/tiktok/post-format.ts. */
    format?: 'video' | 'photo' | 'slideshow';
    /** Index into `files` of the slide to use as the post's cover. */
    cover?: number;
}
