import type { LogLine } from './global.d.ts';

/** How much history the panel keeps, per docs/design/backline.md's log block. */
export const LIVE_LOG_LINES = 200;

function same(a: LogLine, b: LogLine): boolean {
    return a.at === b.at && a.stream === b.stream && a.text === b.text;
}

/**
 * Adds whatever is new in `incoming` to `existing`, keeping the last `limit`.
 *
 * Every snapshot carries the tail of a service's log, not a delta, so successive
 * snapshots overlap. Appending them all would repeat lines; replacing the panel
 * with the latest tail would throw away everything older than that window. The
 * longest suffix/prefix overlap is the join between the two.
 */
export function mergeTail(existing: LogLine[], incoming: readonly LogLine[], limit = LIVE_LOG_LINES): LogLine[] {
    if (incoming.length === 0) return existing.slice(-limit);
    let overlap = 0;
    for (let k = Math.min(existing.length, incoming.length); k > 0; k -= 1) {
        const tail = existing.slice(existing.length - k);
        if (tail.every((line, index) => same(line, incoming[index] as LogLine))) { overlap = k; break; }
    }
    return [...existing, ...incoming.slice(overlap)].slice(-limit);
}

export interface LiveLog {
    root: HTMLElement;
    /** Merge the latest tail in and, unless the operator scrolled away, follow it. */
    show(lines: readonly LogLine[]): void;
}

/**
 * The dark log panel: the last 200 lines, following the newest one until the
 * operator scrolls up. Scrolling up is a deliberate act — reading something —
 * so it stops the panel moving and offers the way back rather than yanking.
 */
export function createLiveLog(label: string, empty = 'Nothing logged yet.'): LiveLog {
    const root = document.createElement('div');
    root.className = 'bl-live';

    const caption = document.createElement('div');
    caption.className = 'bl-live-label';
    caption.textContent = label;

    const lines = document.createElement('div');
    lines.className = 'bl-live-lines';

    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'bl-live-resume';
    resume.textContent = 'Follow the newest line';
    resume.hidden = true;

    root.append(caption, lines, resume);

    let history: LogLine[] = [];
    let following = true;

    const atBottom = (): boolean => lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 8;
    const follow = (): void => { lines.scrollTop = lines.scrollHeight; };

    lines.addEventListener('scroll', () => {
        following = atBottom();
        resume.hidden = following;
    });
    resume.addEventListener('click', () => { following = true; resume.hidden = true; follow(); });

    return {
        root,
        show(incoming) {
            history = mergeTail(history, incoming);
            lines.textContent = '';
            if (history.length === 0) {
                const placeholder = document.createElement('div');
                placeholder.className = 'bl-live-empty';
                placeholder.textContent = empty;
                lines.append(placeholder);
                return;
            }
            for (const line of history) {
                const row = document.createElement('div');
                if (line.stream === 'err') row.className = 'bl-live-bad';
                row.textContent = line.text;
                lines.append(row);
            }
            if (following) follow();
        },
    };
}
