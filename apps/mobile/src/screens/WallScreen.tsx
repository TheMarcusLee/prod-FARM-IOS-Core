/**
 * The wall: every phone's screen, live, numbered, selectable.
 *
 * It is the home view because it answers "what is happening" without reading
 * anything — twelve pictures and twelve dots. Long-press starts a selection and
 * the bottom bar acts on it in bulk; a tap opens the one device.
 *
 * Frames refresh at 0.5 fps, only for tiles that are actually on screen, and
 * only while the app is in front. Twelve JPEG-sized thumbnails a second would
 * be the single most expensive thing this app does.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, Pressable, RefreshControl, Text, View, type ViewToken } from 'react-native';
import { router } from 'expo-router';
import {
    FarmError,
    deviceDisplayName,
    deviceNumber,
    formatRelative,
    isPostTask,
    wallState,
    wallSummary,
    type FleetDevice,
    type PluginDescriptor,
    type ScheduleTiming,
    type TaskEnvelope,
    type WallState,
} from '@farm/client';
import {
    Badge,
    Button,
    Chip,
    EmptyState,
    ErrorState,
    IconButton,
    Loading,
    NumberChip,
    Row,
    ScreenHeader,
    StaleBanner,
    StatusDot,
} from '../components';
import { Icon } from '../icons';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { useForegroundInterval, useIsForeground } from '../hooks';
import { useTheme, wallStateColor } from '../theme';

/** The tile's screen area is 250 pt tall; ask for a frame about that wide. */
const THUMBNAIL_WIDTH = 320;
/** 0.5 fps. Fast enough to see a post move, slow enough to be free. */
const FRAME_INTERVAL_MS = 2_000;

type Filter = 'all' | 'posting' | 'needs-you' | 'offline';

const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'posting', label: 'Posting' },
    { key: 'needs-you', label: 'Needs you' },
    { key: 'offline', label: 'Offline' },
];

function matches(filter: Filter, state: WallState): boolean {
    switch (filter) {
        case 'all':
            return true;
        case 'posting':
            return state === 'posting';
        case 'needs-you':
            return state === 'error';
        case 'offline':
            return state === 'offline' || state === 'disabled';
    }
}

