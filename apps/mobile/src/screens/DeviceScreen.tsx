import { useCallback, useRef, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, Switch, Text, View, type LayoutChangeEvent } from 'react-native';
import { router } from 'expo-router';
import {
    FarmError,
    formatRelative,
    gestureToAction,
    isActionSupported,
    mapTouchToDevice,
    platformOf,
    type RemoteAction,
} from '@farm/client';
import { Badge, Button, Card, ErrorState, Loading, Muted, Row, SectionTitle, StatusDot } from '../components';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { useAsync, useForegroundInterval, useIsForeground } from '../hooks';
import { deviceStateColor, useTheme } from '../theme';

export function DeviceScreen({ udid }: { udid: string }) {
    const { client, snapshot, canAct, refresh } = useFarm();
    const { unlocked, unlock, lock, secondsRemaining, available } = useSafety();
    const { colors, spacing, radius } = useTheme();
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

    const fleetDevice = snapshot?.fleet.devices.find((device) => device.udid === udid);

    // 5 s auto-refresh only while remote control is unlocked; otherwise manual.
    useForegroundInterval(
        () => {
            setFrameFailed(false);
            setNonce((value) => value + 1);
        },
        5_000,
        unlocked,
    );

    const guard = useCallback(
        async (name: string, run: () => Promise<unknown>) => {
            if (!unlocked && !(await unlock())) return;
            setBusy(name);
            setConflict(null);
            try {
                await run();
                await refresh();
                await connection.reload();
            } catch (caught) {
                if (caught instanceof FarmError && caught.kind === 'conflict') setConflict(caught.message);
                else Alert.alert('That did not work', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusy(null);
            }
        },
        [unlocked, unlock, refresh, connection],
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

    const doomscrollNow = useCallback(async () => {
        const plugins = await client.listPlugins();
        // Never hard-code a version: take the envelope the farm advertises.
        const plugin = plugins.find((row) => row.tasks.some((task) => task.type === 'doomscroll'));
        const task = plugin?.tasks.find((row) => row.type === 'doomscroll');
        if (!plugin || !task) throw new FarmError('validation', 'This farm advertises no doomscroll task.');
        await client.createSchedule({
            deviceUdid: udid,
            task: { pluginId: plugin.id, taskType: task.type, taskVersion: task.version, payload: { minutes: 12 } },
            timing: { kind: 'now' },
        });
    }, [client, udid]);

    if (connection.loading && !connection.data) return <Loading label="Checking the device…" />;

    const state = fleetDevice?.state ?? 'offline';
    const tint = deviceStateColor(state, colors);
    const screenSize = remote.data?.screen.screenSize;
    const frame = client.screenshotRef(udid, { nonce });
    const showFrame = foreground && !frameFailed && state !== 'disabled';

    const onTouchStart = (x: number, y: number) => {
        touchStart.current = { x, y, at: Date.now() };
    };
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

    return (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}>
            <Row>
                <StatusDot color={tint} size={10} />
                <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                    {fleetDevice?.name ?? udid}
                </Text>
                <Badge label={state} color={tint} />
            </Row>

            {conflict ? (
                <Card style={{ borderColor: colors.danger }}>
                    <Text style={{ color: colors.danger, fontSize: 13, marginBottom: spacing.sm }}>{conflict}</Text>
                    {fleetDevice?.currentExecution ? (
                        <Button
                            label="Stop the run"
                            variant="danger"
                            onPress={() =>
                                void guard('stop', () => client.stopExecution(fleetDevice.currentExecution!.id))
                            }
                            busy={busy === 'stop'}
                            testID="conflict-stop"
                        />
                    ) : null}
                </Card>
            ) : null}

            <Card>
                <Pressable
                    onLayout={(event: LayoutChangeEvent) =>
                        setViewSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
                    }
                    onPressIn={(event) => onTouchStart(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onPressOut={(event) => onTouchEnd(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    style={{
                        // Phone-shaped, but not so tall that the connection line
                        // and the quick actions fall below the fold.
                        width: '62%',
                        alignSelf: 'center',
                        aspectRatio: 9 / 16,
                        borderRadius: radius.md,
                        overflow: 'hidden',
                        backgroundColor: colors.surfaceRaised,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    testID="device-screenshot"
                >
                    {showFrame ? (
                        <Image
                            source={frame}
                            onError={() => setFrameFailed(true)}
                            resizeMode="contain"
                            style={{ width: '100%', height: '100%' }}
                        />
                    ) : (
                        <Muted>no frame right now</Muted>
                    )}
                    {!unlocked ? (
                        <View
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                right: 0,
                                padding: spacing.sm,
                                backgroundColor: colors.overlay,
                            }}
                        >
                            <Muted>Remote control is locked — taps do nothing.</Muted>
                        </View>
                    ) : null}
                </Pressable>
                <Row style={{ marginTop: spacing.sm }}>
                    <Button
                        label="Refresh"
                        onPress={() => {
                            setFrameFailed(false);
                            setNonce((value) => value + 1);
                        }}
                        testID="device-refresh-frame"
                    />
                    {frameFailed ? <Muted>stale — the device is flapping</Muted> : null}
                </Row>
            </Card>

            <Card>
                <Row>
                    <StatusDot color={connection.data?.physical === 'connected' ? colors.online : colors.offline} />
                    {/* `message` is written to be operator-facing — render it verbatim. */}
                    <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{connection.data?.message ?? '—'}</Text>
                </Row>
                <Muted style={{ marginTop: 4 }}>
                    {connection.data?.wda ?? '—'} · {fleetDevice?.platform ?? 'ios'} · updated{' '}
                    {formatRelative(connection.data?.updatedAt)}
                </Muted>
            </Card>

            <SectionTitle>Now and next</SectionTitle>
            <Card>
                {fleetDevice?.currentExecution ? (
                    <>
                        <Text style={{ color: colors.text, fontWeight: '600' }}>{fleetDevice.currentExecution.summary}</Text>
                        <Muted>started {formatRelative(fleetDevice.currentExecution.startedAt)}</Muted>
                        <Row style={{ marginTop: spacing.sm }}>
                            <Button
                                label="Stop"
                                variant="danger"
                                disabled={!canAct}
                                busy={busy === 'stop'}
                                onPress={() => void guard('stop', () => client.stopExecution(fleetDevice.currentExecution!.id))}
                                testID="device-stop"
                            />
                            <Button
                                label="Logs"
                                onPress={() => router.push(`/execution/${encodeURIComponent(fleetDevice.currentExecution!.id)}` as never)}
                            />
                        </Row>
                    </>
                ) : (
                    <Muted>Nothing running.</Muted>
                )}
                <Muted style={{ marginTop: spacing.sm }}>
                    {fleetDevice?.nextRunAt ? `next ${formatRelative(fleetDevice.nextRunAt)}` : 'nothing scheduled'}
                </Muted>
            </Card>

            <SectionTitle>Quick actions</SectionTitle>
            <Card>
                <Row>
                    <Button
                        label="Doomscroll now"
                        variant="primary"
                        disabled={!canAct}
                        busy={busy === 'doomscroll'}
                        onPress={() => void guard('doomscroll', doomscrollNow)}
                        testID="device-doomscroll"
                        style={{ flex: 1 }}
                    />
                    <Button
                        label="Reconnect"
                        disabled={!canAct}
                        busy={busy === 'reconnect'}
                        onPress={() => void guard('reconnect', () => client.reconnectDevice(udid))}
                        testID="device-reconnect"
                        style={{ flex: 1 }}
                    />
                </Row>
                <Button
                    label={fleetDevice?.state === 'disabled' ? 'Activate device' : 'Disable device'}
                    variant="danger"
                    disabled={!canAct}
                    busy={busy === 'disable'}
                    style={{ marginTop: spacing.sm }}
                    testID="device-disable"
                    onPress={() =>
                        Alert.alert(
                            fleetDevice?.state === 'disabled' ? 'Activate this device?' : 'Disable this device?',
                            'Scheduling and automation stop until it is activated again.',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Confirm',
                                    style: 'destructive',
                                    onPress: () =>
                                        void guard('disable', () =>
                                            client.patchDevice(udid, { disabled: fleetDevice?.state !== 'disabled' }),
                                        ),
                                },
                            ],
                        )
                    }
                />
            </Card>

            <SectionTitle>Remote control</SectionTitle>
            <Card>
                <Row>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 }}>
                        {unlocked ? `Unlocked · ${secondsRemaining}s` : 'Locked'}
                    </Text>
                    <Switch
                        testID="device-safety-toggle"
                        value={unlocked}
                        disabled={!available || !foreground}
                        onValueChange={(next) => {
                            if (next) void unlock();
                            else lock();
                        }}
                        trackColor={{ true: colors.accent, false: colors.border }}
                    />
                </Row>
                <Muted style={{ marginTop: spacing.xs }}>
                    Unlocking asks for Face ID and lasts 2 minutes, or until the app leaves the foreground. The farm still
                    refuses input while a run is active — this lock is on the phone, not on the API.
                </Muted>
                {unlocked ? (
                    <Row style={{ marginTop: spacing.md }}>
                        <Button label="Home" onPress={() => void sendAction({ type: 'home' })} testID="device-home" style={{ flex: 1 }} />
                        {platformOf(fleetDevice ?? {}) === 'android' ? (
                            <Button label="Back" onPress={() => void sendAction({ type: 'back' })} style={{ flex: 1 }} />
                        ) : null}
                    </Row>
                ) : null}
                {screenSize ? (
                    <Muted style={{ marginTop: spacing.sm }}>
                        Screen {screenSize.width}×{screenSize.height} pt — taps map from the image above.
                    </Muted>
                ) : (
                    <Muted style={{ marginTop: spacing.sm }}>No screen geometry — the device is not attached.</Muted>
                )}
            </Card>

            {connection.error ? <ErrorState error={connection.error} onRetry={() => void connection.reload()} testID="device-error" /> : null}
        </ScrollView>
    );
}
