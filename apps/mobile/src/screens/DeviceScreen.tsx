/**
 * One phone, mirrored.
 *
 * The layout is `PhoneDevice.dc.html`: back · number and name · state line ·
 * Stop, then the screen framed in ink with the lock bar across the bottom, the
 * hardware row, and the last two log lines. Everything else — the inspector,
 * the schedules, the run history — is below the fold.
 *
 * Touch is locked while a post runs. Holding the bar for 800 ms is the gesture,
 * and it still goes through the biometric gate: a long press is a deliberate
 * act, not an authenticated one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    FlatList,
    Image,
    Pressable,
    Text,
    View,
    useWindowDimensions,
    type LayoutChangeEvent,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    FarmError,
    clipLabel,
    deviceDisplayName,
    deviceNumber,
    formatDuration,
    formatRelative,
    gestureToAction,
    isActionSupported,
    isExecutionRetryable,
    mapTouchToDevice,
    platformOf,
    wallState,
    type ExecutionRow,
    type RemoteAction,
    type ScheduleRow,
} from '@farm/client';
import {
    Button,
    Callout,
    ErrorState,
    InspectorRow,
    IconButton,
    Loading,
    LogBlock,
    Muted,
    Panel,
    Row,
    SectionTitle,
    StatusDot,
} from '../components';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { Icon, type IconName } from '../icons';
import { useAsync, useForegroundInterval, useIsForeground } from '../hooks';
import { executionStatusColor, useTheme, wallStateColor } from '../theme';

/** The mirrored screen runs at 2 fps — the wall's tiles run at a quarter of it. */
const FRAME_INTERVAL_MS = 500;
const HOLD_MS = 800;
/** Enough history to answer "what has this phone been doing", not a log file. */
const HISTORY_LIMIT = 20;

