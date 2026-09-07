import type { DeviceIdentity } from '@git-agni/backline';

export interface PostManifest {
    device: DeviceIdentity;
    files: Array<{ path: string; name: string; mimeType: string }>;
    musicUrl?: string;
    caption?: string;
    account?: string;
    destination: 'draft' | 'publish';
    /** Which TikTok composer to drive. Absent means 'video' — see src/tiktok/post-format.ts. */
    format?: 'video' | 'photo' | 'slideshow';
    /** Index into `files` of the slide to use as the post's cover. */
    cover?: number;
}
