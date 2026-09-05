/**
 * The component set from `docs/design/backline.md` §Components, and nothing
 * else. React Native primitives plus `react-native-svg` for the glyphs.
 *
 * Two rules run through all of it: every touch target is at least 44 pt (with
 * `hitSlop` where the ink is smaller than the target), and every one of them
 * carries an accessibility label, because a state dot and a colour are not a
 * label.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
    ActivityIndicator,
    Pressable,
    Text,
    View,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FarmError } from '@farm/client';
import { Icon, type IconName } from '../icons';
import { useTheme, type Palette } from '../theme';

/** The design's one shadow level: `0 1px 2px rgba(30,36,48,.10)`. */
export const raised = {
    shadowColor: '#1e2430',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
} as const;

/* -------------------------------------------------------------- StatusDot */

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
        />
    );
}

/* ------------------------------------------------------------- NumberChip */

/** The operator's handle for a slot: 6px radius, panel-2, 40% when offline. */
export function NumberChip({ number, dimmed = false }: { number: string; dimmed?: boolean }) {
    const { colors, radius } = useTheme();
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: radius.sm,
                backgroundColor: colors.panel2,
                opacity: dimmed ? 0.4 : 1,
            }}
        >
            <Text style={{ color: colors.text3, fontSize: 12.5, fontWeight: '700' }}>{number}</Text>
        </View>
    );
}

/* ------------------------------------------------------------------ Badge */

export function Badge({
    label,
    color,
    tone = 'soft',
    testID,
}: {
    label: string;
    color?: string;
    tone?: 'soft' | 'solid' | 'outline';
    testID?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    const tint = color ?? colors.text3;
    const background = tone === 'solid' ? tint : tone === 'soft' ? `${tint}1F` : 'transparent';
    return (
        <View
            testID={testID}
            style={{
                paddingHorizontal: spacing.sm,
                paddingVertical: 2,
                borderRadius: radius.pill,
                backgroundColor: background,
                borderWidth: tone === 'outline' ? 1 : 0,
                borderColor: tint,
                alignSelf: 'flex-start',
            }}
        >
            <Text style={{ color: tone === 'solid' ? colors.panel : tint, fontSize: 11, fontWeight: '600' }}>{label}</Text>
        </View>
    );
}

/* ------------------------------------------------------------------ Panel */

/** `bl-panel`: panel fill, 1px line, 12px radius. The card everything sits in. */
export function Panel({
    children,
    onPress,
    onLongPress,
    style,
    testID,
    accessibilityLabel,
    borderColor,
}: {
    children: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    accessibilityLabel?: string;
    borderColor?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    const base: ViewStyle = {
        backgroundColor: colors.panel,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: borderColor ?? colors.line,
        padding: spacing.md,
    };
    if (!onPress && !onLongPress) {
        return (
            <View testID={testID} style={[base, style]}>
                {children}
            </View>
        );
    }
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            onLongPress={onLongPress}
            style={({ pressed }) => [base, pressed && { opacity: 0.75 }, style]}
        >
            {children}
        </Pressable>
    );
}

/** The old name, kept so the detail screens read the same. */
export const Card = Panel;

/* ----------------------------------------------------------------- Button */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

/**
 * Height 44 on the phone, sentence case, 8px radius. `primary` is the ink fill
 * from the token table; `danger` is the bad fill, not a tinted outline — the
 * design has exactly three button skins and this is the destructive one.
 */
export function Button({
    label,
    onPress,
    variant = 'default',
    disabled = false,
    busy = false,
    icon,
    compact = false,
    style,
    testID,
    accessibilityLabel,
}: {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant;
    disabled?: boolean;
    busy?: boolean;
    icon?: IconName;
    /** The header's right action: 36 pt tall with hitSlop to 44. */
    compact?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    accessibilityLabel?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    const { background, border, text } = buttonTones(variant, colors);
    const inert = disabled || busy;
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityState={{ disabled: inert, busy }}
            disabled={inert}
            onPress={onPress}
            hitSlop={compact ? { top: 6, bottom: 6, left: 6, right: 6 } : undefined}
            style={({ pressed }) => [
                {
                    paddingHorizontal: compact ? spacing.md : spacing.lg,
                    height: compact ? 36 : 44,
                    borderRadius: compact ? radius.lg : radius.md,
                    backgroundColor: background,
                    borderWidth: 1,
                    borderColor: border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: spacing.xs2,
                    opacity: inert ? 0.45 : pressed ? 0.75 : 1,
                },
                style,
            ]}
        >
            {busy ? <ActivityIndicator size="small" color={text} /> : icon ? <Icon name={icon} size={16} color={text} /> : null}
            <Text style={{ color: text, fontWeight: '600', fontSize: 12.5 }}>{label}</Text>
        </Pressable>
    );
}

function buttonTones(variant: ButtonVariant, colors: Palette) {
    switch (variant) {
        case 'primary':
            return { background: colors.ink, border: colors.ink, text: colors.onInk };
        case 'danger':
            return { background: colors.bad, border: colors.bad, text: '#ffffff' };
        case 'ghost':
            return { background: 'transparent', border: 'transparent', text: colors.text3 };
        default:
            return { background: colors.panel, border: colors.line, text: colors.text2 };
    }
}

/** A square icon-only control: 44 pt, panel fill, line border. */
export function IconButton({
    icon,
    onPress,
    accessibilityLabel,
    testID,
    size = 40,
    tint,
    disabled = false,
}: {
    icon: IconName;
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    size?: number;
    tint?: string;
    disabled?: boolean;
}) {
    const { colors, radius } = useTheme();
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            onPress={onPress}
            style={({ pressed }) => ({
                width: size,
                height: size,
                borderRadius: radius.card,
                backgroundColor: colors.panel,
                borderWidth: 1,
                borderColor: colors.line,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
            })}
        >
            <Icon name={icon} size={18} color={tint ?? colors.text2} />
        </Pressable>
    );
}