export function DeviceScreen({ udid }: { udid: string }) {
    const { client, snapshot, canAct, refresh } = useFarm();
    const { unlocked, unlock, lock, secondsRemaining } = useSafety();
    const { colors, spacing } = useTheme();
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const foreground = useIsForeground();

    const [nonce, setNonce] = useState(0);
    const [frameFailed, setFrameFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [conflict, setConflict] = useState<string | null>(null);
    const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
    const touchStart = useRef<{ x: number; y: number; at: number } | null>(null);

    const connection = useAsync(() => client.getDeviceConnection(udid), [client, udid]);
    const remote = useAsync(async () => {
        try {
            return await client.getRemoteInfo(udid);
        } catch (error) {
            // 404 just means "not attached right now" — not a screen failure.
            if (error instanceof FarmError && error.kind === 'not-found') return null;
            throw error;
        }
    }, [client, udid]);
    const schedules = useAsync(() => client.listSchedules({ deviceUdid: udid }), [client, udid]);
    const history = useAsync(() => client.listExecutions({ deviceUdid: udid, limit: HISTORY_LIMIT }), [client, udid]);

    const devices = snapshot?.fleet.devices ?? [];
    const index = devices.findIndex((device) => device.udid === udid);
    const fleetDevice = index >= 0 ? devices[index] : undefined;
    const number = index >= 0 ? deviceNumber(index) : '—';
    const name = fleetDevice ? deviceDisplayName(fleetDevice.name) : udid;
    const state = fleetDevice ? wallState(fleetDevice) : 'offline';
    const tint = wallStateColor(state, colors);

    const dimmed = state === 'offline' || state === 'disabled';
    const streaming = foreground && !frameFailed && !dimmed;

    useForegroundInterval(() => setNonce((value) => value + 1), FRAME_INTERVAL_MS, streaming);
    useForegroundInterval(() => void refresh(), 10_000, true);

    // A frame that failed once should be retried when the device comes back,
    // not written off for the life of the screen.
    useEffect(() => {
        if (!dimmed) setFrameFailed(false);
    }, [dimmed, udid]);

    const guard = useCallback(
        async (label: string, run: () => Promise<unknown>) => {
            if (!unlocked && !(await unlock())) return;
            setBusy(label);
            setConflict(null);
            try {
                await run();
                await refresh();
                await connection.reload();
                await history.reload();
            } catch (caught) {
                if (caught instanceof FarmError && caught.kind === 'conflict') setConflict(caught.message);
                else Alert.alert('That did not work', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusy(null);
            }
        },
        [unlocked, unlock, refresh, connection, history],
    );

    const sendAction = useCallback(
        async (action: RemoteAction) => {
            if (!unlocked) return;
            const platform = platformOf(fleetDevice ?? {});
            if (!isActionSupported(action.type, platform)) {
                Alert.alert('Not on this platform', `"${action.type}" is an Android-only remote action.`);
                return;
            }
            try {
                await client.remoteAction(udid, action);
                setNonce((value) => value + 1);
                setConflict(null);
            } catch (caught) {
                if (caught instanceof FarmError && caught.kind === 'conflict') setConflict(caught.message);
                else Alert.alert('That did not work', caught instanceof FarmError ? caught.message : String(caught));
            }
        },
        [client, udid, unlocked, fleetDevice],
    );

    const screenSize = remote.data?.screen.screenSize;
    const frame = client.screenshotRef(udid, { nonce });

    const onTouchEnd = (x: number, y: number) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || !unlocked || !screenSize) return;
        const from = mapTouchToDevice({ x: start.x, y: start.y }, viewSize, screenSize);
        const to = mapTouchToDevice({ x, y }, viewSize, screenSize);
        // A touch in the letterbox is not a tap on the phone.
        if (!from || !to) return;
        void sendAction(gestureToAction(from, to, Date.now() - start.at));
    };

    const running = fleetDevice?.currentExecution ?? null;

    /** The last two log lines, which is what the design puts under the frame. */
    const tail = useMemo(() => {
        const rows = history.data?.executions ?? [];
        return rows.slice(0, 2).map((row, position) => ({
            at: clockOf(row.finishedAt ?? row.startedAt ?? row.createdAt),
            text: sentenceFor(row),
            current: position === 0 && row.status === 'running',
            error: row.status === 'failed',
        }));
    }, [history.data]);

    const stateLine = [
        state === 'error' ? 'Needs you' : capitalise(state),
        running ? running.summary : connection.data?.message,
        streaming ? 'live 2 fps' : 'no frames',
    ]
        .filter(Boolean)
        .join(' · ');

    if (connection.loading && !connection.data) return <Loading label="Checking the device…" />;

    const frameHeight = Math.max(280, Math.round(height * 0.46));
    /**
     * Shape the ink frame to the phone rather than letterboxing inside it: the
     * image is `contain`, so a frame of the wrong aspect puts grey bars either
     * side and makes the tap-mapping's dead zone visible for no reason.
     */
    const frameWidth = screenSize
        ? Math.min(width - 2 * spacing.md2, Math.round(frameHeight * (screenSize.width / screenSize.height)))
        : undefined;

    const header = (
        <View style={{ gap: spacing.sm2 }}>
            {conflict ? (
                <View style={{ paddingHorizontal: spacing.md2 }}>
                    <Callout
                        testID="device-conflict"
                        title="The farm refused that"
                        detail={conflict}
                        actionLabel={running ? 'Stop the run' : undefined}
                        busy={busy === 'stop'}
                        onAction={running ? () => void guard('stop', () => client.stopExecution(running.id)) : undefined}
                    />
                </View>
            ) : null}

            {/* The mirrored screen, framed in ink. */}
            <View
                style={{
                    marginHorizontal: spacing.md2,
                    alignSelf: frameWidth ? 'center' : 'auto',
                    width: frameWidth,
                    height: frameHeight,
                    borderRadius: 22,
                    borderWidth: 8,
                    borderColor: colors.ink,
                    backgroundColor: colors.panel2,
                    overflow: 'hidden',
                }}
            >
                <Pressable
                    testID="device-screenshot"
                    accessibilityLabel={`Mirrored screen of ${number} ${name}`}
                    accessibilityHint={unlocked ? 'Taps and swipes are sent to the phone' : 'Touch is locked'}
                    onLayout={(event: LayoutChangeEvent) =>
                        setViewSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
                    }
                    onPressIn={(event) => {
                        touchStart.current = {
                            x: event.nativeEvent.locationX,
                            y: event.nativeEvent.locationY,
                            at: Date.now(),
                        };
                    }}
                    onPressOut={(event) => onTouchEnd(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
                >
                    {streaming ? (
                        <Image
                            source={frame}
                            onError={() => setFrameFailed(true)}
                            resizeMode="contain"
                            style={{ width: '100%', height: '100%' }}
                        />
                    ) : (
                        <Text style={{ color: colors.text4, fontSize: 12.5 }}>
                            {dimmed ? 'This phone is not on the bus.' : 'No frame right now.'}
                        </Text>
                    )}
                </Pressable>
                <LockBar unlocked={unlocked} seconds={secondsRemaining} onUnlock={unlock} onLock={lock} />
            </View>

            {/* Hardware row, 46 pt as the design draws it. */}
            <Row gap={spacing.sm} style={{ paddingHorizontal: spacing.md2 }}>
                <HardwareKey
                    icon="home"
                    label="Home"
                    testID="device-key-home"
                    disabled={!unlocked}
                    onPress={() => void sendAction({ type: 'home' })}
                />
                <HardwareKey
                    icon="back"
                    label="Back"
                    testID="device-key-back"
                    disabled={!unlocked || platformOf(fleetDevice ?? {}) !== 'android'}
                    onPress={() => void sendAction({ type: 'back' })}
                />
                <HardwareKey
                    icon="recents"
                    label="Recents"
                    testID="device-key-recents"
                    disabled
                    onPress={() => Alert.alert('Not on the remote API', 'The farm has no recents action yet.')}
                />
                <HardwareKey
                    icon="power"
                    label="Power"
                    testID="device-key-power"
                    disabled
                    onPress={() => Alert.alert('Not on the remote API', 'The farm has no power action yet.')}
                />
                <HardwareKey
                    icon="camera"
                    label="Refresh the frame"
                    testID="device-key-screenshot"
                    onPress={() => {
                        setFrameFailed(false);
                        setNonce((value) => value + 1);
                    }}
                />
            </Row>
            <View style={{ paddingHorizontal: spacing.md2 }}>
                <LogBlock lines={tail} testID="device-log" />
            </View>

            {/* Below the fold. */}
            <View style={{ paddingHorizontal: spacing.md2 }}>
                <SectionTitle>This phone</SectionTitle>
                <Panel>
                    <InspectorRow label="State" value={state === 'error' ? 'needs you' : state} tint={tint} />
                    <InspectorRow label="Connection" value={connection.data?.message ?? '—'} />
                    <InspectorRow label="Control channel" value={connection.data?.wda ?? '—'} />
                    <InspectorRow label="Platform" value={platformOf(fleetDevice ?? {})} />
                    <InspectorRow
                        label="Screen"
                        value={screenSize ? `${screenSize.width} × ${screenSize.height} pt` : 'not attached'}
                    />
                    <InspectorRow label="Next run" value={fleetDevice?.nextRunAt ? formatRelative(fleetDevice.nextRunAt) : 'nothing scheduled'} />
                    <InspectorRow label="Updated" value={formatRelative(connection.data?.updatedAt)} />
                </Panel>

                <Row gap={spacing.sm} style={{ marginTop: spacing.sm2 }}>
                    <Button
                        label="Reconnect"
                        style={{ flex: 1 }}
                        disabled={!canAct}
                        busy={busy === 'reconnect'}
                        onPress={() => void guard('reconnect', () => client.reconnectDevice(udid))}
                        testID="device-reconnect"
                    />
                    <Button
                        label={state === 'disabled' ? 'Activate' : 'Disable'}
                        variant="danger"
                        style={{ flex: 1 }}
                        disabled={!canAct}
                        busy={busy === 'disable'}
                        testID="device-disable"
                        onPress={() =>
                            Alert.alert(
                                state === 'disabled' ? 'Activate this phone?' : 'Disable this phone?',
                                'Scheduling and automation stop until it is activated again.',
                                [
                                    { text: 'Cancel', style: 'cancel' },
                                    {
                                        text: 'Confirm',
                                        style: 'destructive',
                                        onPress: () =>
                                            void guard('disable', () =>
                                                client.patchDevice(udid, { disabled: state !== 'disabled' }),
                                            ),
                                    },
                                ],
                            )
                        }
                    />
                </Row>

                <SectionTitle>Schedules</SectionTitle>
                {(schedules.data?.schedules ?? []).length === 0 ? (
                    <Panel>
                        <Muted>Nothing is scheduled on this phone.</Muted>
                    </Panel>
                ) : (
                    <View style={{ gap: spacing.sm }}>
                        {(schedules.data?.schedules ?? []).map((row) => (
                            <ScheduleLine
                                key={row.id}
                                schedule={row}
                                canAct={canAct}
                                busy={busy === row.id}
                                onToggle={() =>
                                    void guard(row.id, () =>
                                        client
                                            .setScheduleStatus(row.id, row.status === 'paused' ? 'resume' : 'pause')
                                            .then(() => schedules.reload()),
                                    )
                                }
                            />
                        ))}
                    </View>
                )}

                <SectionTitle>Recent runs</SectionTitle>
            </View>

            {connection.error ? (
                <ErrorState error={connection.error} onRetry={() => void connection.reload()} testID="device-error" />
            ) : null}
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
            <Row gap={spacing.sm2} style={{ paddingHorizontal: spacing.md2, paddingBottom: spacing.sm }}>
                <IconButton icon="chevronLeft" accessibilityLabel="Back to the wall" onPress={() => router.back()} testID="device-back" />
                <View style={{ flex: 1 }}>
                    <Row gap={spacing.xs2}>
                        <Text style={{ color: colors.text3, fontSize: 17, fontWeight: '700' }}>{number}</Text>
                        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 17, fontWeight: '700', flexShrink: 1 }}>
                            {name}
                        </Text>
                    </Row>
                    <Row gap={spacing.xs2}>
                        <StatusDot color={tint} size={7} />
                        <Text numberOfLines={1} testID="device-state-line" style={{ color: tint, fontSize: 12, fontWeight: '500', flex: 1 }}>
                            {stateLine}
                        </Text>
                    </Row>
                </View>
                {running ? (
                    <Button
                        label="Stop"
                        variant="primary"
                        compact
                        disabled={!canAct}
                        busy={busy === 'stop'}
                        onPress={() => void guard('stop', () => client.stopExecution(running.id))}
                        testID="device-stop"
                    />
                ) : null}
            </Row>

            <FlatList
                testID="device-history"
                data={history.data?.executions ?? []}
                keyExtractor={executionKey}
                ListHeaderComponent={header}
                contentContainerStyle={{ paddingBottom: spacing.xxl + insets.bottom, gap: spacing.sm }}
                ListEmptyComponent={
                    <View style={{ paddingHorizontal: spacing.md2 }}>
                        <Panel>
                            <Muted>Nothing has run on this phone yet.</Muted>
                        </Panel>
                    </View>
                }
                renderItem={({ item }) => (
                    <View style={{ paddingHorizontal: spacing.md2 }}>
                        <Panel
                            testID={`device-execution-${item.id}`}
                            accessibilityLabel={`${clipLabel(item.taskType)}, ${item.status}`}
                            onPress={() => router.push(`/execution/${encodeURIComponent(item.id)}` as never)}
                            style={{ paddingVertical: spacing.sm2 }}
                        >
                            <Row gap={spacing.sm}>
                                <StatusDot color={executionStatusColor(item.status, colors)} />
                                <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600', flex: 1 }} numberOfLines={1}>
                                    {clipLabel(item.taskType)}
                                </Text>
                                <Muted>{formatRelative(item.startedAt ?? item.createdAt)}</Muted>
                            </Row>
                            <Muted numberOfLines={2} style={{ marginTop: 2 }}>
                                {sentenceFor(item)}
                            </Muted>
                            {isExecutionRetryable(item.status) ? (
                                <Button
                                    label="Retry"
                                    style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
                                    disabled={!canAct}
                                    busy={busy === item.id}
                                    onPress={() => void guard(item.id, () => client.retryExecution(item.id))}
                                    testID={`device-retry-${item.id}`}
                                />
                            ) : null}
                        </Panel>
                    </View>
                )}
            />
        </View>
    );
}

