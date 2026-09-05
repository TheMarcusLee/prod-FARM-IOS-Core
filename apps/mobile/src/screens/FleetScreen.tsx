import { useCallback, useMemo, useState } from 'react';
import { FlatList, Image, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { deviceTags, formatRelative, type FleetDevice } from '@farm/client';
import { Badge, Card, EmptyState, ErrorBanner, Loading, Muted, Row, StaleBanner, StatusDot } from '../components';
import { useFarm } from '../context/FarmContext';
import { useForegroundInterval, useIsForeground } from '../hooks';
import { deviceStateColor, useTheme } from '../theme';

const THUMBNAIL_WIDTH = 320;

export function FleetScreen() {
    const { snapshot, initialising, lastError, isStale, refresh, needsSetup, client } = useFarm();
    const { colors, spacing, radius } = useTheme();
    const { width } = useWindowDimensions();
    const [filter, setFilter] = useState<string>('all');
    const [refreshing, setRefreshing] = useState(false);
    // Every 10 s while the tab is in front; paused entirely when it is not.
    const [nonce, setNonce] = useState(0);
    const foreground = useIsForeground();

    useForegroundInterval(() => setNonce((value) => value + 1), 10_000, !isStale);
    // The summary describes state; events describe transitions. Poll both.
    useForegroundInterval(() => void refresh(), 15_000, !needsSetup);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await refresh();
        setNonce((value) => value + 1);
        setRefreshing(false);
    }, [refresh]);

    const devices = snapshot?.fleet.devices ?? [];
    const tags = useMemo(() => deviceTags(devices), [devices]);

    const visible = useMemo(() => {
        if (filter === 'all') return devices;
        if (filter === 'busy' || filter === 'offline' || filter === 'error') {
            return devices.filter((device) => device.state === filter);
        }
        return devices.filter((device) => (device.tags ?? []).includes(filter.replace(/^tag:/, '')));
    }, [devices, filter]);

    if (needsSetup) {
        return (
            <EmptyState
                title="No farm configured"
                detail="Add the Mac's Tailscale URL and a token in Settings, or turn on demo data to look around."
            />
        );
    }
    if (initialising && !snapshot) return <Loading label="Reaching the Mac…" />;

    const counts = snapshot?.fleet.counts;
    const columns = width >= 700 ? 3 : 2;
    const chips: { key: string; label: string }[] = [
        { key: 'all', label: `all ${counts?.total ?? 0}` },
        { key: 'busy', label: `busy ${counts?.busy ?? 0}` },
        { key: 'offline', label: `offline ${counts?.offline ?? 0}` },
        { key: 'error', label: `error ${counts?.error ?? 0}` },
        ...tags.map((tag) => ({ key: `tag:${tag}`, label: tag })),
    ];

    return (
        <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs }}>
                <Row>
                    <StatusDot color={isStale ? colors.warning : colors.online} size={9} />
                    <Text testID="fleet-summary" style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>
                        {counts ? `${counts.online + counts.busy}/${counts.total} up` : '—'}
                    </Text>
                    <Muted>· {formatRelative(snapshot ? new Date(snapshot.fetchedAt).toISOString() : null)}</Muted>
                    {snapshot?.fromMock ? <Badge label="demo data" color={colors.warning} /> : null}
                </Row>
            </View>

            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm, paddingVertical: spacing.sm }}
                style={{ flexGrow: 0 }}
            >
                {chips.map((chip) => {
                    const active = filter === chip.key;
                    return (
                        <Text
                            key={chip.key}
                            accessibilityRole="button"
                            testID={`fleet-filter-${chip.key}`}
                            onPress={() => setFilter(chip.key)}
                            style={{
                                color: active ? colors.accentText : colors.textMuted,
                                backgroundColor: active ? colors.accent : colors.surface,
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
                            {chip.label}
                        </Text>
                    );
                })}
            </ScrollView>

            {isStale && snapshot ? (
                <StaleBanner
                    testID="stale-banner"
                    message={`Last updated ${formatRelative(new Date(snapshot.fetchedAt).toISOString())} — can't reach the Mac`}
                />
            ) : null}
            {lastError && !snapshot ? <ErrorBanner message={lastError.message} onRetry={() => void refresh()} /> : null}

            <FlatList
                key={`cols-${columns}`}
                data={visible}
                numColumns={columns}
                keyExtractor={(device) => device.udid}
                columnWrapperStyle={{ gap: spacing.md }}
                contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                ListEmptyComponent={<EmptyState title="Nothing matches that filter" />}
                renderItem={({ item }) => (
                    <DeviceCard
                        device={item}
                        // Only cards on screen fetch, and only while foregrounded.
                        thumbnailUri={foreground && !isStale ? client.screenshotRef(item.udid, { width: THUMBNAIL_WIDTH, nonce }).uri : null}
                        thumbnailHeaders={client.screenshotRef(item.udid, { width: THUMBNAIL_WIDTH, nonce }).headers}
                    />
                )}
            />
        </View>
    );
}

function DeviceCard({
    device,
    thumbnailUri,
    thumbnailHeaders,
}: {
    device: FleetDevice;
    thumbnailUri: string | null;
    thumbnailHeaders?: Record<string, string>;
}) {
    const { colors, spacing, radius } = useTheme();
    const [failed, setFailed] = useState(false);
    const tint = deviceStateColor(device.state, colors);

    const secondLine =
        device.currentExecution?.summary ??
        (device.state === 'error' ? device.lastError : null) ??
        (device.state === 'offline' ? device.connection.message : null) ??
        (device.nextRunAt ? `next ${formatRelative(device.nextRunAt)}` : 'idle');

    return (
        <Card
            testID={`device-card-${device.udid}`}
            accessibilityLabel={`${device.name}, ${device.state}`}
            style={{ flex: 1 }}
            onPress={() => router.push(`/device/${encodeURIComponent(device.udid)}` as never)}
        >
            <View
                style={{
                    aspectRatio: 9 / 16,
                    borderRadius: radius.md,
                    backgroundColor: colors.surfaceRaised,
                    overflow: 'hidden',
                    marginBottom: spacing.sm,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {thumbnailUri && !failed ? (
                    <Image
                        // A 503 is "no frame right now" — keep the placeholder,
                        // do not shout about it on a 12-card grid.
                        source={{ uri: thumbnailUri, headers: thumbnailHeaders }}
                        onError={() => setFailed(true)}
                        resizeMode="cover"
                        style={{ width: '100%', height: '100%' }}
                    />
                ) : (
                    <Muted>no frame</Muted>
                )}
            </View>
            <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>
                {device.name}
            </Text>
            <Row gap={6} style={{ marginTop: 2 }}>
                <StatusDot color={tint} />
                <Text style={{ color: tint, fontSize: 11, fontWeight: '700' }}>{device.state}</Text>
                {device.platform === 'android' ? <Muted>· android</Muted> : <Muted>· ios</Muted>}
            </Row>
            <Muted numberOfLines={2} style={{ marginTop: 4 }}>
                {secondLine}
            </Muted>
        </Card>
    );
}
