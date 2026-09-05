import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    eventGroup,
    eventText,
    formatRelative,
    kindLabel,
    type EventSeverity,
    type FarmEvent,
} from '@farm/client';
import { Badge, Button, Card, EmptyState, ErrorBanner, Loading, Muted, Row, StatusDot } from '../components';
import { useAlerts } from '../context/AlertsContext';
import { useFarm } from '../context/FarmContext';
import { severityColor, useTheme } from '../theme';

type GroupFilter = 'all' | 'execution' | 'device' | 'schedule';

export function AlertsScreen() {
    const { events, loading, error, streamStatus, refresh, loadMore, hasMore, acknowledgeAll } = useAlerts();
    const { snapshot, unacknowledgedCount, canAct, needsSetup } = useFarm();
    const { colors, spacing } = useTheme();
    const [severity, setSeverity] = useState<EventSeverity | 'all'>('all');
    const [group, setGroup] = useState<GroupFilter>('all');
    const [refreshing, setRefreshing] = useState(false);
    const [acking, setAcking] = useState(false);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, device.name);
        return map;
    }, [snapshot]);

    const visible = useMemo(
        () =>
            events.filter(
                (event) =>
                    (severity === 'all' || event.severity === severity) &&
                    (group === 'all' || eventGroup(event.kind) === group),
            ),
        [events, severity, group],
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await refresh();
        setRefreshing(false);
    }, [refresh]);

    const onAck = useCallback(async () => {
        setAcking(true);
        try {
            await acknowledgeAll();
        } finally {
            setAcking(false);
        }
    }, [acknowledgeAll]);

    if (needsSetup) return <EmptyState title="No farm configured" detail="Add a server URL and token in Settings." />;
    if (loading && events.length === 0) return <Loading label="Loading events…" />;

    const canAck = canAct && unacknowledgedCount > 0 && snapshot?.capabilities.eventAck !== false;

    return (
        <View style={{ flex: 1 }}>
            <Row style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
                <StatusDot color={streamStatus === 'open' ? colors.online : colors.offline} size={8} />
                <Muted testID="alerts-stream-status">
                    {streamStatus === 'open' ? 'live' : streamStatus === 'reconnecting' ? 'reconnecting…' : 'not streaming'}
                </Muted>
                <View style={{ flex: 1 }} />
                {canAck ? (
                    <Button label={`Acknowledge ${unacknowledgedCount}`} onPress={() => void onAck()} busy={acking} testID="ack-all" />
                ) : null}
            </Row>

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm, paddingVertical: spacing.sm }}
            >
                {(['all', 'error', 'warning', 'info'] as const).map((option) => (
                    <Chip
                        key={option}
                        label={option}
                        active={severity === option}
                        testID={`alerts-severity-${option}`}
                        onPress={() => setSeverity(option)}
                        tint={option === 'all' ? colors.accent : severityColor(option, colors)}
                    />
                ))}
                <View style={{ width: 1, backgroundColor: colors.border, marginHorizontal: spacing.xs }} />
                {(['all', 'execution', 'device', 'schedule'] as const).map((option) => (
                    <Chip
                        key={option}
                        label={option}
                        active={group === option}
                        testID={`alerts-group-${option}`}
                        onPress={() => setGroup(option)}
                        tint={colors.accent}
                    />
                ))}
            </ScrollView>

            {error && events.length === 0 ? <ErrorBanner message={error.message} onRetry={() => void refresh()} /> : null}

            <FlatList
                data={visible}
                keyExtractor={(event) => event.id}
                contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                onEndReached={() => void loadMore()}
                onEndReachedThreshold={0.4}
                ListEmptyComponent={<EmptyState title="Nothing to report" detail="No events match these filters." />}
                ListFooterComponent={hasMore ? <Muted style={{ textAlign: 'center', padding: spacing.md }}>loading older…</Muted> : null}
                renderItem={({ item }) => <EventRow event={item} deviceName={names.get(item.deviceUdid ?? '')} />}
            />
        </View>
    );
}

function Chip({
    label,
    active,
    onPress,
    tint,
    testID,
}: {
    label: string;
    active: boolean;
    onPress: () => void;
    tint: string;
    testID?: string;
}) {
    const { colors, spacing, radius } = useTheme();
    return (
        <Text
            accessibilityRole="button"
            testID={testID}
            onPress={onPress}
            style={{
                color: active ? colors.accentText : colors.textMuted,
                backgroundColor: active ? tint : colors.surface,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: radius.pill,
                paddingHorizontal: spacing.md,
                paddingVertical: 6,
                fontSize: 12,
                fontWeight: '600',
                overflow: 'hidden',
            }}
        >
            {label}
        </Text>
    );
}

function EventRow({ event, deviceName }: { event: FarmEvent; deviceName?: string }) {
    const { colors, spacing } = useTheme();
    const tint = severityColor(event.severity, colors);
    const { title, body } = eventText(event, deviceName);

    // A tap deep-links to whatever the event is about.
    const onPress = () => {
        if (event.executionId) router.push(`/execution/${encodeURIComponent(event.executionId)}` as never);
        else if (event.deviceUdid) router.push(`/device/${encodeURIComponent(event.deviceUdid)}` as never);
    };

    return (
        <Card testID={`event-${event.id}`} onPress={event.executionId || event.deviceUdid ? onPress : undefined}>
            <Row gap={spacing.sm} style={{ marginBottom: 4 }}>
                <StatusDot color={tint} />
                <Badge label={kindLabel(event.kind)} color={tint} />
                <View style={{ flex: 1 }} />
                <Muted>{formatRelative(event.createdAt)}</Muted>
            </Row>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>{title}</Text>
            {body ? (
                <Muted numberOfLines={3} style={{ marginTop: 2 }}>
                    {body}
                </Muted>
            ) : null}
        </Card>
    );
}