function executionKey(row: ExecutionRow): string {
    return row.id;
}

/* --------------------------------------------------------------- lock bar */

/**
 * "Touch is locked while a post runs. Hold to unlock." The hold is 800 ms and
 * then the biometric gate — the same gate every other write goes through. This
 * lock is on the phone, not on the API; the farm's own 409 is the real one.
 */
function LockBar({
    unlocked,
    seconds,
    onUnlock,
    onLock,
}: {
    unlocked: boolean;
    seconds: number;
    onUnlock: () => Promise<boolean>;
    onLock: () => void;
}) {
    const { colors, spacing } = useTheme();
    const [holding, setHolding] = useState(false);

    return (
        <Pressable
            testID="device-lock-bar"
            accessibilityRole="button"
            accessibilityState={{ disabled: false, selected: unlocked }}
            accessibilityLabel={unlocked ? `Touch is unlocked for ${seconds} seconds. Lock it now.` : 'Touch is locked. Hold to unlock.'}
            accessibilityHint={unlocked ? 'Locks remote touch' : 'Hold for eight hundred milliseconds to unlock remote touch'}
            delayLongPress={HOLD_MS}
            onPressIn={() => setHolding(true)}
            onPressOut={() => setHolding(false)}
            onPress={() => {
                if (unlocked) onLock();
            }}
            onLongPress={() => {
                if (!unlocked) void onUnlock();
            }}
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                minHeight: 44,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm2,
                backgroundColor: unlocked ? colors.accent : colors.scrim,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                opacity: holding ? 0.85 : 1,
            }}
        >
            <Icon name={unlocked ? 'unlock' : 'lock'} size={14} color="#ffffff" />
            <Text style={{ color: '#ffffff', fontSize: 12, flex: 1 }}>
                {unlocked
                    ? `Touch is live for ${seconds}s. Tap to lock.`
                    : 'Touch is locked while a post runs. Hold to unlock.'}
            </Text>
        </Pressable>
    );
}

