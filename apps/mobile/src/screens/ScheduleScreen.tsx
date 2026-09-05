/**
 * Schedule answers "what happens tonight".
 *
 * The strip at the top is the desktop timeline made compact: one track per
 * phone, clips coloured by account, a playhead on now. Under it is the work
 * itself — what is coming and what just ran — with the controls the operator
 * reaches for at 2am: stop, retry, pause.
 *
 * The strip comes from `GET /api/schedule/timeline?from=&to=`. A farm that
 * predates the endpoint answers 404, and `composeTimeline()` builds the same
 * shape from the schedules and executions the app already has, so the screen
 * looks identical either way.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    FarmError,
    clipLabel,
    composeTimeline,
    formatRelative,
    isExecutionRetryable,
    isExecutionStoppable,
    isScheduleEditable,
    type ExecutionRow,
    type ScheduleRow,
    type ScheduleTimeline,
    type TimelineClip,
} from '@farm/client';
import {
    Button,
    EmptyState,
    ErrorState,
    Loading,
    Muted,
    NumberChip,
    Panel,
    Row,
    ScreenHeader,
    Segmented,
    StatusDot,
} from '../components';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { accountFill, executionStatusColor, scheduleStatusColor, useTheme } from '../theme';

/** The window the strip covers: an hour behind, seven ahead. */
const HOURS_BEHIND = 1;
const HOURS_AHEAD = 7;
const PIXELS_PER_HOUR = 92;
const TRACK_HEIGHT = 34;
const CLIP_HEIGHT = 28;
const GUTTER = 34;

type Segment = 'upcoming' | 'recent';

interface Listed {
    key: string;
    execution?: ExecutionRow;
    schedule?: ScheduleRow;
    at: string | null;
}

