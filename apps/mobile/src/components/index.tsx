/**
 * The whole component set: Card, Badge, Button, StatusDot, plus the three
 * layout scraps every screen needs. React Native primitives only.
 */
import type { ReactNode } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';
import { useTheme, type Palette } from '../theme';

/* -------------------------------------------------------------- StatusDot */

export function StatusDot({ color, size = 8, pulsing = false }: { color: string; size?: number; pulsing?: boolean }) {
    return (
        <View
            accessibilityElementsHidden
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulsing ? 0.9 : 1,
            }}
        />
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
    const tint = color ?? colors.textMuted;
    const background = tone === 'solid' ? tint : tone === 'soft' ? `${tint}22` : 'transparent';
    return (
        <View
            testID={testID}
            style={{
                paddingHorizontal: spacing.sm,
                paddingVertical: 2,
                borderRadius: radius.pill,
                backgroundColor: background,
                borderWidth: tone === 'outline' ? StyleSheet.hairlineWidth : 0,
                borderColor: tint,
                alignSelf: 'flex-start',
            }}
        >
            <Text
                style={{
                    color: tone === 'solid' ? colors.accentText : tint,
                    fontSize: 11,
                    fontWeight: '600',
                    letterSpacing: 0.2,
                }}
            >
                {label}
            </Text>
        </View>
    );
}

/* ------------------------------------------------------------------- Card */

export function Card({
    children,
    onPress,
    onLongPress,
    style,
    testID,
    accessibilityLabel,
}: {
    children: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    accessibilityLabel?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    const base: ViewStyle = {
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
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
            style={({ pressed }) => [base, pressed && { opacity: 0.7 }, style]}
        >
            {children}
        </Pressable>
    );
}

/* ----------------------------------------------------------------- Button */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
    label,
    onPress,
    variant = 'secondary',
    disabled = false,
    busy = false,
    style,
    testID,
}: {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant;
    disabled?: boolean;
    busy?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}) {
    const { colors, radius, spacing } = useTheme();
    const { background, border, text } = buttonTones(variant, colors);
    const inert = disabled || busy;
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityState={{ disabled: inert, busy }}
            disabled={inert}
            onPress={onPress}
            style={({ pressed }) => [
                {
                    paddingHorizontal: spacing.lg,
                    paddingVertical: 10,
                    borderRadius: radius.md,
                    backgroundColor: background,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: spacing.sm,
                    opacity: inert ? 0.45 : pressed ? 0.75 : 1,
                },
                style,
            ]}
        >
            {busy ? <ActivityIndicator size="small" color={text} /> : null}
            <Text style={{ color: text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
        </Pressable>
    );
}

function buttonTones(variant: ButtonVariant, colors: Palette) {
    switch (variant) {
        case 'primary':
            return { background: colors.accent, border: colors.accent, text: colors.accentText };
        case 'danger':
            return { background: `${colors.danger}1A`, border: colors.danger, text: colors.danger };
        case 'ghost':
            return { background: 'transparent', border: 'transparent', text: colors.textMuted };
        default:
            return { background: colors.surfaceRaised, border: colors.border, text: colors.text };
    }
}

/* -------------------------------------------------------- layout scraps */

export function Row({ children, gap, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
    const { spacing } = useTheme();
    return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: gap ?? spacing.sm }, style]}>{children}</View>;
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
        <Text testID={testID} numberOfLines={numberOfLines} style={[{ color: colors.textMuted, fontSize: 12 }, style]}>
            {children}
        </Text>
    );
}

export function SectionTitle({ children }: { children: ReactNode }) {
    const { colors, spacing } = useTheme();
    return (
        <Text
            style={{
                color: colors.textFaint,
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1,
                textTransform: 'uppercase',
                marginBottom: spacing.sm,
                marginTop: spacing.md,
            }}
        >
            {children}
        </Text>
    );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
    const { colors, spacing } = useTheme();
    return (
        <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.sm }}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
            {detail ? <Muted style={{ textAlign: 'center' }}>{detail}</Muted> : null}
        </View>
    );
}

/** The dimmed "we are showing you the past" banner from the plan's §5. */
export function StaleBanner({ message, testID }: { message: string; testID?: string }) {
    const { colors, spacing, radius } = useTheme();
    return (
        <View
            testID={testID}
            accessibilityRole="alert"
            style={{
                backgroundColor: `${colors.warning}1F`,
                borderColor: `${colors.warning}55`,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                marginHorizontal: spacing.lg,
                marginBottom: spacing.sm,
            }}
        >
            <Text style={{ color: colors.warning, fontSize: 12, fontWeight: '600' }}>{message}</Text>
        </View>
    );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
    const { colors, spacing, radius } = useTheme();
    return (
        <View
            accessibilityRole="alert"
            style={{
                backgroundColor: `${colors.danger}1A`,
                borderColor: `${colors.danger}55`,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: radius.md,
                padding: spacing.md,
                marginHorizontal: spacing.lg,
                marginBottom: spacing.sm,
                gap: spacing.sm,
            }}
        >
            <Text style={{ color: colors.danger, fontSize: 13 }}>{message}</Text>
            {onRetry ? <Button label="Try again" variant="danger" onPress={onRetry} /> : null}
        </View>
    );
}

export function Loading({ label }: { label?: string }) {
    const { colors, spacing } = useTheme();
    return (
        <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.sm }}>
            <ActivityIndicator color={colors.accent} />
            {label ? <Muted>{label}</Muted> : null}
        </View>
    );
}