/* ------------------------------------------------------------------- Chip */

/** Pill, 1px line; selected is the ink fill with white text. */
export function Chip({
    label,
    active,
    onPress,
    tint,
    testID,
    accessibilityLabel,
}: {
    label: string;
    active: boolean;
    onPress: () => void;
    tint?: string;
    testID?: string;
    accessibilityLabel?: string;
}) {
    const { colors, spacing, radius } = useTheme();
    const fill = tint ?? colors.ink;
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={accessibilityLabel ?? `Filter: ${label}`}
            // The pill is 32 pt of ink; the slop takes the target past 44.
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            onPress={onPress}
            style={({ pressed }) => ({
                backgroundColor: active ? fill : colors.panel,
                borderColor: active ? fill : colors.line,
                borderWidth: 1,
                borderRadius: radius.pill,
                paddingHorizontal: spacing.md,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.75 : 1,
            })}
        >
            <Text style={{ color: active ? colors.onInk : colors.text2, fontSize: 12.5, fontWeight: '500' }}>{label}</Text>
        </Pressable>
    );
}

/* ------------------------------------------------------ segmented control */

/** Track panel-2, thumb panel with the one shadow. */
export function Segmented<T extends string>({
    options,
    value,
    onChange,
    testIDPrefix,
}: {
    options: { key: T; label: string }[];
    value: T;
    onChange: (key: T) => void;
    testIDPrefix: string;
}) {
    const { colors, radius, spacing } = useTheme();
    return (
        <View
            style={{
                flexDirection: 'row',
                backgroundColor: colors.panel2,
                borderRadius: radius.md,
                padding: 3,
                gap: 3,
            }}
        >
            {options.map((option) => {
                const active = option.key === value;
                return (
                    <Pressable
                        key={option.key}
                        testID={`${testIDPrefix}-${option.key}`}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={option.label}
                        onPress={() => onChange(option.key)}
                        style={[
                            {
                                flex: 1,
                                height: 38,
                                borderRadius: radius.sm,
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingHorizontal: spacing.sm,
                                backgroundColor: active ? colors.panel : 'transparent',
                            },
                            active ? raised : null,
                        ]}
                    >
                        <Text style={{ color: active ? colors.text : colors.text3, fontSize: 12.5, fontWeight: '600' }}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

/* -------------------------------------------------------- layout scraps */

export function Row({ children, gap, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
    const { spacing } = useTheme();
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: gap ?? spacing.sm }, style]}>{children}</View>
    );
}

export function Muted({
    children,
    style,
    numberOfLines,
    testID,
}: {
    children: ReactNode;
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    testID?: string;
}) {
    const { colors } = useTheme();
    return (
        <Text testID={testID} numberOfLines={numberOfLines} style={[{ color: colors.text3, fontSize: 12.5 }, style]}>
            {children}
        </Text>
    );
}

/** Sentence case, text-3, 12.5 — a label, not a shouted uppercase rule. */
export function SectionTitle({ children }: { children: ReactNode }) {
    const { colors, spacing } = useTheme();
    return (
        <Text
            accessibilityRole="header"
            style={{
                color: colors.text3,
                fontSize: 12.5,
                fontWeight: '600',
                marginBottom: spacing.sm,
                marginTop: spacing.md2,
            }}
        >
            {children}
        </Text>
    );
}

/**
 * The screen header: 24px title, a 12.5px subtitle, and the one compact action
 * the mockup gives the screen. No floating gear — Settings lives under Rig.
 *
 * It owns the top safe area because the tabs draw no navigation header: the
 * mockup's 58px of padding above "Wall" is the notch plus 10.
 */
export function ScreenHeader({
    title,
    subtitle,
    right,
    testID,
}: {
    title: string;
    subtitle?: ReactNode;
    right?: ReactNode;
    testID?: string;
}) {
    const { colors, spacing } = useTheme();
    const insets = useSafeAreaInsets();
    return (
        <View
            testID={testID}
            style={{
                paddingHorizontal: spacing.lg2,
                paddingTop: insets.top + spacing.sm2,
                paddingBottom: spacing.sm2,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.md,
            }}
        >
            <View style={{ flex: 1 }}>
                <Text
                    accessibilityRole="header"
                    style={{ color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.5 }}
                >
                    {title}
                </Text>
                {subtitle ? <View style={{ marginTop: 1 }}>{subtitle}</View> : null}
            </View>
            {right}
        </View>
    );
}

/** Inspector row: label text-3 left, value text right, 12.5px, 10px gap. */
export function InspectorRow({ label, value, tint }: { label: string; value: ReactNode; tint?: string }) {
    const { colors, spacing } = useTheme();
    return (
        <View
            accessibilityLabel={`${label}: ${typeof value === 'string' ? value : ''}`}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm2, paddingVertical: 3 }}
        >
            <Text style={{ color: colors.text3, fontSize: 12.5 }}>{label}</Text>
            <View style={{ flex: 1 }} />
            {typeof value === 'string' ? (
                <Text style={{ color: tint ?? colors.text, fontSize: 12.5, flexShrink: 1, textAlign: 'right' }}>
                    {value}
                </Text>
            ) : (
                value
            )}
        </View>
    );
}

/** The "needs you" callout: bad-soft fill, badLine border, title 600, one action. */
export function Callout({
    title,
    detail,
    actionLabel,
    onAction,
    busy = false,
    testID,
}: {
    title: string;
    detail?: string;
    actionLabel?: string;
    onAction?: () => void;
    busy?: boolean;
    testID?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    return (
        <View
            testID={testID}
            accessibilityRole="alert"
            style={{
                backgroundColor: colors.badSoft,
                borderColor: colors.badLine,
                borderWidth: 1,
                borderRadius: radius.lg,
                padding: spacing.md,
                gap: spacing.xs2,
            }}
        >
            <Text style={{ color: colors.bad, fontSize: 13.5, fontWeight: '600' }}>{title}</Text>
            {detail ? <Text style={{ color: colors.text2, fontSize: 12.5 }}>{detail}</Text> : null}
            {actionLabel && onAction ? (
                <Button label={actionLabel} variant="danger" onPress={onAction} busy={busy} style={{ marginTop: spacing.xs }} />
            ) : null}
        </View>
    );
}

/** Log block: panel-2, 10px radius, timestamp (text-4) + text, current line 600. */
export function LogBlock({
    lines,
    testID,
}: {
    lines: { at: string; text: string; current?: boolean; error?: boolean }[];
    testID?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    return (
        <View
            testID={testID}
            style={{
                backgroundColor: colors.panel2,
                borderRadius: radius.lg,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm2,
                gap: spacing.xs,
            }}
        >
            {lines.length === 0 ? (
                <Muted>No log lines yet.</Muted>
            ) : (
                lines.map((line, index) => (
                    <View key={`${index}-${line.at}`} style={{ flexDirection: 'row', gap: spacing.sm2 }}>
                        <Text style={{ color: colors.text4, fontSize: 12.5 }}>{line.at}</Text>
                        <Text
                            style={{
                                color: line.error ? colors.bad : line.current ? colors.text : colors.text2,
                                fontSize: 12.5,
                                fontWeight: line.current ? '600' : '400',
                                flex: 1,
                            }}
                        >
                            {line.text}
                        </Text>
                    </View>
                ))
            )}
        </View>
    );
}

/** One sentence in text-3 plus the one action that fixes it. Never a spinner. */
export function EmptyState({
    title,
    detail,
    actionLabel,
    onAction,
    testID,
}: {
    title: string;
    detail?: string;
    actionLabel?: string;
    onAction?: () => void;
    testID?: string;
}) {
    const { colors, spacing } = useTheme();
    return (
        <View testID={testID} style={{ padding: spacing.xxl, alignItems: 'center', gap: spacing.sm2 }}>
            <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
            {detail ? <Muted style={{ textAlign: 'center' }}>{detail}</Muted> : null}
            {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
        </View>
    );
}

/** The dimmed "we are showing you the past" banner. */
export function StaleBanner({ message, testID }: { message: string; testID?: string }) {
    const { colors, spacing, radius } = useTheme();
    return (
        <View
            testID={testID}
            accessibilityRole="alert"
            style={{
                backgroundColor: colors.panel2,
                borderColor: colors.line,
                borderWidth: 1,
                borderRadius: radius.lg,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                marginHorizontal: spacing.lg2,
                marginBottom: spacing.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
            }}
        >
            <StatusDot color={colors.warn} />
            <Text style={{ color: colors.text2, fontSize: 12.5, flex: 1 }}>{message}</Text>
        </View>
    );
}

/**
 * The one place a `FarmError` becomes a screen state, so "can't reach the Mac",
 * "your token is dead" and "you are going too fast" never render as the same
 * red line of prose on five different screens.
 *
 * - `401`/`403` is not retryable by tapping Try again — it needs a new token,
 *   so the affordance goes to Rig, where Settings now lives.
 * - `429` is a countdown, not a failure.
 * - Everything else keeps Try again.
 */
export function ErrorState({ error, onRetry, testID }: { error: FarmError; onRetry?: () => void; testID?: string }) {
    const { colors, spacing, radius } = useTheme();
    const seconds = useCountdown(error.kind === 'rate-limited' ? error.retryAfterMs : undefined);

    const headline =
        error.kind === 'network' || error.kind === 'timeout'
            ? "Can't reach the Mac"
            : error.authFailure
              ? 'That token is not working'
              : error.kind === 'rate-limited'
                ? 'Slow down'
                : error.kind === 'unavailable'
                  ? 'That part of the farm is down'
                  : 'The farm said no';

    const detail =
        error.kind === 'network' || error.kind === 'timeout'
            ? 'Check that this phone and the Mac are both on the tailnet.'
            : error.authFailure
              ? 'Paste a fresh token in Rig — the farm rejected this one.'
              : error.kind === 'rate-limited' && seconds > 0
                ? `The farm is rate-limiting this app. Try again in ${seconds}s.`
                : error.message;

    return (
        <View
            testID={testID}
            accessibilityRole="alert"
            accessibilityLabel={`${headline}. ${detail}`}
            style={{
                backgroundColor: colors.badSoft,
                borderColor: colors.badLine,
                borderWidth: 1,
                borderRadius: radius.lg,
                padding: spacing.md,
                marginHorizontal: spacing.lg2,
                marginBottom: spacing.sm,
                gap: spacing.sm,
            }}
        >
            <Text style={{ color: colors.bad, fontSize: 13.5, fontWeight: '600' }}>{headline}</Text>
            <Text style={{ color: colors.text2, fontSize: 12.5 }}>{detail}</Text>
            {error.authFailure ? (
                <Button label="Open Rig" variant="danger" testID="error-open-settings" onPress={() => router.push('/rig' as never)} />
            ) : error.kind === 'rate-limited' && seconds > 0 ? null : onRetry ? (
                <Button label="Try again" variant="danger" onPress={onRetry} testID="error-retry" />
            ) : null}
        </View>
    );
}

/** Whole seconds left on a `Retry-After`, ticking down to 0. */
function useCountdown(ms: number | undefined): number {
    const [remaining, setRemaining] = useState(() => Math.ceil((ms ?? 0) / 1000));
    useEffect(() => {
        setRemaining(Math.ceil((ms ?? 0) / 1000));
        if (!ms) return;
        const timer = setInterval(() => setRemaining((value) => (value <= 1 ? 0 : value - 1)), 1_000);
        return () => clearInterval(timer);
    }, [ms]);
    return remaining;
}

export function Loading({ label }: { label?: string }) {
    const { colors, spacing } = useTheme();
    return (
        <View style={{ padding: spacing.xxl, alignItems: 'center', gap: spacing.sm }}>
            <ActivityIndicator color={colors.accent} />
            {label ? <Muted>{label}</Muted> : null}
        </View>
    );
}
