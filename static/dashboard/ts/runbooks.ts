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