export function WallScreen() {
    const { snapshot, initialising, lastError, isStale, refresh, needsSetup, canAct, client } = useFarm();
    const { unlocked, unlock } = useSafety();
    const { colors, spacing } = useTheme();
    const foreground = useIsForeground();

    const [filter, setFilter] = useState<Filter>('all');
    const [refreshing, setRefreshing] = useState(false);
    const [nonce, setNonce] = useState(0);
    const [selected, setSelected] = useState<string[]>([]);
    const [selecting, setSelecting] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [visible, setVisible] = useState<string[]>([]);

    // `onViewableItemsChanged` must be the same function for the life of the
    // list — FlatList throws on a changed callback — so it lives in a ref.
    const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
        setVisible(viewableItems.map((token) => String(token.key)));
    });
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 20 });

    useForegroundInterval(() => setNonce((value) => value + 1), FRAME_INTERVAL_MS, !isStale && !needsSetup);
    // The snapshot describes state; refreshing it is what moves the dots.
    useForegroundInterval(() => void refresh(), 15_000, !needsSetup);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await refresh();
        setNonce((value) => value + 1);
        setRefreshing(false);
    }, [refresh]);

    const devices = useMemo(() => snapshot?.fleet.devices ?? [], [snapshot]);
    const numbers = useMemo(() => {
        const map = new Map<string, string>();
        devices.forEach((device, index) => map.set(device.udid, deviceNumber(index)));
        return map;
    }, [devices]);

    const summary = useMemo(() => wallSummary(devices), [devices]);
    const shown = useMemo(() => devices.filter((device) => matches(filter, wallState(device))), [devices, filter]);

    const toggle = useCallback((udid: string) => {
        setSelected((previous) =>
            previous.includes(udid) ? previous.filter((row) => row !== udid) : [...previous, udid],
        );
    }, []);

    const beginSelection = useCallback(
        (udid: string) => {
            setSelecting(true);
            toggle(udid);
        },
        [toggle],
    );

    const open = useCallback((udid: string) => {
        router.push(`/device/${encodeURIComponent(udid)}` as never);
    }, []);

    const clearSelection = useCallback(() => {
        setSelecting(false);
        setSelected([]);
    }, []);

    /** Every bulk action is one call through the client, behind the same gate. */
    const runBulk = useCallback(
        async (name: string, run: (udids: string[]) => Promise<string>) => {
            if (selected.length === 0) return;
            if (!unlocked && !(await unlock())) return;
            setBusy(name);
            try {
                const message = await run(selected);
                clearSelection();
                await refresh();
                Alert.alert('Done', message);
            } catch (caught) {
                Alert.alert('The farm said no', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusy(null);
            }
        },
        [selected, unlocked, unlock, clearSelection, refresh],
    );

    const bulkTask = useCallback(
        async (kind: 'post' | 'warmup'): Promise<TaskEnvelope> => {
            const plugins: PluginDescriptor[] = await client.listPlugins();
            for (const plugin of plugins) {
                const task = plugin.tasks.find((row) => (kind === 'post' ? isPostTask(row.type) : row.type === 'warmup'));
                if (task) return { pluginId: plugin.id, taskType: task.type, taskVersion: task.version, payload: {} };
            }
            throw new FarmError('validation', `This farm advertises no ${kind === 'post' ? 'post' : 'warm-up'} task.`);
        },
        [client],
    );

    const schedulePost = useCallback(
        () =>
            runBulk('post', async (udids) => {
                const timing: ScheduleTiming = { kind: 'now' };
                const result = await client.createSchedulesBulk({ deviceUdids: udids, task: await bulkTask('post'), timing });
                return `${result.created} scheduled, ${result.failed} refused.`;
            }),
        [runBulk, client, bulkTask],
    );

    const warmUp = useCallback(
        () =>
            runBulk('warmup', async (udids) => {
                const timing: ScheduleTiming = { kind: 'now' };
                const result = await client.createSchedulesBulk({ deviceUdids: udids, task: await bulkTask('warmup'), timing });
                return `${result.created} warming up, ${result.failed} refused.`;
            }),
        [runBulk, client, bulkTask],
    );

    const reconnect = useCallback(
        () =>
            runBulk('reconnect', async (udids) => {
                // There is no bulk reconnect on the wire; this is the same call
                // the device screen makes, once per selected phone.
                const results = await Promise.allSettled(udids.map((udid) => client.reconnectDevice(udid)));
                const ok = results.filter((row) => row.status === 'fulfilled').length;
                return `${ok} of ${udids.length} reconnected.`;
            }),
        [runBulk, client],
    );

    const pause = useCallback(
        () =>
            runBulk('pause', async (udids) => {
                const page = await client.listSchedules({ limit: 200 });
                const targets = page.schedules.filter((row) => udids.includes(row.deviceUdid) && row.status === 'active');
                const results = await Promise.allSettled(targets.map((row) => client.setScheduleStatus(row.id, 'pause')));
                const ok = results.filter((row) => row.status === 'fulfilled').length;
                return targets.length === 0 ? 'Nothing was running on those phones.' : `${ok} schedules paused.`;
            }),
        [runBulk, client],
    );

    const renderItem = useCallback(
        ({ item }: { item: FleetDevice }) => (
            <DeviceTile
                device={item}
                number={numbers.get(item.udid) ?? '—'}
                selecting={selecting}
                selected={selected.includes(item.udid)}
                // Only tiles on screen fetch, and only while foregrounded.
                nonce={foreground && !isStale && visible.includes(item.udid) ? nonce : null}
                onPress={selecting ? toggle : open}
                onLongPress={beginSelection}
                imageFor={client.screenshotRef}
            />
        ),
        [numbers, selecting, selected, foreground, isStale, visible, nonce, toggle, open, beginSelection, client],
    );

    if (needsSetup) {
        return (
            <View style={{ flex: 1 }}>
                <ScreenHeader title="Wall" />
                <EmptyState
                    title="No farm configured"
                    detail="Add the Mac's Tailscale URL and a token under Rig, or turn on demo data to look around."
                    actionLabel="Open Rig"
                    onAction={() => router.push('/rig' as never)}
                />
            </View>
        );
    }
    if (initialising && !snapshot) return <Loading label="Reaching the Mac…" />;

    return (
        <View style={{ flex: 1 }}>
            <ScreenHeader
                title="Wall"
                subtitle={
                    <Row gap={0}>
                        <Text testID="wall-summary" style={{ color: colors.text3, fontSize: 12.5 }}>
                            {`${summary.live} of ${summary.total} live`}
                            {summary.posting > 0 ? ` · ${summary.posting} posting` : ''}
                        </Text>
                        {summary.needsYou > 0 ? (
                            <Text style={{ color: colors.bad, fontSize: 12.5, fontWeight: '600' }}>
                                {` · ${summary.needsYou} needs you`}
                            </Text>
                        ) : null}
                    </Row>
                }
                right={
                    <IconButton
                        icon={selecting ? 'x' : 'check'}
                        testID="wall-select-toggle"
                        accessibilityLabel={selecting ? 'Stop selecting phones' : 'Select phones'}
                        onPress={() => (selecting ? clearSelection() : setSelecting(true))}
                    />
                }
            />

            <Row
                gap={spacing.xs2}
                style={{ paddingHorizontal: spacing.lg2, paddingTop: spacing.xs, paddingBottom: spacing.md }}
            >
                {FILTERS.map((option) => (
                    <Chip
                        key={option.key}
                        label={option.label}
                        active={filter === option.key}
                        testID={`wall-filter-${option.key}`}
                        onPress={() => setFilter(option.key)}
                    />
                ))}
                <View style={{ flex: 1 }} />
                {snapshot?.fromMock ? <Badge label="demo data" color={colors.warn} /> : null}
            </Row>

            {isStale && snapshot ? (
                <StaleBanner
                    testID="stale-banner"
                    message={`Last updated ${formatRelative(new Date(snapshot.fetchedAt).toISOString())} — can't reach the Mac`}
                />
            ) : null}
            {lastError && !snapshot ? <ErrorState error={lastError} onRetry={() => void refresh()} testID="wall-error" /> : null}

            <FlatList
                testID="wall-grid"
                data={shown}
                numColumns={2}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                columnWrapperStyle={{ gap: spacing.md }}
                contentContainerStyle={{ paddingHorizontal: spacing.lg2, gap: spacing.md, paddingBottom: spacing.xxl }}
                onViewableItemsChanged={onViewable.current}
                viewabilityConfig={viewabilityConfig.current}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                ListEmptyComponent={
                    <EmptyState title="Nothing matches that filter" detail="Tap All to see every phone again." />
                }
            />

            {selecting && selected.length > 0 ? (
                <SelectionBar
                    count={selected.length}
                    busy={busy}
                    disabled={!canAct}
                    onSchedulePost={() => void schedulePost()}
                    onWarmUp={() => void warmUp()}
                    onReconnect={() => void reconnect()}
                    onPause={() => void pause()}
                    onClear={clearSelection}
                />
            ) : null}
        </View>
    );
}

