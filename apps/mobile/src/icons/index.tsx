/**
 * `<Icon name="grid" />` — the desktop glyph set as `react-native-svg`.
 *
 * The glyphs in `glyphs.ts` are the desktop markup verbatim, so this parses
 * that markup once per icon rather than hand-transcribing 44 paths into JSX and
 * letting the two drift. The grammar is deliberately tiny: the set is stroke
 * SVG on a 16 grid using `rect`, `circle` and `path` and nothing else, and an
 * element it does not recognise is dropped rather than guessed at.
 */
import { useMemo } from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { GLYPHS, type IconName } from './glyphs';
import { useTheme } from '../theme';

export type { IconName };
export { GLYPHS };

interface Element {
    tag: 'rect' | 'circle' | 'path';
    attrs: Record<string, string>;
}

const ELEMENT = /<(rect|circle|path)\b([^>]*)\/>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

function parse(markup: string): Element[] {
    const elements: Element[] = [];
    for (const match of markup.matchAll(ELEMENT)) {
        const attrs: Record<string, string> = {};
        for (const attribute of (match[2] ?? '').matchAll(ATTRIBUTE)) attrs[attribute[1]!] = attribute[2]!;
        elements.push({ tag: match[1] as Element['tag'], attrs });
    }
    return elements;
}

/** Parsed once per glyph for the life of the process; the set never changes. */
const cache = new Map<string, Element[]>();

function elementsFor(name: IconName): Element[] {
    let elements = cache.get(name);
    if (!elements) {
        elements = parse(GLYPHS[name] ?? '');
        cache.set(name, elements);
    }
    return elements;
}

export interface IconProps {
    name: IconName;
    /** 16 on a dense row, 24 everywhere the design calls a phone icon 24. */
    size?: number;
    /** Defaults to the current text colour, like `currentColor` on the web. */
    color?: string;
    /** The design's stroke is 1.6; the tab bar's is 1.8, as in the mockup. */
    strokeWidth?: number;
}

export function Icon({ name, size = 24, color, strokeWidth = 1.6 }: IconProps) {
    const { colors } = useTheme();
    const tint = color ?? colors.text2;
    // `var(--bl-panel, #fff)` is the web token for a knocked-out fill; on the
    // phone that is the panel colour, so the rig glyph reads in both schemes.
    const panel = colors.panel;
    const elements = useMemo(() => elementsFor(name), [name]);

    return (
        <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
            {elements.map((element, index) => {
                const { attrs } = element;
                const fill = attrs.fill === undefined ? 'none' : attrs.fill.startsWith('var(') ? panel : attrs.fill === 'currentColor' ? tint : attrs.fill;
                const stroke = attrs.stroke === 'none' ? 'none' : tint;
                const width = attrs['stroke-width'] ? Number(attrs['stroke-width']) : strokeWidth;
                const key = `${element.tag}-${index}`;
                if (element.tag === 'rect') {
                    return (
                        <Rect
                            key={key}
                            x={attrs.x}
                            y={attrs.y}
                            width={attrs.width}
                            height={attrs.height}
                            rx={attrs.rx}
                            fill={fill}
                            stroke={stroke}
                            strokeWidth={width}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    );
                }
                if (element.tag === 'circle') {
                    return (
                        <Circle
                            key={key}
                            cx={attrs.cx}
                            cy={attrs.cy}
                            r={attrs.r}
                            fill={fill}
                            stroke={stroke}
                            strokeWidth={width}
                        />
                    );
                }
                return (
                    <Path
                        key={key}
                        d={attrs.d}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                );
            })}
        </Svg>
    );
}
