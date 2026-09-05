import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * Everything this module runs goes through execFile with an argument array —
 * never a shell string. Paths here come from operator-supplied directories and
 * uploaded filenames, so a shell would be a command-injection surface.
 */
const run = promisify(execFile);

export const TIKTOK_MAX_WIDTH = 1080;
export const TIKTOK_MAX_HEIGHT = 1920;
export const TIKTOK_MAX_SECONDS = 180;

export interface NormalizeOptions {
    input: string;
    output: string;
    /** Crop to fill 9:16 instead of padding to it. */
    crop?: boolean;
    width?: number;
    height?: number;
    maxSeconds?: number;
}

/** The 9:16 fit. Padding keeps the whole frame; cropping fills it and loses edges. */
export function buildScaleFilter(width: number, height: number, crop: boolean): string {
    return crop
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
            + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** Pure — the tests assert on this array rather than running ffmpeg. */
export function buildNormalizeArgs(options: NormalizeOptions): string[] {
    const width = options.width ?? TIKTOK_MAX_WIDTH;
    const height = options.height ?? TIKTOK_MAX_HEIGHT;
    const seconds = options.maxSeconds ?? TIKTOK_MAX_SECONDS;
    return [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', options.input,
        '-t', String(seconds),
        '-vf', `${buildScaleFilter(width, height, options.crop === true)},setsar=1`,
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast', '-crf', '23', '-r', '30',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-map_metadata', '-1', '-map_chapters', '-1',
        '-movflags', '+faststart',
        options.output,
    ];
}

export function buildProbeArgs(input: string): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
}

export interface PosterOptions { input: string; output: string; atSeconds?: number; width?: number; height?: number }

export function buildPosterArgs(options: PosterOptions): string[] {
    const width = options.width ?? 360;
    const height = options.height ?? 640;
    return [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', String(options.atSeconds ?? 1),
        '-i', options.input,
        '-frames:v', '1',
        '-vf', buildScaleFilter(width, height, false),
        options.output,
    ];
}

export interface MediaProbe {
    kind: 'video' | 'image';
    width: number;
    height: number;
    durationMs?: number;
    hasAudio: boolean;
}

interface ProbeStream { codec_type?: string; width?: number; height?: number; duration?: string; codec_name?: string }
interface ProbeOutput { streams?: ProbeStream[]; format?: { duration?: string } }

/** A single frame with no duration is a still, however ffprobe labels the stream. */
export function interpretProbe(output: ProbeOutput): MediaProbe {
    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
    const seconds = Number(output.format?.duration ?? video?.duration ?? '');
    const stillCodec = ['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff'].includes(video?.codec_name ?? '');
    const isVideo = Number.isFinite(seconds) && seconds > 0 && !(stillCodec && seconds < 0.2);
    return {
        kind: isVideo ? 'video' : 'image',
        width: video?.width ?? 0,
        height: video?.height ?? 0,
        ...(isVideo ? { durationMs: Math.round(seconds * 1000) } : {}),
        hasAudio,
    };
}

export interface MediaTools { ffmpeg: string; ffprobe: string }

async function onPath(command: string): Promise<boolean> {
    try {
        await run(command, ['-version'], { timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}

async function executable(candidate: string | null | undefined): Promise<string | null> {
    if (!candidate) return null;
    try {
        await access(candidate, constants.X_OK);
        return candidate;
    } catch {
        return null;
    }
}

/** Loaded through a variable specifier so a checkout without them still type-checks. */
async function optionalModule(specifier: string): Promise<Record<string, unknown> | null> {
    try {
        return await import(specifier) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function stringField(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

async function bundled(): Promise<Partial<MediaTools>> {
    const tools: Partial<MediaTools> = {};
    const ffmpegModule = await optionalModule('ffmpeg-static');
    const ffmpeg = await executable(stringField(ffmpegModule?.default));
    if (ffmpeg) tools.ffmpeg = ffmpeg;
    const ffprobeModule = await optionalModule('ffprobe-static');
    const container = (ffprobeModule?.default ?? ffprobeModule) as { path?: unknown } | undefined;
    const ffprobe = await executable(stringField(container?.path));
    if (ffprobe) tools.ffprobe = ffprobe;
    return tools;
}

let cached: Promise<MediaTools> | null = null;

/**
 * Prefer the operator's own ffmpeg (system codecs, hardware support); fall back
 * to the vendored static builds so a fresh checkout still ingests video.
 */
export async function resolveMediaTools(): Promise<MediaTools> {
    cached ??= (async () => {
        const fromEnv = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
        const [systemFfmpeg, systemFfprobe] = await Promise.all([
            fromEnv.ffmpeg ? executable(fromEnv.ffmpeg) : onPath('ffmpeg').then((ok) => ok ? 'ffmpeg' : null),
            fromEnv.ffprobe ? executable(fromEnv.ffprobe) : onPath('ffprobe').then((ok) => ok ? 'ffprobe' : null),
        ]);
        const fallback = systemFfmpeg && systemFfprobe ? {} : await bundled();
        const ffmpeg = systemFfmpeg ?? fallback.ffmpeg;
        const ffprobe = systemFfprobe ?? fallback.ffprobe;
        if (!ffmpeg || !ffprobe) {
            throw new Error(
                'FFmpeg is required to ingest media. Install ffmpeg and ffprobe (they must be on PATH, '
                + 'or set FFMPEG_PATH and FFPROBE_PATH), or install the ffmpeg-static and ffprobe-static packages.',
            );
        }
        return { ffmpeg, ffprobe };
    })();
    return cached;
}

/** Test seam — lets a suite pretend a tool is or is not available. */
export function setMediaTools(tools: MediaTools | null): void {
    cached = tools ? Promise.resolve(tools) : null;
}

export async function probeMedia(input: string): Promise<MediaProbe> {
    const { ffprobe } = await resolveMediaTools();
    const { stdout } = await run(ffprobe, buildProbeArgs(input), { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return interpretProbe(JSON.parse(stdout) as ProbeOutput);
}

export async function normalizeVideo(options: NormalizeOptions): Promise<void> {
    const { ffmpeg } = await resolveMediaTools();
    await run(ffmpeg, buildNormalizeArgs(options), { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}

export async function extractPoster(options: PosterOptions): Promise<void> {
    const { ffmpeg } = await resolveMediaTools();
    await run(ffmpeg, buildPosterArgs(options), { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}

/** yt-dlp is optional; a deployment without it gets a 501, never a broken shell command. */
export async function ytDlpPath(): Promise<string | null> {
    const configured = process.env.YT_DLP_PATH;
    if (configured) return executable(configured);
    return await onPath('yt-dlp') ? 'yt-dlp' : null;
}

export function buildYtDlpArgs(url: string, outputTemplate: string): string[] {
    return [
        '--no-playlist', '--no-progress', '--no-continue', '--restrict-filenames',
        '--max-filesize', '512M',
        '-f', 'bv*[height<=1920]+ba/b[height<=1920]/b',
        '--merge-output-format', 'mp4',
        '-o', outputTemplate,
        url,
    ];
}

export async function downloadWithYtDlp(binary: string, url: string, outputTemplate: string): Promise<void> {
    await run(binary, buildYtDlpArgs(url, outputTemplate), { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}
