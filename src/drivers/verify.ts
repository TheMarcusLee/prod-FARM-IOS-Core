import { pause } from './common.js';
import { DriverError, type DeviceDriver, type Point, type Rect, type UiNode } from './types.js';

/**
 * Observe → act → verify, borrowed from sim-use. Prefer these over raw coordinates: a tree
 * lookup survives a TikTok layout shuffle, a recorded (x, y) does not. OCR is the fallback for
 * screens whose tree is empty (video players, some custom-drawn TikTok surfaces).
 */

export interface OcrWord {
    text: string;
    bounds: Rect;
}

/** Injected so this module never depends on node-native-ocr; src/tiktok/ocr.ts already provides one. */
export type Recognize = (png: Buffer) => Promise<OcrWord[]>;

export interface TextMatch {
    /** Case-insensitive; substring unless `exact`. */
    text: string;
    exact?: boolean;
}

export function center({ left, top, right, bottom }: Rect): Point {
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

export function* walk(node: UiNode): Generator<UiNode> {
    yield node;
    for (const child of node.children) yield* walk(child);
}

function matchesText(candidate: string, { text, exact }: TextMatch): boolean {
    const a = candidate.trim().toLowerCase();
    const b = text.trim().toLowerCase();
    return exact ? a === b : a.includes(b);
}

export function findByText(root: UiNode, match: TextMatch): UiNode | undefined {
    for (const node of walk(root)) {
        if (matchesText(node.text, match) || matchesText(node.description, match)) return node;
    }
    return undefined;
}

export function findById(root: UiNode, id: string): UiNode | undefined {
    for (const node of walk(root)) {
        if (node.id === id || node.id.endsWith(`:id/${id}`)) return node;
    }
    return undefined;
}

/** Nearest clickable ancestor-or-self is what should receive the tap, not the label inside it. */
export function tappableBounds(root: UiNode, target: UiNode): Rect {
    let best: UiNode = target;
    const chain: UiNode[] = [];
    const visit = (node: UiNode): boolean => {
        chain.push(node);
        if (node === target) return true;
        for (const child of node.children) if (visit(child)) return true;
        chain.pop();
        return false;
    };
    visit(root);
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        if (chain[index]!.clickable) { best = chain[index]!; break; }
    }
    return best.bounds;
}

export interface WaitOptions {
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
}

/** Polls the tree until `predicate` returns a node; throws with the last seen texts on timeout. */
export async function waitForNode(
    driver: DeviceDriver,
    predicate: (root: UiNode) => UiNode | undefined,
    { timeoutMs = 15_000, intervalMs = 750, signal }: WaitOptions = {},
): Promise<UiNode> {
    const deadline = Date.now() + timeoutMs;
    let lastRoot: UiNode | undefined;
    while (Date.now() < deadline) {
        lastRoot = await driver.uiTree();
        const found = predicate(lastRoot);
        if (found) return found;
        await pause(intervalMs, signal);
    }
    const seen = lastRoot ? visibleTexts(lastRoot).slice(0, 20).join(', ') : '(no tree)';
    throw new DriverError(`Timed out waiting for element. Screen showed: ${seen}`);
}

export function waitForText(driver: DeviceDriver, match: TextMatch, options?: WaitOptions): Promise<UiNode> {
    return waitForNode(driver, (root) => findByText(root, match), options);
}

/** Tree first, OCR second. Returns where to tap or undefined when neither can see the text. */
export async function locateText(driver: DeviceDriver, match: TextMatch, recognize?: Recognize): Promise<Point | undefined> {
    const root = await driver.uiTree();
    const node = findByText(root, match);
    if (node) return center(tappableBounds(root, node));
    if (!recognize) return undefined;
    const words = await recognize(await driver.screenshot());
    const word = words.find((candidate) => matchesText(candidate.text, match));
    if (!word) return undefined;
    const { scale } = await driver.screen();
    // OCR works on the PNG's pixel grid; iOS touch coordinates are in points.
    const point = center(word.bounds);
    return { x: point.x / scale, y: point.y / scale };
}

export async function tapText(driver: DeviceDriver, match: TextMatch, recognize?: Recognize): Promise<void> {
    const point = await locateText(driver, match, recognize);
    if (!point) throw new DriverError(`Could not find "${match.text}" on screen`);
    await driver.tap(point);
}

export function visibleTexts(root: UiNode): string[] {
    const texts: string[] = [];
    for (const node of walk(root)) {
        const text = node.text || node.description;
        if (text) texts.push(text);
    }
    return texts;
}