function keyExtractor(device: FleetDevice): string {
    return device.udid;
}

/* ------------------------------------------------------------------- tile */

interface TileProps {
    device: FleetDevice;
    number: string;
    selecting: boolean;
    selected: boolean;
    /** `null` means "do not fetch a frame" — off screen, stale, backgrounded. */
    nonce: number | null;
    onPress: (udid: string) => void;
    onLongPress: (udid: string) => void;
    imageFor: (udid: string, options: { width: number; nonce: number }) => { uri: string; headers?: Record<string, string> };
}

/**
 * Panel, 1.5px line, 14px radius, 8px padding; screen area 250 tall at 10px
 * radius; footer = number · name · state dot. Failed is a bad border; offline
 * or no frame is a panel-2 screen with one line of text saying so.
 */
const DeviceTile = memo(function DeviceTile({
    device,
    number,
    selecting,
    selected,
    nonce,
    onPress,
    onLongPress,
    imageFor,
}: TileProps) {
    const { colors, radius, spacing } = useTheme();
    const [frameFailed, setFrameFailed] = useState(false);
    const state = wallState(device);
    const tint = wallStateColor(state, colors);
    const name = deviceDisplayName(device.name);
    const dimmed = state === 'offline' || state === 'disabled';
    const frame = nonce !== null && !dimmed && !frameFailed ? imageFor(device.udid, { width: THUMBNAIL_WIDTH, nonce }) : null;

    const border = selected ? colors.accent : state === 'error' ? colors.bad : colors.line;

    return (
        <Pressable
            testID={`device-tile-${device.udid}`}
            accessibilityRole="button"
            accessibilityLabel={`${number} ${name}, ${state === 'error' ? 'needs you' : state}`}
            accessibilityState={{ selected }}
            accessibilityHint={selecting ? 'Adds or removes this phone from the selection' : 'Opens this phone'}
            onPress={() => onPress(device.udid)}
            onLongPress={() => onLongPress(device.udid)}
            delayLongPress={350}
            style={({ pressed }) => ({
                flex: 1,
                gap: spacing.sm,
                padding: spacing.sm,
                borderRadius: radius.tile,
                backgroundColor: colors.panel,
                borderWidth: 1.5,
                borderColor: border,
                opacity: state === 'disabled' ? 0.4 : pressed ? 0.85 : 1,
            })}
        >
            <View
                style={{
                    height: 250,
                    borderRadius: radius.lg,
                    backgroundColor: colors.panel2,
                    overflow: 'hidden',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {frame ? (
                    <Image
                        source={frame}
                        // A 503 is "no frame right now" — keep the placeholder,
                        // do not shout about it twelve times over.
                        onError={() => setFrameFailed(true)}
                        resizeMode="cover"
                        style={{ width: '100%', height: '100%' }}
                    />
                ) : (
                    <Text style={{ color: colors.text4, fontSize: 12 }}>
                        {dimmed ? (state === 'disabled' ? 'disabled' : 'not on the bus') : 'no frame'}
                    </Text>
                )}
            </View>
            <Row gap={spacing.xs2} style={{ paddingHorizontal: 2, paddingBottom: 2 }}>
                {selecting ? <Checkbox checked={selected} /> : null}
                <NumberChip number={number} dimmed={dimmed} />
                <Text numberOfLines={1} style={{ color: colors.text, fontSize: 12.5, fontWeight: '600', flexShrink: 1 }}>
                    {name}
                </Text>
                <View style={{ flex: 1 }} />
                <StatusDot color={tint} />
            </Row>
        </Pressable>
    );
});

function Checkbox({ checked }: { checked: boolean }) {
    const { colors } = useTheme();
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                borderWidth: 1.5,
                borderColor: checked ? colors.accent : colors.lineStrong,
                backgroundColor: checked ? colors.accent : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            {checked ? <Icon name="check" size={10} color="#ffffff" strokeWidth={2.4} /> : null}
        </View>
    );
}

/* --------------------------------------------------------- selection bar */

function SelectionBar({
    count,
    busy,
    disabled,
    onSchedulePost,
    onWarmUp,
    onReconnect,
    onPause,
    onClear,
}: {
    count: number;
    busy: string | null;
    disabled: boolean;
    onSchedulePost: () => void;
    onWarmUp: () => void;
    onReconnect: () => void;
    onPause: () => void;
    onClear: () => void;
}) {
    const { colors, spacing } = useTheme();
    return (
        <View
            testID="wall-selection-bar"
            accessibilityLabel={`${count} phones selected`}
            style={{
                borderTopWidth: 1,
                borderTopColor: colors.line,
                backgroundColor: colors.panel,
                paddingHorizontal: spacing.md2,
                paddingTop: spacing.sm2,
                paddingBottom: spacing.sm2,
                gap: spacing.sm,
            }}
        >
            <Row>
                <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600', flex: 1 }}>
                    {count === 1 ? '1 phone selected' : `${count} phones selected`}
                </Text>
                <Button label="Clear" variant="ghost" compact onPress={onClear} testID="wall-selection-clear" />
            </Row>
            <Row gap={spacing.xs2}>
                <Button
                    label="Schedule post"
                    variant="primary"
                    style={{ flex: 1 }}
                    disabled={disabled}
                    busy={busy === 'post'}
                    onPress={onSchedulePost}
                    testID="wall-bulk-post"
                />
                <Button
                    label="Warm up"
                    style={{ flex: 1 }}
                    disabled={disabled}
                    busy={busy === 'warmup'}
                    onPress={onWarmUp}
                    testID="wall-bulk-warmup"
                />
            </Row>
            <Row gap={spacing.xs2}>
                <Button
                    label="Reconnect"
                    style={{ flex: 1 }}
                    disabled={disabled}
                    busy={busy === 'reconnect'}
                    onPress={onReconnect}
                    testID="wall-bulk-reconnect"
                />
                <Button
                    label="Pause"
                    style={{ flex: 1 }}
                    disabled={disabled}
                    busy={busy === 'pause'}
                    onPress={onPause}
                    testID="wall-bulk-pause"
                />
            </Row>
        </View>
    );
}
