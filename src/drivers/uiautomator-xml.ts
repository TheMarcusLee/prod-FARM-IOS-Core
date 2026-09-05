import type { Rect, UiNode } from './types.js';

/**
 * Parses `adb shell uiautomator dump` output into a UiNode tree without an XML dependency.
 * The dump is flat, well-formed XML with one <node .../> or <node ...>...</node> per element.
 */
export function parseUiautomatorXml(xml: string): UiNode {
    const root: UiNode = emptyNode('hierarchy');
    const stack: UiNode[] = [root];
    const tagPattern = /<node\b([^>]*?)(\/?)>|<\/node>/g;
    for (const match of xml.matchAll(tagPattern)) {
        if (match[0] === '</node>') {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const node = nodeFromAttributes(parseAttributes(match[1] ?? ''));
        stack[stack.length - 1]!.children.push(node);
        if (match[2] !== '/') stack.push(node);
    }
    return root.children.length === 1 ? root.children[0]! : root;
}

function emptyNode(type: string): UiNode {
    return {
        id: '', type, text: '', description: '',
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        clickable: false, enabled: true, children: [],
    };
}

function parseAttributes(source: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
        attributes[match[1]!] = decodeEntities(match[2]!);
    }
    return attributes;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** `[left,top][right,bottom]` */
export function parseBounds(value: string | undefined): Rect {
    const match = value?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!match) return { left: 0, top: 0, right: 0, bottom: 0 };
    const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [number, number, number, number];
    return { left, top, right, bottom };
}

function nodeFromAttributes(attributes: Record<string, string>): UiNode {
    return {
        id: attributes['resource-id'] ?? '',
        type: attributes['class'] ?? '',
        text: attributes['text'] ?? '',
        description: attributes['content-desc'] ?? '',
        bounds: parseBounds(attributes['bounds']),
        clickable: attributes['clickable'] === 'true',
        enabled: attributes['enabled'] !== 'false',
        children: [],
    };
}
