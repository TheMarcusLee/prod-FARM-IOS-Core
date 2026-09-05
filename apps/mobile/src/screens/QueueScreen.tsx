import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    FarmError,
    formatDuration,
    formatRelative,
    isExecutionRetryable,
    isExecutionStoppable,
    isScheduleEditable,
    type ExecutionRow,
    type ScheduleRow,
    type ScheduleTiming,
} from '@farm/client';
import { Badge, Button, Card, EmptyState, ErrorBanner, Loading, Muted, Row } from '../components';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { executionStatusColor, scheduleStatusColor, useTheme } from '../theme';

type Segment = 'schedules' | 'executions';

export function QueueScreen() {
    const { client, snapshot, canAct, needsSetup } = useFarm();
    const { colors, spacing, radius } = useTheme();
    const [segment, setSegment] = useState<Segment>('schedules');
    const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
    const [executions, setExecutions] = useState<ExecutionRow[]>([]);
    const [cursor, setCursor] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<FarmError | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, device.name);
        return map;
    }, [snapshot]);

    const load = useCallback(
        async (reset = true) => {
            if (needsSetup) {
                setLoading(false);
                return;
            }
            try {
                if (segment === 'schedules') {
                    const page = await client.listSchedules({ limit: 100 });
                    setSchedules(page.schedules);
                } else {
                    const page = await client.listExecutions({ limit: 50, before: reset ? undefined : cursor });
                    setExecutions((previous) => (reset ? page.executions : [...previous, ...page.executions]));
                    setCursor(page.nextBefore);
                }
                setError(null);
            } catch (caught) {
                setError(caught instanceof FarmError ? caught : new FarmError('unknown', String(caught)));
            } finally {
                setLoading(false);
            }
        },
        [client, segment, cursor, needsSetup],
    );

    useEffect(() => {
        setLoading(true);
        void load(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, segment]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load(true);
        setRefreshing(false);
    }, [load]);

    const act = useCallback(
        async (id: string, run: () => Promise<unknown>) => {
            setBusyId(id);
            try {
                await run();
                await load(true);
            } catch (caught) {
                // A `409` here is information, not a crash: the farm is telling
                // the operator why the thing they tapped cannot happen.
                Alert.alert('The farm said no', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusyId(null);
            }
        },
        [load],
    );

    if (needsSetup) return <EmptyState title="No farm configured" detail="Add a server URL and token in Settings." />;
    if (loading) return <Loading />;

    return (
        <View style={{ flex: 1 }}>
            <Row style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
                {(['schedules', 'executions'] as const).map((option) => (
                    <Text
                        key={option}
                        accessibilityRole="button"
                        testID={`queue-segment-${option}`}
                        onPress={() => setSegment(option)}
                        style={{
                            flex: 1,
                            textAlign: 'center',
                            paddingVertical: 8,
                            borderRadius: radius.md,
                            overflow: 'hidden',
                            fontWeight: '700',
                            fontSize: 13,
                            color: segment === option ? colors.accentText : colors.textMuted,
                            backgroundColor: segment === option ? colors.accent : colors.surface,
                        }}
                    >
                        {option}
                    </Text>
                ))}
            </Row>

            {error ? <ErrorBanner message={error.message} onRetry={() => void load(true)} /> : null}

            {segment === 'schedules' ? (
                <FlatList
                    data={schedules}
                    keyExtractor={(row) => row.id}
                    contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                    ListEmptyComponent={<EmptyState title="No schedules" />}
                    renderItem={({ item }) => (
                        <ScheduleCard
                            schedule={item}
                            deviceName={names.get(item.deviceUdid) ?? item.deviceUdid}
                            canAct={canAct}
                            busy={busyId === item.id}
                            onTransition={(transition) => void act(item.id, () => client.setScheduleStatus(item.id, transition))}
                        />
                    )}
                />
            ) : (
                <FlatList
                    data={executions}
                    keyExtractor={(row) => row.id}
                    contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                    onEndReached={() => cursor && void load(false)}
                    onEndReachedThreshold={0.4}
                    ListEmptyComponent={<EmptyState title="No executions yet" />}
                    renderItem={({ item }) => (
                        <ExecutionCard
                            execution={item}
                            deviceName={names.get(item.deviceUdid) ?? item.deviceUdid}
                            canAct={canAct}
                            busy={busyId === item.id}
                            onStop={() => void act(item.id, () => client.stopExecution(item.id))}
                            onRetry={() => void act(item.id, () => client.retryExecution(item.id))}
                        />
                    )}
                />
            )}
        </View>
    );
}

