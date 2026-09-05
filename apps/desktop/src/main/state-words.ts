import type { JobSnapshot, ServiceState } from './types.ts';

/**
 * The words the Rig window, the menu-bar item and the tray tooltip all use.
 *
 * `healthy`, `not-configured` and the rest are the supervisor's vocabulary, not
 * an operator's. docs/design/backline.md asks for plain words and exactly these
 * — Running, Starting, Idle, Not configured, Failed — so the translation lives
 * in one place rather than once per surface. Pure, so it is testable without
 * Electron and shared by the main process and the renderer.
 */
export function serviceWord(state: ServiceState): string {
    switch (state) {
        case 'healthy': return 'Running';
        case 'starting': return 'Starting';
        case 'stopping': return 'Stopping';
        case 'failed': return 'Failed';
        case 'not-configured': return 'Not configured';
        default: return 'Idle';
    }
}

/** The token colour class a state maps onto (`bl-dot`/`bl-state` modifiers). */
export function serviceTone(state: ServiceState): 'ok' | 'accent' | 'warn' | 'bad' | 'idle' {
    switch (state) {
        case 'healthy': return 'ok';
        case 'starting': case 'stopping': return 'accent';
        case 'failed': return 'bad';
        case 'stopped': return 'warn';
        default: return 'idle';
    }
}

/** The same, for the one-shot jobs that share the service row. */
export function jobWord(job: JobSnapshot): string {
    switch (job.state) {
        case 'checking': return 'Checking';
        case 'running': return 'Running';
        case 'succeeded': return 'Done';
        case 'failed': return 'Failed';
        case 'blocked': return 'Needs you';
        default: return 'Cancelled';
    }
}

export function jobTone(job: JobSnapshot): 'ok' | 'accent' | 'warn' | 'bad' | 'idle' {
    switch (job.state) {
        case 'checking': case 'running': return 'accent';
        case 'succeeded': return 'ok';
        case 'failed': case 'blocked': return 'bad';
        default: return 'idle';
    }
}
