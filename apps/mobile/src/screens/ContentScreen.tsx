import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Image, RefreshControl, Text, View } from 'react-native';
import { FarmError, formatRelative, type ContentQueueItem } from '@farm/client';
import { Badge, Button, Card, EmptyState, ErrorBanner, Loading, Muted, Row } from '../components';
import { useFarm } from '../context/FarmContext';
import { useAsync } from '../hooks';
import { useTheme } from '../theme';

export function ContentScreen() {
    const { client, snapshot, canAct, needsSetup } = useFarm();
    const { colors, spacing, radius } = useTheme();
    const [overrides, setOverrides] = useState<Record<string, ContentQueueItem>>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const queue = useAsync(async () => (needsSetup ? { items: [] } : client.listContentQueue()), [client, needsSetup]);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, device.name);
        return map;
    }, [snapshot]);

    const items = useMemo(() => {
        const merged = (queue.data?.items ?? []).map((item) => overrides[item.id] ?? item);
        // Up next first: planned items, soonest slot at the top.
        return merged
            .filter((item) => item.status === 'planned' || item.status === 'approved')
            .sort((a, b) => (a.plannedFor ?? '').localeCompare(b.plannedFor ?? ''));
    }, [queue.data, overrides]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        setOverrides({});
        await queue.reload();
        setRefreshing(false);
    }, [queue]);

    /**
     * Optimistic, with rollback: the operator is often approving five in a row
     * on a train, and waiting for a round trip each time is the wrong feel.
     */
    const decide = useCallback(
        async (item: ContentQueueItem, decision: 'approve' | 'skip') => {
            const optimistic: ContentQueueItem = { ...item, status: decision === 'approve' ? 'approved' : 'skipped' };
            setOverrides((previous) => ({ ...previous, [item.id]: optimistic }));
            setBusyId(item.id);
            try {
                const confirmed =
                    decision === 'approve' ? await client.approveContentItem(item.id) : await client.skipContentItem(item.id);
                setOverrides((previous) => ({ ...previous, [item.id]: confirmed }));
            } catch (caught) {
                setOverrides((previous) => {
                    const next = { ...previous };
                    delete next[item.id];
                    return next;
                });
                Alert.alert('That did not stick', caught instanceof FarmError ? caught.message : String(caught));
            } finally {
                setBusyId(null);
            }
        },
        [client],
    );

    if (needsSetup) return <EmptyState title="No farm configured" detail="Add a server URL and token in Settings." />;
    if (snapshot?.capabilities.drip === false) {
        return <EmptyState title="No drip queue" detail="This farm does not advertise the content queue yet." />;
    }
    if (queue.loading && !queue.data) return <Loading label="Loading the queue…" />;

    return (
        <View style={{ flex: 1 }}>
            {queue.error ? <ErrorBanner message={queue.error.message} onRetry={() => void queue.reload()} /> : null}
            <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                ListEmptyComponent={<EmptyState title="Nothing waiting" detail="No planned posts in the drip queue." />}
                renderItem={({ item }) => {
                    const thumbnail = client.assetThumbnailRef(item.assetId);
                    return (
                        <Card testID={`content-${item.id}`}>
                            <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
                                <View
                                    style={{
                                        width: 64,
                                        height: 96,
                                        borderRadius: radius.sm,
                                        overflow: 'hidden',
                                        backgroundColor: colors.surfaceRaised,
                                    }}
                                >
                                    <Image source={thumbnail} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
                                </View>
                                <View style={{ flex: 1, gap: 4 }}>
                                    <Text numberOfLines={3} style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>
                                        {item.caption}
                                    </Text>
                                    <Muted>
                                        {names.get(item.deviceUdid) ?? item.deviceUdid} ·{' '}
                                        {item.plannedFor ? formatRelative(item.plannedFor) : 'unscheduled'}
                                    </Muted>
                                    {item.status !== 'planned' ? <Badge label={item.status} color={colors.online} /> : null}
                                </View>
                            </Row>
                            {item.status === 'planned' ? (
                                <Row style={{ marginTop: spacing.md }}>
                                    <Button
                                        label="Skip"
                                        variant="ghost"
                                        disabled={!canAct}
                                        busy={busyId === item.id}
                                        onPress={() => void decide(item, 'skip')}
                                        testID={`content-skip-${item.id}`}
                                        style={{ flex: 1 }}
                                    />
                                    <Button
                                        label="Approve"
                                        variant="primary"
                                        disabled={!canAct}
                                        busy={busyId === item.id}
                                        onPress={() => void decide(item, 'approve')}
                                        testID={`content-approve-${item.id}`}
                                        style={{ flex: 1 }}
                                    />
                                </Row>
                            ) : null}
                        </Card>
                    );
                }}
            />
        </View>
    );
}
