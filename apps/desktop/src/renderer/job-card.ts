import type { JobSnapshot } from './global.d.ts';

/** Maps a job state onto the same dot colours the services use. */
export function jobDotClass(job: JobSnapshot): string {
    switch (job.state) {
        case 'succeeded': return 'dot healthy';
        case 'failed': case 'blocked': return 'dot failed';
        case 'checking': case 'running': return 'dot starting';
        default: return 'dot';
    }
}

export function button(label: string, action: () => Promise<unknown> | void): HTMLButtonElement {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', () => {
        element.disabled = true;
        void Promise.resolve(action()).finally(() => { element.disabled = false; });
    });
    return element;
}

export interface JobCard {
    root: HTMLElement;
    update(job: JobSnapshot): void;
}

/**
 * The card a job shows in the Services panel and, larger, in its own window.
 * It stays on screen after the job ends: the result is the point.
 */
export function createJobCard(id: string, options: { showLogs: boolean }): JobCard {
    const root = document.createElement('section');
    root.className = 'service job';

    const head = document.createElement('div');
    head.className = 'service-head';
    const dot = document.createElement('span');
    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('h2');
    const detail = document.createElement('div');
    detail.className = 'detail';
    const command = document.createElement('div');
    command.className = 'command';
    grow.append(title, detail, command);
    const state = document.createElement('span');
    state.className = 'state';

    const rerun = button('Run again', () => window.farm.prepareWda(null));
    const cancel = button('Cancel', () => window.farm.cancelJob(id));
    const dismiss = button('Dismiss', () => window.farm.dismissJob(id));
    const open = button('Open window', () => window.farm.openJob(id));

    head.append(dot, grow, state, rerun, cancel, dismiss);
    if (!options.showLogs) head.append(open);

    const checks = document.createElement('ul');
    checks.className = 'checks';
    const note = document.createElement('pre');
    note.className = 'note';
    const logs = document.createElement('pre');
    logs.className = 'logs';

    root.append(head, checks, note);
    if (options.showLogs) root.append(logs);

    return {
        root,
        update(job) {
            dot.className = jobDotClass(job);
            title.textContent = job.label;
            state.textContent = job.state;
            detail.textContent = job.detail;
            command.textContent = job.command;
            rerun.hidden = job.running;
            cancel.hidden = !job.running;
            dismiss.disabled = job.running;

            checks.textContent = '';
            for (const check of job.checks) {
                const item = document.createElement('li');
                item.className = check.ok ? 'ok' : 'bad';
                const mark = document.createElement('span');
                mark.className = 'mark';
                mark.textContent = check.ok ? '✓' : '✕';
                const label = document.createElement('span');
                label.className = 'label';
                label.textContent = check.label;
                const why = document.createElement('span');
                why.className = 'why';
                why.textContent = check.detail;
                item.append(mark, label, why);
                checks.append(item);
            }
            checks.hidden = job.checks.length === 0;

            note.textContent = job.note;
            if (!options.showLogs) return;
            const pinned = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 8;
            logs.textContent = job.lines.length
                ? job.lines.map((line) => line.text).join('\n')
                : '(no output yet)';
            if (pinned) logs.scrollTop = logs.scrollHeight;
        },
    };
}