/* ---------------------------------------------------------- hardware keys */

function HardwareKey({
    icon,
    label,
    onPress,
    disabled = false,
    testID,
}: {
    icon: IconName;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
}) {
    const { colors, radius } = useTheme();
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => ({
                flex: 1,
                height: 46,
                borderRadius: radius.card,
                backgroundColor: colors.panel,
                borderWidth: 1,
                borderColor: colors.line,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
            })}
        >
            <Icon name={icon} size={20} color={colors.text2} />
        </Pressable>
    );
}

/* ------------------------------------------------------------- schedules */

function ScheduleLine({
    schedule,
    canAct,
    busy,
    onToggle,
}: {
    schedule: ScheduleRow;
    canAct: boolean;
    busy: boolean;
    onToggle: () => void;
}) {
    const { colors, spacing } = useTheme();
    const paused = schedule.status === 'paused';
    return (
        <Panel testID={`device-schedule-${schedule.id}`} style={{ paddingVertical: spacing.sm2 }}>
            <Row gap={spacing.sm}>
                <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600' }} numberOfLines={1}>
                        {clipLabel(schedule.taskType)}
                    </Text>
                    <Muted>
                        {schedule.nextRunAt ? `next ${formatRelative(schedule.nextRunAt)}` : `no next run · ${schedule.status}`}
                    </Muted>
                </View>
                {schedule.status === 'active' || paused ? (
                    <Button
                        label={paused ? 'Resume' : 'Pause'}
                        compact
                        disabled={!canAct}
                        busy={busy}
                        onPress={onToggle}
                        testID={`device-schedule-toggle-${schedule.id}`}
                    />
                ) : null}
            </Row>
        </Panel>
    );
}

/* ------------------------------------------------------------- utilities */

function capitalise(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "18:31:02" — the design's log rows are a wall clock, not an ISO string. */
function clockOf(iso: string | null): string {
    if (!iso) return '--:--:--';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return '--:--:--';
    return parsed.toTimeString().slice(0, 8);
}

/** "Say what happened and what to do" — never "Execution error (exit 1)". */
function sentenceFor(row: ExecutionRow): string {
    const label = clipLabel(row.taskType);
    switch (row.status) {
        case 'running':
            return `${label} is running.`;
        case 'queued':
            return `${label} is waiting for its turn.`;
        case 'succeeded': {
            const started = row.startedAt ? Date.parse(row.startedAt) : null;
            const finished = row.finishedAt ? Date.parse(row.finishedAt) : null;
            return started && finished ? `${label} finished in ${formatDuration(finished - started)}.` : `${label} finished.`;
        }
        case 'failed':
            return row.error ? `${label} failed. ${row.error}` : `${label} failed.`;
        case 'stopped':
            return `${label} was stopped.`;
        case 'cancelled':
            return `${label} was cancelled.`;
        case 'skipped':
            return `${label} was skipped.`;
    }
}