export function ScheduleScreen() {
    const { client, snapshot, canAct, needsSetup } = useFarm();
    const { unlocked, unlock } = useSafety();
    const { colors, spacing } = useTheme();

    const [segment, setSegment] = useState<Segment>('upcoming');
    const [remoteTimeline, setRemoteTimeline] = useState<ScheduleTimeline | null>(null);
    /** The farm predates `/api/schedule/timeline`; compose the strip locally. */
    const [composeLocally, setComposeLocally] = useState(false);
    const [loadedAt, setLoadedAt] = useState<number | null>(null);
    const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
    const [executions, setExecutions] = useState<ExecutionRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<FarmError | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, device.name);
        return map;
    }, [snapshot]);

    const load = useCallback(async () => {
        if (needsSetup) {
            setLoading(false);
            return;
        }
        const now = Date.now();
        const from = new Date(now - HOURS_BEHIND * 3_600_000).toISOString();
        const to = new Date(now + HOURS_AHEAD * 3_600_000).toISOString();
        try {
            const [schedulePage, executionPage] = await Promise.all([
                client.listSchedules({ limit: 200 }),
                client.listExecutions({ limit: 100 }),
            ]);
            setSchedules(schedulePage.schedules);
            setExecutions(executionPage.executions);

            try {
                setRemoteTimeline(await client.getScheduleTimeline({ from, to }));
                setComposeLocally(false);
            } catch (caught) {
                // Only a missing endpoint falls back — a 401 or a dead Mac is a
                // real failure and must not be papered over with local data.
                if (!(caught instanceof FarmError) || caught.kind !== 'not-found') throw caught;
                setRemoteTimeline(null);
                setComposeLocally(true);
            }
            setLoadedAt(now);
            setError(null);
        } catch (caught) {
            setError(caught instanceof FarmError ? caught : new FarmError('unknown', String(caught)));
        } finally {
            setLoading(false);
        }
    }, [client, needsSetup]);

    useEffect(() => {
        setLoading(true);
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const act = useCallback(
        async (id: string, run: () => Promise<unknown>) => {
            if (!unlocked && !(await unlock())) return;
            setBusyId(id);
            try {
                await run();
                await load();
            } catch (caught) {
                // A 409 here is information, not a crash: the farm is telling
                // the operator why the thing they tapped cannot happen.
                Alert.alert('The farm said no', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusyId(null);
            }
        },
        [load, unlocked, unlock],
    );

    /**
     * Composed rather than stored: the fleet snapshot can land after this
     * screen has already fetched, and a strip built once from an empty device
     * list would stay empty until the next pull-to-refresh.
     */
    const timeline = useMemo<ScheduleTimeline | null>(() => {
        if (remoteTimeline) return remoteTimeline;
        if (!composeLocally || loadedAt === null) return null;
        return composeTimeline({
            devices: snapshot?.fleet.devices ?? [],
            schedules,
            executions,
            from: new Date(loadedAt - HOURS_BEHIND * 3_600_000).toISOString(),
            to: new Date(loadedAt + HOURS_AHEAD * 3_600_000).toISOString(),
            now: new Date(loadedAt).toISOString(),
        });
    }, [remoteTimeline, composeLocally, loadedAt, snapshot, schedules, executions]);

    const upcoming = useMemo<Listed[]>(() => {
        const live: Listed[] = executions
            .filter((row) => row.status === 'running' || row.status === 'queued')
            .map((row) => ({ key: `exe:${row.id}`, execution: row, at: row.startedAt ?? row.scheduledFor }));
        const planned: Listed[] = schedules
            .filter((row) => row.status === 'active' && row.nextRunAt)
            .map((row) => ({ key: `sch:${row.id}`, schedule: row, at: row.nextRunAt }));
        const paused: Listed[] = schedules
            .filter((row) => row.status === 'paused')
            .map((row) => ({ key: `sch:${row.id}`, schedule: row, at: row.nextRunAt }));
        return [...live, ...planned, ...paused].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    }, [executions, schedules]);

    const recent = useMemo<Listed[]>(
        () =>
            executions
                .filter((row) => row.status !== 'running' && row.status !== 'queued')
                .map((row) => ({ key: `exe:${row.id}`, execution: row, at: row.finishedAt ?? row.createdAt })),
        [executions],
    );

    if (needsSetup) {
        return (
            <View style={{ flex: 1 }}>
                <ScreenHeader title="Schedule" />
                <EmptyState
                    title="No farm configured"
                    detail="Add a server URL and token under Rig."
                    actionLabel="Open Rig"
                    onAction={() => router.push('/rig' as never)}
                />
            </View>
        );
    }
    if (loading) return <Loading label="Reading the schedule…" />;

    const rows = segment === 'upcoming' ? upcoming : recent;

    return (
        <View style={{ flex: 1 }}>
            <ScreenHeader
                title="Schedule"
                subtitle={
                    <Muted>
                        {upcoming.length === 0 ? 'Nothing is queued' : `${upcoming.length} coming up`}
                        {` · ${recent.length} recent`}
                    </Muted>
                }
            />

            {error ? <ErrorState error={error} onRetry={() => void load()} testID="schedule-error" /> : null}

            <FlatList
                testID={`schedule-${segment}-list`}
                data={rows}
                keyExtractor={listKey}
                contentContainerStyle={{ paddingBottom: spacing.xxl, gap: spacing.sm }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                ListHeaderComponent={
                    <View style={{ gap: spacing.md }}>
                        <Timeline timeline={timeline} />
                        <View style={{ paddingHorizontal: spacing.lg2 }}>
                            <Segmented
                                testIDPrefix="schedule-segment"
                                value={segment}
                                onChange={setSegment}
                                options={[
                                    { key: 'upcoming', label: 'Upcoming' },
                                    { key: 'recent', label: 'Recent' },
                                ]}
                            />
                        </View>
                    </View>
                }
                ListEmptyComponent={
                    <EmptyState
                        title={segment === 'upcoming' ? 'Nothing is queued' : 'Nothing has run yet'}
                        detail={
                            segment === 'upcoming'
                                ? 'Select phones on the Wall and schedule a post.'
                                : 'Runs appear here once the farm has done some work.'
                        }
                    />
                }
                renderItem={({ item }) => (
                    <View style={{ paddingHorizontal: spacing.lg2 }}>
                        {item.execution ? (
                            <ExecutionCard
                                execution={item.execution}
                                deviceName={names.get(item.execution.deviceUdid) ?? item.execution.deviceUdid}
                                canAct={canAct}
                                busy={busyId === item.execution.id}
                                onStop={() => void act(item.execution!.id, () => client.stopExecution(item.execution!.id))}
                                onRetry={() => void act(item.execution!.id, () => client.retryExecution(item.execution!.id))}
                            />
                        ) : item.schedule ? (
                            <ScheduleCard
                                schedule={item.schedule}
                                deviceName={names.get(item.schedule.deviceUdid) ?? item.schedule.deviceUdid}
                                canAct={canAct}
                                busy={busyId === item.schedule.id}
                                onTransition={(transition) =>
                                    void act(item.schedule!.id, () => client.setScheduleStatus(item.schedule!.id, transition))
                                }
                            />
                        ) : null}
                    </View>
                )}
            />
        </View>
    );
}

function listKey(row: Listed): string {
    return row.key;
}

/* --------------------------------------------------------------- the strip */

/**
 * Tracks are phones and clips are posts. A clip is 28 pt tall with the account
 * fill and a darker 1px border; a running one carries a progress overlay, a
 * failed one is bad-soft with a bad border, a plan is a dashed outline.
 */
function Timeline({ timeline }: { timeline: ScheduleTimeline | null }) {
    const { colors, radius, spacing, scheme } = useTheme();

    const window = useMemo(() => {
        const now = timeline ? Date.parse(timeline.now) : Date.now();
        const start = now - HOURS_BEHIND * 3_600_000;
        return { now, start, end: now + HOURS_AHEAD * 3_600_000 };
    }, [timeline]);

    const tracks = (timeline?.tracks ?? []).filter((track) => track.clips.length > 0);
    const width = (HOURS_BEHIND + HOURS_AHEAD) * PIXELS_PER_HOUR;
    const xOf = (iso: string) => ((Date.parse(iso) - window.start) / 3_600_000) * PIXELS_PER_HOUR;

    const hours = useMemo(() => {
        const marks: { at: number; label: string }[] = [];
        const first = new Date(window.start);
        first.setMinutes(0, 0, 0);
        for (let hour = 0; hour <= HOURS_BEHIND + HOURS_AHEAD + 1; hour += 1) {
            const at = first.getTime() + hour * 3_600_000;
            if (at < window.start || at > window.end) continue;
            marks.push({ at, label: new Date(at).toTimeString().slice(0, 5) });
        }
        return marks;
    }, [window]);

    if (tracks.length === 0) {
        return (
            <View style={{ paddingHorizontal: spacing.lg2 }}>
                <Panel testID="schedule-timeline">
                    <Muted>Nothing is planned in the next {HOURS_AHEAD} hours.</Muted>
                </Panel>
            </View>
        );
    }

    return (
        <View style={{ paddingHorizontal: spacing.lg2 }}>
            <Panel testID="schedule-timeline" style={{ padding: 0, overflow: 'hidden' }}>
                <Row style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm2, paddingBottom: spacing.xs2 }}>
                    <Text style={{ color: colors.text3, fontSize: 12.5, fontWeight: '600', flex: 1 }}>Tonight</Text>
                    <Muted>
                        {new Date(window.start).toTimeString().slice(0, 5)} – {new Date(window.end).toTimeString().slice(0, 5)}
                    </Muted>
                </Row>
                <Row gap={0} style={{ alignItems: 'stretch' }}>
                    <View style={{ width: GUTTER, paddingTop: 18 }}>
                        {tracks.map((track) => (
                            <View key={track.udid} style={{ height: TRACK_HEIGHT, justifyContent: 'center', paddingLeft: spacing.sm }}>
                                <NumberChip number={track.number} />
                            </View>
                        ))}
                    </View>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        accessibilityLabel={`Timeline for ${tracks.length} phones`}
                        contentContainerStyle={{ width, paddingBottom: spacing.sm2 }}
                    >
                        <View style={{ width }}>
                            <View style={{ height: 18, flexDirection: 'row' }}>
                                {hours.map((mark) => (
                                    <Text
                                        key={mark.at}
                                        style={{
                                            position: 'absolute',
                                            left: ((mark.at - window.start) / 3_600_000) * PIXELS_PER_HOUR + 2,
                                            color: colors.text4,
                                            fontSize: 11,
                                        }}
                                    >
                                        {mark.label}
                                    </Text>
                                ))}
                            </View>
                            {tracks.map((track) => (
                                <View
                                    key={track.udid}
                                    accessibilityLabel={`${track.number} ${track.name}, ${track.clips.length} clips`}
                                    style={{
                                        height: TRACK_HEIGHT,
                                        justifyContent: 'center',
                                        borderTopWidth: 1,
                                        borderTopColor: colors.line,
                                    }}
                                >
                                    {track.clips.map((clip) => (
                                        <Clip
                                            key={clip.id}
                                            clip={clip}
                                            left={Math.max(0, xOf(clip.start))}
                                            width={Math.max(26, xOf(clip.end) - Math.max(0, xOf(clip.start)))}
                                            scheme={scheme}
                                        />
                                    ))}
                                </View>
                            ))}
                            {/* The playhead. */}
                            <View
                                testID="schedule-playhead"
                                pointerEvents="none"
                                style={{
                                    position: 'absolute',
                                    left: ((window.now - window.start) / 3_600_000) * PIXELS_PER_HOUR,
                                    top: 14,
                                    bottom: 0,
                                    width: 1.5,
                                    backgroundColor: colors.accent,
                                    borderRadius: radius.sm,
                                }}
                            />
                        </View>
                    </ScrollView>
                </Row>
            </Panel>
        </View>
    );
}

function Clip({ clip, left, width, scheme }: { clip: TimelineClip; left: number; width: number; scheme: 'light' | 'dark' }) {
    const { colors } = useTheme();
    const account = accountFill(String(clip.accountColor), scheme);
    const failed = clip.status === 'failed';
    const plan = clip.kind === 'plan';

    return (
        <View
            accessibilityLabel={`${clip.label} for ${clip.account}, ${clip.status}`}
            style={{
                position: 'absolute',
                left,
                width,
                height: CLIP_HEIGHT,
                borderRadius: 5,
                paddingHorizontal: 5,
                justifyContent: 'center',
                overflow: 'hidden',
                backgroundColor: failed ? colors.badSoft : plan ? colors.panel : account.fill,
                borderWidth: failed || plan ? 1.5 : 1,
                borderColor: failed ? colors.bad : plan ? account.border : account.border,
                borderStyle: plan ? 'dashed' : 'solid',
            }}
        >
            <Text
                numberOfLines={1}
                style={{
                    fontSize: 11.5,
                    fontWeight: '500',
                    color: failed ? colors.bad : plan ? colors.text2 : account.text,
                }}
            >
                {clip.label}
            </Text>
        </View>
    );
}

/* ---------------------------------------------------------------- the rows */

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
        <Panel testID={`schedule-${schedule.id}`}>
            <Row gap={spacing.sm}>
                <StatusDot color={scheduleStatusColor(schedule.status, colors)} />
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13.5, flex: 1 }} numberOfLines={1}>
                    {clipLabel(schedule.taskType)}
                </Text>
                <Muted>{schedule.status}</Muted>
            </Row>
            <Muted style={{ marginTop: 2 }}>
                {deviceName} · {describeTiming(schedule.timing)}
            </Muted>
            <Muted>
                {schedule.nextRunAt
                    ? `next ${formatRelative(schedule.nextRunAt)} · ${new Date(schedule.nextRunAt).toLocaleTimeString()} local`
                    : 'no next run'}
            </Muted>
            {editable ? (
                <Row gap={spacing.sm} style={{ marginTop: spacing.sm2 }}>
                    <Button
                        label={schedule.status === 'paused' ? 'Resume' : 'Pause'}
                        disabled={!canAct}
                        busy={busy}
                        onPress={() => onTransition(schedule.status === 'paused' ? 'resume' : 'pause')}
                        testID={`schedule-toggle-${schedule.id}`}
                    />
                    <Button
                        label="Cancel"
                        variant="danger"
                        disabled={!canAct}
                        busy={busy}
                        onPress={() => onTransition('cancel')}
                        testID={`schedule-cancel-${schedule.id}`}
                    />
                </Row>
            ) : null}
        </Panel>
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
    return (
        <Panel
            testID={`execution-${execution.id}`}
            accessibilityLabel={`${clipLabel(execution.taskType)} on ${deviceName}, ${execution.status}`}
            onPress={() => router.push(`/execution/${encodeURIComponent(execution.id)}` as never)}
        >
            <Row gap={spacing.sm}>
                <StatusDot color={executionStatusColor(execution.status, colors)} />
                <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13.5, flex: 1 }} numberOfLines={1}>
                    {clipLabel(execution.taskType)}
                </Text>
                <Muted>{execution.status}</Muted>
            </Row>
            <Muted style={{ marginTop: 2 }}>
                {deviceName} · {formatRelative(execution.startedAt ?? execution.createdAt)}
            </Muted>
            {execution.error ? (
                <Text numberOfLines={2} style={{ color: colors.bad, fontSize: 12.5, marginTop: 4 }}>
                    {execution.error}
                </Text>
            ) : null}
            {isExecutionStoppable(execution.status) || isExecutionRetryable(execution.status) ? (
                <Row gap={spacing.sm} style={{ marginTop: spacing.sm2 }}>
                    {isExecutionStoppable(execution.status) ? (
                        <Button
                            label="Stop"
                            variant="danger"
                            disabled={!canAct}
                            busy={busy}
                            onPress={onStop}
                            testID={`execution-stop-${execution.id}`}
                        />
                    ) : null}
                    {isExecutionRetryable(execution.status) ? (
                        <Button
                            label="Retry"
                            disabled={!canAct}
                            busy={busy}
                            onPress={onRetry}
                            testID={`execution-retry-${execution.id}`}
                        />
                    ) : null}
                </Row>
            ) : null}
        </Panel>
    );
}

/** Timing in the schedule's own timezone, because the operator may not be in it. */
export function describeTiming(timing: ScheduleRow['timing']): string {
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
