import {
    center, findById, findByText, tappableBounds, visibleTexts, waitForNode,
    type Recognize, type WaitOptions,
} from '../../drivers/verify.js';
import { DriverError, type DeviceDriver, type Point, type UiNode } from '../../drivers/types.js';
import { driverMotion, type MotionSource } from '../../motion/source.js';

/**
 * The vocabulary the Android Threads routines use to talk about on-screen controls.
 *
 * Threads ships out of the Instagram codebase and relabels things between builds and regions, so
 * every control is a *list* of selectors tried in order: a `resource-id` fragment when one exists,
 * visible text / content-desc otherwise. The routine files keep those lists in one exported table
 * at the top of the file so they can be corrected against a real phone without touching the flow.
 *
 * This mirrors `src/tiktok/android/ui.ts` deliberately — same shape, Threads' own wording in the
 * errors — rather than sharing it, so a change made for one app cannot quietly move the other.
 */
export interface Selector {
    /** Visible text or content-desc; case-insensitive substring unless `exact`. */
    text?: string;
    exact?: boolean;
    /** Android `resource-id`, with or without the `<package>:id/` prefix. */
    id?: string;
}

export type SelectorList = readonly Selector[];

export interface TapOptions {
    /** OCR fallback for the surfaces Threads draws without accessibility nodes. */
    recognize?: Recognize;
    /**
     * The run's own hand, so every tap in a run comes out of one seeded stream. Absent falls back
     * to a source seeded from the udid — a tap still jitters, it is simply not tied to this run.
     */
    motion?: MotionSource;
}

// One fallback hand per device, kept between taps: a fresh source per tap would either repeat
// itself (with MOTION_SEED set) or ignore the seed entirely.
const fallbackHands = new Map<string, MotionSource>();

function handFor(driver: DeviceDriver, motion?: MotionSource): MotionSource {
    let hand = motion ?? fallbackHands.get(driver.udid);
    if (!hand) {
        hand = driverMotion(driver.udid);
        fallbackHands.set(driver.udid, hand);
    }
    return hand;
}

/**
 * One tap, as a finger rather than an event: a few pixels off the centre of the control, held for
 * 40–120 ms. `DeviceDriver.tap` has no press duration, so the press goes down the gesture channel
 * as a two-sample path with the finger not moving — which every driver already plays.
 */
export async function humanTapAt(driver: DeviceDriver, point: Point, motion?: MotionSource): Promise<Point> {
    const { point: landed, pressMs } = handFor(driver, motion).tap(point);
    await driver.gesture([{ ...landed, t: 0 }, { ...landed, t: pressMs }]);
    return landed;
}

export function textMatches(candidate: string, selector: Selector): boolean {
    if (!selector.text) return false;
    const a = candidate.trim().toLowerCase();
    const b = selector.text.trim().toLowerCase();
    return selector.exact ? a === b : a.includes(b);
}

/** First node in the tree matching any selector in the list, in list order. */
export function findAny(root: UiNode, selectors: SelectorList): UiNode | undefined {
    for (const selector of selectors) {
        const found = selector.id
            ? findById(root, selector.id)
            : findByText(root, { text: selector.text ?? '', exact: selector.exact });
        if (found) return found;
    }
    return undefined;
}

/**
 * Where to tap for the first matching selector. Tree first; OCR second, for the screens Threads
 * draws without accessibility nodes.
 */
export async function locate(driver: DeviceDriver, selectors: SelectorList, recognize?: Recognize): Promise<Point | undefined> {
    const root = await driver.uiTree();
    const node = findAny(root, selectors);
    if (node) return center(tappableBounds(root, node));
    if (!recognize) return undefined;
    const words = await recognize(await driver.screenshot());
    const { scale } = await driver.screen();
    for (const selector of selectors) {
        const word = words.find((candidate) => textMatches(candidate.text, selector));
        if (!word) continue;
        const point = center(word.bounds);
        // OCR reads the PNG's pixel grid; Android touch coordinates are pixels too (scale 1),
        // but divide anyway so the helper stays correct if a scaled driver ever uses it.
        return { x: point.x / scale, y: point.y / scale };
    }
    return undefined;
}

/** Taps the first selector that resolves; a miss names the control and what the phone was showing. */
export async function tapFirst(driver: DeviceDriver, label: string, selectors: SelectorList, options: TapOptions = {}): Promise<void> {
    const point = await locate(driver, selectors, options.recognize);
    if (!point) {
        throw new DriverError(
            `Threads control not found: ${label} (tried ${describe(selectors)}). `
            + `Screen showed: ${screenSummary(await driver.uiTree())}`,
        );
    }
    const landed = await humanTapAt(driver, point, options.motion);
    console.log(`Tapped ${label} at (${Math.round(landed.x)}, ${Math.round(landed.y)})`);
}

/** Like `tapFirst`, but a missing control is not fatal — used for optional sheets and toggles. */
export async function tapIfPresent(driver: DeviceDriver, label: string, selectors: SelectorList, options: TapOptions = {}): Promise<boolean> {
    const point = await locate(driver, selectors, options.recognize);
    if (!point) {
        console.log(`Skipped ${label}: not on screen`);
        return false;
    }
    const landed = await humanTapAt(driver, point, options.motion);
    console.log(`Tapped ${label} at (${Math.round(landed.x)}, ${Math.round(landed.y)})`);
    return true;
}

/** Polls the tree until any selector in the list appears; the error names the control and the screen. */
export async function waitForAny(driver: DeviceDriver, label: string, selectors: SelectorList, options: WaitOptions = {}): Promise<UiNode> {
    try {
        return await waitForNode(driver, (root) => findAny(root, selectors), options);
    } catch (error) {
        throw new DriverError(`Timed out waiting for ${label} (tried ${describe(selectors)}). ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** True when any selector is on screen right now, without waiting. */
export async function isPresent(driver: DeviceDriver, selectors: SelectorList): Promise<boolean> {
    return Boolean(findAny(await driver.uiTree(), selectors));
}

export function describe(selectors: SelectorList): string {
    return selectors.map((selector) => selector.id ? `#${selector.id}` : `"${selector.text}"`).join(', ');
}

export function screenSummary(root: UiNode): string {
    const texts = visibleTexts(root).slice(0, 20);
    return texts.length ? texts.join(', ') : '(no accessibility nodes)';
}

/**
 * The OCR fallback, loaded lazily so importing a routine does not pull in the native OCR binding
 * (the tests drive the routines with a fake driver and never need it).
 */
export const recognizeOnDevice: Recognize = async (png) => {
    const { recognizeWords } = await import('../../tiktok/ocr.js');
    return (await recognizeWords(png)).map((word) => ({
        text: word.text,
        bounds: { left: word.x, top: word.y, right: word.x + word.width, bottom: word.y + word.height },
    }));
};