/** Timing in the schedule's own timezone, because the operator may not be in it. */
export function describeTiming(timing: ScheduleTiming): string {
    switch (timing.kind) {
        case 'now':
            return 'run now';
        case 'once':
            return `once · ${new Date(timing.runAt).toLocaleString()}`;
        case 'daily':
            return `daily ${timing.localTime} ${timing.timezone}`;
        case 'weekly': {
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const which = timing.weekdays.map((day) => days[day] ?? String(day)).join(' ');
            return `weekly ${which} ${timing.localTime} ${timing.timezone}`;
        }
    }
}

function ScheduleCard({
    schedule,
    deviceName,
    canAct,
    busy,
    onTransition,
}: {
    schedule: ScheduleRow;
    deviceName: string;
    canAct: boolean;
    busy: boolean;
    onTransition: (transition: 'pause' | 'resume' | 'cancel') => void;
}) {
    const { colors, spacing } = useTheme();
    const editable = isScheduleEditable(schedule.status);
    return (
        <Card testID={`schedule-${schedule.id}`}>
            <Row style={{ marginBottom: 4 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14, flex: 1 }} numberOfLines={1}>
                    {schedule.taskType} · {deviceName}
                </Text>
                <Badge label={schedule.status} color={scheduleStatusColor(schedule.status, colors)} />
            </Row>
            <Muted>{describeTiming(schedule.timing)}</Muted>
            <Muted>
                {schedule.nextRunAt ? `next ${formatRelative(schedule.nextRunAt)} · ${new Date(schedule.nextRunAt).toLocaleTimeString()} local` : 'no next run'}
            </Muted>
            {editable ? (
                <Row style={{ marginTop: spacing.sm }}>
                    <Button
                        label={schedule.status === 'paused' ? 'Resume' : 'Pause'}
                        disabled={!canAct}
                        busy={busy}
                        onPress={() => onTransition(schedule.status === 'paused' ? 'resume' : 'pause')}
                        testID={`schedule-toggle-${schedule.id}`}
                    />
                    <Button label="Cancel" variant="danger" disabled={!canAct} busy={busy} onPress={() => onTransition('cancel')} />
                </Row>
            ) : null}
        </Card>
    );
}

function ExecutionCard({
    execution,
    deviceName,
    canAct,
    busy,
    onStop,
    onRetry,
}: {
    execution: ExecutionRow;
    deviceName: string;
    canAct: boolean;
    busy: boolean;
    onStop: () => void;
    onRetry: () => void;
}) {
    const { colors, spacing } = useTheme();
    const { unlocked, unlock } = useSafety();
    const started = execution.startedAt ? Date.parse(execution.startedAt) : null;
    const finished = execution.finishedAt ? Date.parse(execution.finishedAt) : Date.now();
    const duration = started ? formatDuration(finished - started) : '—';

    // Stopping a run touches a phone, so it sits behind the same lock.
    const guard = async (run: () => void) => {
        if (unlocked || (await unlock())) run();
    };

    return (
        <Card testID={`execution-${execution.id}`} onPress={() => router.push(`/execution/${encodeURIComponent(execution.id)}` as never)}>
            <Row style={{ marginBottom: 4 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14, flex: 1 }} numberOfLines={1}>
                    {execution.taskType} · {deviceName}
                </Text>
                <Badge label={execution.status} color={executionStatusColor(execution.status, colors)} />
            </Row>
            <Muted>
                {formatRelative(execution.startedAt ?? execution.createdAt)} · {duration}
            </Muted>
            {execution.error ? (
                <Text numberOfLines={2} style={{ color: colors.danger, fontSize: 12, marginTop: 4 }}>
                    {execution.error}
                </Text>
            ) : null}
            <Row style={{ marginTop: spacing.sm }}>
                {isExecutionStoppable(execution.status) ? (
                    <Button label="Stop" variant="danger" disabled={!canAct} busy={busy} onPress={() => void guard(onStop)} testID={`execution-stop-${execution.id}`} />
                ) : null}
                {isExecutionRetryable(execution.status) ? (
                    <Button label="Retry" disabled={!canAct} busy={busy} onPress={() => void guard(onRetry)} testID={`execution-retry-${execution.id}`} />
                ) : null}
            </Row>
        </Card>
    );
}
