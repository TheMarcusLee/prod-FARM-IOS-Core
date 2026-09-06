import { FramePump } from './shell.js';

export {};

/**
 * The runbook pages are HTMX end to end; this is the small amount they cannot do in markup —
 * opening and closing the `<dialog>` elements that hold "New runbook" and "Run on device", and
 * closing the run dialog once its form has been submitted. Everything is delegated from the
 * document, so a fragment swap never leaves a dead listener behind.
 */

function dialogFor(id: string): HTMLDialogElement | null {
    const node = document.getElementById(id);
    return node instanceof HTMLDialogElement ? node : null;
}

document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const opener = target?.closest<HTMLElement>('[data-dialog]');
    if (opener?.dataset.dialog) {
        event.preventDefault();
        dialogFor(opener.dataset.dialog)?.showModal();
        return;
    }
    if (target?.closest('[data-dialog-close]')) {
        event.preventDefault();
        target.closest('dialog')?.close();
    }
});

// The fragment the run posts back replaces the dialog's own container, so close
// it first — otherwise the browser keeps a detached modal on screen.
document.addEventListener('submit', (event) => {
    const form = event.target as HTMLElement | null;
    if (form?.closest('[data-dialog-submit]')) form.closest('dialog')?.close();
});

/**
 * The import control is a file input inside a label, so it looks like a button. Choosing a file is
 * the whole gesture — there is no second "upload" press to forget.
 */
document.addEventListener('change', (event) => {
    const input = event.target as HTMLElement | null;
    if (!(input instanceof HTMLInputElement) || input.dataset.import === undefined) return;
    if (input.files?.length) input.form?.requestSubmit();
});

/**
 * The live screen in "Run it on this phone now" is the wall inspector's viewer: the same markup,
 * the same frame pump. Fragments swap around it, so any viewer without a pump gets one.
 */
const pumps = new WeakMap<HTMLElement, FramePump>();

function bindViewers(): void {
    for (const viewer of Array.from(document.querySelectorAll<HTMLElement>('[data-viewer][data-live="1"]'))) {
        if (pumps.has(viewer)) continue;
        const image = viewer.querySelector<HTMLImageElement>('[data-frame]');
        if (!image) continue;
        const pump = new FramePump(image, viewer.dataset.udid ?? '', viewer.dataset.platform ?? 'android');
        pumps.set(viewer, pump);
        pump.setRate(4);
        if (!document.hidden) pump.start();
    }
}

document.addEventListener('htmx:afterSwap', bindViewers);
bindViewers();
