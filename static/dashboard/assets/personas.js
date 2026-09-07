/**
 * The Accounts page's persona picker, client half.
 *
 * The picker is server-rendered and every option is a submit button carrying the whole selection it
 * would produce, so choosing, removing and blending presets all work with this file absent. The one
 * thing a round trip would be silly for is narrowing a hundred presets as somebody types, so that
 * is all this does: match the typed words against each option's `data-preset-terms` (its label, its
 * description and its interests), hide the ones that miss, and hide a category whose options have
 * all gone.
 *
 * Panels arrive and re-arrive as htmx swaps, so nothing is bound to an element: one delegated
 * `input` listener on the document covers every panel on the page, now and after every swap.
 */
const SEARCH = '[data-preset-search]';
function filter(search) {
    const form = search.closest('form');
    if (!form)
        return;
    // Word starts, not any substring: typing "ai" should offer AI tools, not everything with
    // "chain" or "training" in its description.
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
        .map((word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    let shown = 0;
    for (const group of form.querySelectorAll('[data-preset-group]')) {
        let visible = 0;
        for (const option of group.querySelectorAll('[data-preset-terms]')) {
            const terms = option.dataset.presetTerms ?? '';
            const hit = words.every((word) => word.test(terms));
            option.hidden = !hit;
            if (hit)
                visible += 1;
        }
        group.hidden = visible === 0;
        shown += visible;
    }
    const empty = form.querySelector('[data-preset-empty]');
    if (empty)
        empty.hidden = shown > 0;
}
document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches(SEARCH))
        filter(target);
});
// Enter in the search box would otherwise submit the form, which would apply whichever preset
// button the browser found first. The search narrows the list; it never picks anything.
document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.key === 'Enter' && target instanceof HTMLInputElement && target.matches(SEARCH)) {
        event.preventDefault();
    }
});
export {};
