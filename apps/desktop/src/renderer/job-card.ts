import { jobTone, jobWord } from '../main/state-words.ts';
import type { JobSnapshot } from './global.d.ts';
import { icon } from './icons.ts';

export function button(label: string, action: () => Promise<unknown> | void, className = 'bl-btn bl-btn-sm'): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
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
 * A one-shot job wears the same row as a service, because to an operator it is
 * the same kind of thing: a named part of the rig with a state. What is peculiar
 * to a job — the preconditions it checked, the command it ran, the part only a
 * human can do — lives in a disclosure, closed while it is going well.
 */
export function createJobCard(id: string, options: { showOpen: boolean }): JobCard {
    const root = document.createElement('section');
    root.className = 'bl-row';

    const head = document.createElement('div');
    head.className = 'bl-row-head';
    const dot = document.createElement('span');
    const grow = document.createElement('div');
    grow.className = 'bl-row-grow';
    const name = document.createElement('div');
    name.className = 'bl-row-name';
    const detail = document.createElement('div');
    detail.className = 'bl-row-detail';
    grow.append(name, detail);
    const state = document.createElement('span');

    // Only one kind of job exists so far; the button knows how to restart that one.
    const rerun = button('Run again', () => window.farm.prepareWda(null));
    const cancel = button('Cancel', () => window.farm.cancelJob(id));
    const dismiss = button('Dismiss', () => window.farm.dismissJob(id));
    const open = button('Open window', () => window.farm.openJob(id));

    // The same empty slot a service row keeps for its menu, so the states line up.
    const slot = document.createElement('span');
    slot.className = 'bl-row-menu';
    head.append(dot, grow, state, slot);
    const buttons = document.createElement('div');
    buttons.className = 'bl-row-buttons';
    buttons.append(rerun, cancel, dismiss);
    if (options.showOpen) buttons.append(open);

    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.append(icon('chevronRight'), document.createTextNode('Checklist and what you still have to do'));
    const body = document.createElement('div');
    body.className = 'bl-disclosure';
    const checks = document.createElement('ul');
    checks.className = 'bl-checks';
    const command = document.createElement('div');
    command.className = 'bl-command';
    const note = document.createElement('pre');
    note.className = 'bl-note';
    body.append(checks, command, note);
    disclosure.append(summary, body);

    root.append(head, buttons, disclosure);

    let opened = false;
    return {
        root,
        update(job) {
            dot.className = `bl-dot ${jobTone(job)}`;
            state.className = `bl-state ${jobTone(job)}`;
            state.textContent = jobWord(job);
            name.textContent = job.label;
            detail.textContent = job.detail;
            detail.title = job.detail;
            rerun.hidden = job.running;
            cancel.hidden = !job.running;
            dismiss.disabled = job.running;

            checks.textContent = '';
            for (const check of job.checks) {
                const item = document.createElement('li');
                const mark = icon(check.ok ? 'check' : 'x');
                mark.classList.add(check.ok ? 'ok' : 'bad');
                const label = document.createElement('span');
                label.className = 'bl-check-label';
                label.textContent = check.label;
                const why = document.createElement('span');
                why.className = 'bl-check-why';
                why.textContent = check.detail;
                item.append(mark, label, why);
                checks.append(item);
            }
            checks.hidden = job.checks.length === 0;
            command.textContent = job.command;
            note.textContent = job.note;
            // A job that stopped because something is missing is exactly the case
            // where the checklist is the answer, so open it once, on its own — in
            // the job's own window, which is where there is room to read it.
            if (!opened && !options.showOpen && (job.state === 'blocked' || job.state === 'failed')) {
                opened = true;
                disclosure.open = true;
            }
        },
    };
}
