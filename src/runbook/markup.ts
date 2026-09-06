/**
 * The two escapes every runbook surface needs, and the prefix they all hang off.
 *
 * They live apart from html.ts so the story panel and the step table can both use them without the
 * two modules importing each other.
 */

/**
 * HTML escaping is the wrong escape inside a `<script>` block: `&#39;` is not a
 * quote to the JS parser, and `</script>` in a string still closes the element.
 * A JSON literal with the three markup characters escaped is safe in both.
 */
export function scriptLiteral(value: unknown): string {
    return JSON.stringify(String(value ?? ''))
        .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
        .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function escapeHtml(value: unknown): string {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Every runbook surface hangs off the plugin's own route prefix. */
export const ROUTE_PREFIX = '/plugins/com.farm.runbook';
