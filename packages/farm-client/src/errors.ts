/**
 * One error type for every failure the app can see, so a screen switches on
 * `kind` rather than on a status number it has to remember the meaning of.
 */

export type FarmErrorKind =
    | 'validation' // 400
    | 'unauthorized' // 401
    | 'forbidden' // 403 — missing Bearer on a write (CSRF guard)
    | 'not-found' // 404
    | 'conflict' // 409 — state conflict, the interesting one
    | 'rate-limited' // 429
    | 'unavailable' // 503 — subsystem down / device flapping
    | 'server' // 5xx
    | 'network' // could not reach the Mac at all
    | 'timeout' // took longer than the client's budget
    | 'aborted' // caller cancelled
    | 'parse' // 2xx but the body was not the shape we expect
    | 'unknown';

export class FarmError extends Error {
    readonly kind: FarmErrorKind;
    readonly status?: number;
    readonly url?: string;
    readonly cause?: unknown;

    constructor(
        kind: FarmErrorKind,
        message: string,
        options: { status?: number; url?: string; cause?: unknown } = {},
    ) {
        super(message);
        this.name = 'FarmError';
        this.kind = kind;
        this.status = options.status;
        this.url = options.url;
        this.cause = options.cause;
        // Keep `instanceof` working after the TS/Babel class transform.
        Object.setPrototypeOf(this, FarmError.prototype);
    }

    /** Retrying the identical request could plausibly succeed. */
    get retryable(): boolean {
        return (
            this.kind === 'network' ||
            this.kind === 'timeout' ||
            this.kind === 'server' ||
            this.kind === 'unavailable' ||
            this.kind === 'rate-limited'
        );
    }

    /** The user can fix this by fixing their credentials. */
    get authFailure(): boolean {
        return this.kind === 'unauthorized' || this.kind === 'forbidden';
    }
}

export function kindForStatus(status: number): FarmErrorKind {
    switch (status) {
        case 400:
            return 'validation';
        case 401:
            return 'unauthorized';
        case 403:
            return 'forbidden';
        case 404:
            return 'not-found';
        case 409:
            return 'conflict';
        case 429:
            return 'rate-limited';
        case 503:
            return 'unavailable';
        default:
            return status >= 500 ? 'server' : status >= 400 ? 'validation' : 'unknown';
    }
}

const DEFAULT_MESSAGES: Record<FarmErrorKind, string> = {
    validation: 'The farm rejected the request.',
    unauthorized: 'The token was missing or is no longer valid.',
    forbidden: 'The farm refused the write — the app sent no bearer token.',
    'not-found': 'That is gone, or was never there.',
    conflict: 'The farm is in a state that does not allow this right now.',
    'rate-limited': 'Too many requests — slow down.',
    unavailable: 'That part of the farm is unavailable right now.',
    server: 'The farm hit an internal error.',
    network: "Can't reach the Mac.",
    timeout: 'The Mac did not answer in time.',
    aborted: 'Request cancelled.',
    parse: 'The farm answered with something this app did not understand.',
    unknown: 'Something went wrong.',
};

export function defaultMessageFor(kind: FarmErrorKind): string {
    return DEFAULT_MESSAGES[kind];
}

/**
 * Every farm failure is `{ "error": string }` (`setErrorHandler`). A `503` from
 * `/remote/screenshot` is deliberately empty-bodied, so fall back to a default.
 */
export function errorFromResponse(status: number, body: string, url?: string): FarmError {
    const kind = kindForStatus(status);
    let message = '';
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
                message = (parsed as { error: string }).error;
            }
        } catch {
            // Not JSON after all — fall through to the default text.
        }
    }
    return new FarmError(kind, message || defaultMessageFor(kind), { status, url });
}
