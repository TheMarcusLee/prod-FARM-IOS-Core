/**
 * Alerts: what the farm said, newest first, with the one control that clears
 * the badge. A row is a sentence about what happened, not an event kind and a
 * hex code — `eventText` composes it from the farm's structured `detail`.
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    eventGroup,
    eventText,
    formatRelative,
    kindLabel,
    type EventSeverity,
    type FarmEvent,
} from '@farm/client';
import {
    Badge,
    Button,
    Chip,
    EmptyState,
    ErrorState,
    Loading,
    Muted,
    Panel,
    Row,
    ScreenHeader,
    StatusDot,
} from '../components';
import { useAlerts } from '../context/AlertsContext';
import { useFarm } from '../context/FarmContext';
import { severityColor, useTheme } from '../theme';

type GroupFilter = 'all' | 'execution' | 'device' | 'schedule';

const SEVERITIES: { key: EventSeverity | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'error', label: 'Error' },
    { key: 'warning', label: 'Warning' },
    { key: 'info', label: 'Info' },
];

const GROUPS: { key: GroupFilter; label: string }[] = [
    { key: 'all', label: 'Everything' },
    { key: 'execution', label: 'Runs' },
    { key: 'device', label: 'Phones' },
    { key: 'schedule', label: 'Schedules' },
];

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
        // The full name, slot suffix and all: these rows carry no number chip,
        // so stripping it would throw away the only slot the operator can see.
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

    const renderItem = useCallback(
        ({ item }: { item: FarmEvent }) => (
            <View style={{ paddingHorizontal: spacing.lg2 }}>
                <EventRow event={item} deviceName={names.get(item.deviceUdid ?? '')} />
            </View>
        ),
        [names, spacing.lg2],
    );

    if (needsSetup) {
        return (
            <View style={{ flex: 1 }}>
                <ScreenHeader title="Alerts" />
                <EmptyState
                    title="No farm configured"
                    detail="Add a server URL and token under Rig."
                    actionLabel="Open Rig"
                    onAction={() => router.push('/rig' as never)}
                />
            </View>
        );
    }
    if (loading && events.length === 0) return <Loading label="Loading events…" />;

    const canAck = canAct && unacknowledgedCount > 0 && snapshot?.capabilities.eventAck !== false;

    return (
        <View style={{ flex: 1 }}>
            <ScreenHeader
                title="Alerts"
                subtitle={
                    <Row gap={spacing.xs2}>
                        <StatusDot color={streamStatus === 'open' ? colors.ok : colors.text4} size={7} />
                        <Muted testID="alerts-stream-status">
                            {streamStatus === 'open'
                                ? 'live'
                                : streamStatus === 'reconnecting'
                                  ? 'reconnecting…'
                                  : 'not streaming'}
                        </Muted>
                        {unacknowledgedCount > 0 ? <Muted>· {unacknowledgedCount} unread</Muted> : null}
                    </Row>
                }
                right={
                    canAck ? (
                        <Button
                            label="Acknowledge all"
                            compact
                            onPress={() => void onAck()}
                            busy={acking}
                            testID="ack-all"
                        />
                    ) : null
                }
            />

            <Row
                gap={spacing.xs2}
                style={{ paddingHorizontal: spacing.lg2, paddingBottom: spacing.sm, flexWrap: 'wrap' }}
            >
                {SEVERITIES.map((option) => (
                    <Chip
                        key={option.key}
                        label={option.label}
                        active={severity === option.key}
                        testID={`alerts-severity-${option.key}`}
                        onPress={() => setSeverity(option.key)}
                        accessibilityLabel={`Severity: ${option.label}`}
                    />
                ))}
            </Row>
            <Row
                gap={spacing.xs2}
                style={{ paddingHorizontal: spacing.lg2, paddingBottom: spacing.md, flexWrap: 'wrap' }}
            >
                {GROUPS.map((option) => (
                    <Chip
                        key={option.key}
                        label={option.label}
                        active={group === option.key}
                        testID={`alerts-group-${option.key}`}
                        onPress={() => setGroup(option.key)}
                        accessibilityLabel={`Group: ${option.label}`}
                    />
                ))}
            </Row>

            {error && events.length === 0 ? (
                <ErrorState error={error} onRetry={() => void refresh()} testID="alerts-error" />
            ) : null}

            <FlatList
                testID="alerts-list"
                data={visible}
                keyExtractor={eventKey}
                renderItem={renderItem}
                contentContainerStyle={{ paddingBottom: spacing.xxl, gap: spacing.sm }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                onEndReached={() => void loadMore()}
                onEndReachedThreshold={0.4}
                ListEmptyComponent={<EmptyState title="Nothing to report" detail="No events match these filters." />}
                ListFooterComponent={
                    hasMore ? <Muted style={{ textAlign: 'center', padding: spacing.md }}>loading older…</Muted> : null
                }
            />
        </View>
    );
}

function eventKey(event: FarmEvent): string {
    return String(event.id);
}

const EventRow = memo(function EventRow({ event, deviceName }: { event: FarmEvent; deviceName?: string }) {
    const { colors, spacing } = useTheme();
    const tint = severityColor(event.severity, colors);
    const { title, body } = eventText(event, deviceName);
    const linked = Boolean(event.executionId || event.deviceUdid);

    // A tap deep-links to whatever the event is about.
    const onPress = () => {
        if (event.executionId) router.push(`/execution/${encodeURIComponent(event.executionId)}` as never);
        else if (event.deviceUdid) router.push(`/device/${encodeURIComponent(event.deviceUdid)}` as never);
    };

    return (
        <Panel
            testID={`event-${event.id}`}
            accessibilityLabel={`${event.severity}. ${title}. ${body ?? ''}`}
            borderColor={event.severity === 'error' ? colors.badLine : undefined}
            onPress={linked ? onPress : undefined}
        >
            <Row gap={spacing.sm}>
                <StatusDot color={tint} />
                <Badge label={kindLabel(event.kind)} color={tint} />
                <View style={{ flex: 1 }} />
                <Muted>{formatRelative(event.createdAt)}</Muted>
            </Row>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13.5, marginTop: spacing.xs2 }}>{title}</Text>
            {body ? (
                <Muted numberOfLines={3} style={{ marginTop: 2 }}>
                    {body}
                </Muted>
            ) : null}
        </Panel>
    );
});
