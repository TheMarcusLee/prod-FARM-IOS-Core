import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A fingerprint of the migrations that have already been applied, and of the
 * database they were applied to.
 *
 * The migrations service is a one-shot that runs before `worker` and `web`, which
 * means it also runs on every "restart all", every settings change and every
 * launch of the app — spawning a whole Node process and connecting to Postgres to
 * discover, a second or two later, that there is nothing to do. Worse, it does
 * that while the operator is watching a service list that says `starting`.
 *
 * The stamp turns that into "once per version": it is written only after a run
 * that exited 0, and it is keyed on the migration files themselves, so a new
 * `.sql` file, an edited one, a new app version or a different database all make
 * it stale and the migrations run again. The failure mode is deliberately biased:
 * anything unexpected — an unreadable directory, a missing stamp, a stamp that
 * cannot be parsed — means "run them", never "skip them".
 */
export interface MigrationStampInput {
    /** The repository's `drizzle/` directory. */
    migrationsDir: string;
    /** Which database this would run against; changing it must re-run. */
    databaseIdentity: string;
    /** The app version, so a release that changes the runner re-runs it. */
    appVersion: string;
}

/** `host:port/database` — the identity of a server, with no credentials in it. */
export function databaseIdentity(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
    } catch {
        // Unparseable: give every such URL its own identity so nothing is skipped.
        return `unparseable:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
    }
}

/** Every `.sql` file under `dir`, recursively, relative and sorted. */
function migrationFiles(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string, prefix: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
            else if (entry.name.endsWith('.sql')) found.push(relative);
        }
    };
    walk(dir, '');
    return found;
}

/**
 * The fingerprint, or null when it cannot be computed — which always means
 * "run the migrations", never "assume they are done".
 */
export function migrationFingerprint(input: MigrationStampInput): string | null {
    let files: string[];
    try {
        files = migrationFiles(input.migrationsDir);
    } catch {
        return null;
    }
    if (files.length === 0) return null;
    const hash = createHash('sha256');
    hash.update(`v1\n${input.appVersion}\n${input.databaseIdentity}\n`);
    for (const file of files) {
        try {
            hash.update(`${file}\n`);
            hash.update(readFileSync(path.join(input.migrationsDir, file)));
        } catch {
            return null;
        }
    }
    return hash.digest('hex');
}

/** Reads the stamp file, or null when it is absent, unreadable or malformed. */
export function readStamp(file: string): string | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const value = (parsed as { fingerprint?: unknown })?.fingerprint;
        return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

/** True when this exact set of migrations has already run against this database. */
export function migrationsAlreadyApplied(file: string, fingerprint: string | null): boolean {
    if (fingerprint === null) return false;
    return readStamp(file) === fingerprint;
}

/** Records a successful run. Never throws: a stamp that cannot be written just re-runs. */
export function writeStamp(file: string, fingerprint: string | null, at = new Date()): void {
    if (fingerprint === null) return;
    try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(
            file,
            `${JSON.stringify({ fingerprint, appliedAt: at.toISOString() }, null, 2)}\n`,
            { mode: 0o600 },
        );
    } catch { /* the next launch will simply run the migrations again */ }
}

/** Removes the stamp, so the next start runs the migrations whatever happens. */
export function clearStamp(file: string): void {
    try {
        if (existsSync(file)) writeFileSync(file, '{}\n', { mode: 0o600 });
    } catch { /* nothing to do */ }
}
