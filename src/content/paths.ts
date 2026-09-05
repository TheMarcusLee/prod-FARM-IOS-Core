import path from 'node:path';

/** Everything the scheduler owns lives under here; asset paths are relative to it. */
export function dataRoot(): string {
    return path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
}

/**
 * Where originals, normalised copies and posters live. Kept inside the data
 * root by default so the scheduler's own asset purge can still reach the
 * per-post copies it creates.
 */
export function contentRoot(): string {
    return process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR) : path.join(dataRoot(), 'content');
}

/** Relative-to-data-root form, which is what the assets table stores. */
export function relativeToData(absolute: string): string {
    return path.relative(dataRoot(), absolute);
}

/** Strips anything that could escape a directory or confuse a shell-free exec. */
export function safeFileName(name: string): string {
    const base = path.basename(name || 'media').replace(/[^A-Za-z0-9._-]/g, '_');
    return base.replace(/^\.+/, '').slice(0, 120) || 'media';
}
