import { captureFailureScreenshot } from './failure-shot.js';
import { DriverError, type DeviceDriver } from './types.js';
import { visibleTexts } from './verify.js';
import { selectorNameOf, type SelectorEntry, type SelectorEntryList } from './selector-overrides.js';

/**
 * The one error every Android routine dies of, written once.
 *
 * A control the routine cannot see means the selector table is wrong for this build of the app,
 * and repairing it needs three things the stack trace alone never carries: which selector it was,
 * what the phone was actually showing, and a picture of it. The last two lines of the message are
 * machine-readable on purpose — `src/agent/failure.ts` reads them back off a failed execution so
 * the dashboard can offer to send the calibration agent at exactly this selector.
 */

export function describeSelectors(selectors: SelectorEntryList): string {
    return selectors.map((selector: SelectorEntry) => selector.id ? `#${selector.id}` : `"${selector.text}"`).join(', ');
}

export function screenSummaryOf(texts: readonly string[]): string {
    return texts.length ? texts.slice(0, 20).join(', ') : '(no accessibility nodes)';
}

/** `[selector captionField]` — the table key, when the routine resolved its table through the override store. */
export const SELECTOR_MARKER = /\[selector ([A-Za-z0-9_]+)\]/;
/** `[screenshot /path/to.png]` — written only when the executor gave the run somewhere to put it. */
export const SCREENSHOT_MARKER = /\[screenshot ([^\]]+)\]/;

/**
 * Builds the failure. Async because it reads the tree and (when the executor asked for one) takes
 * a screenshot; neither can throw out of here, since this runs on the way out of a failure and a
 * second error would replace the useful one.
 */
export async function missingControlError(
    driver: DeviceDriver, network: string, label: string, selectors: SelectorEntryList,
): Promise<DriverError> {
    let texts: string[] = [];
    try {
        texts = visibleTexts(await driver.uiTree());
    } catch {
        texts = [];
    }
    const name = selectorNameOf(selectors);
    const shot = await captureFailureScreenshot(driver, `${network}-${label}`);
    return new DriverError(
        `${network} control not found: ${label} (tried ${describeSelectors(selectors)}). `
        + `Screen showed: ${screenSummaryOf(texts)}`
        + (name ? ` [selector ${name}]` : '')
        + (shot ? ` [screenshot ${shot}]` : ''),
    );
}
