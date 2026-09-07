import type { DeviceIdentity } from '@git-agni/backline';

/**
 * What the plugin hands a posting routine. One vertical video, a title, and where it should end up
 * — the Shorts equivalent of `src/tiktok/post-manifest.ts`.
 */
export interface YouTubePostManifest {
    device: DeviceIdentity;
    /** Exactly one video file; a Short is one clip, never a slideshow. */
    files: Array<{ path: string; name: string; mimeType: string }>;
    /** The Short's title. YouTube caps this at 100 characters. */
    title: string;
    /** The description YouTube puts under the Short; the dashboard calls it the caption. */
    caption?: string;
    /** The channel to post from, switched to through the avatar / account list. */
    account?: string;
    destination: 'draft' | 'publish';
    /**
     * Whether this Short is marked "made for kids". Absent means "not made for kids", which is
     * what a farm account almost always wants and what the audience step selects.
     */
    madeForKids?: boolean;
}
