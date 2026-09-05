/**
 * Content: what is in the library, and what is waiting on a decision.
 *
 * Approve and skip are optimistic with rollback — the operator is often
 * approving five in a row on a train, and a round trip per tap is the wrong
 * feel. If the farm refuses, the row goes back to what it was and says so.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Image, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { FarmError, deviceDisplayName, formatRelative, type ContentQueueItem } from '@farm/client';
import {
    Badge,
    Button,
    EmptyState,
    ErrorState,
    Loading,
    Muted,
    Panel,
    Row,
    ScreenHeader,
    SectionTitle,
} from '../components';
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
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, deviceDisplayName(device.name));
        return map;
    }, [snapshot]);

    const all = useMemo(
        () => (queue.data?.items ?? []).map((item) => overrides[item.id] ?? item),
        [queue.data, overrides],
    );

    const waiting = useMemo(
        () =>
            all
                .filter((item) => item.status === 'planned' || item.status === 'approved')
                // Up next first: soonest slot at the top.
                .sort((a, b) => (a.plannedFor ?? '').localeCompare(b.plannedFor ?? '')),
        [all],
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        setOverrides({});
        await queue.reload();
        setRefreshing(false);
    }, [queue]);

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

    if (needsSetup) {
        return (
            <View style={{ flex: 1 }}>
                <ScreenHeader title="Content" />
                <EmptyState
                    title="No farm configured"
                    detail="Add a server URL and token under Rig."
                    actionLabel="Open Rig"
                    onAction={() => router.push('/rig' as never)}
                />
            </View>
        );
    }
    if (snapshot?.capabilities.contentQueue === false) {
        return (
            <View style={{ flex: 1 }}>
                <ScreenHeader title="Content" />
                <EmptyState title="No drip queue" detail="This farm does not advertise the content queue yet." />
            </View>
        );
    }
    if (queue.loading && !queue.data) return <Loading label="Loading the queue…" />;

    return (
        <View style={{ flex: 1 }}>
            <ScreenHeader
                title="Content"
                subtitle={
                    <Muted testID="content-summary">
                        {`${all.length} in the library · ${waiting.filter((item) => item.status === 'planned').length} waiting on you`}
                    </Muted>
                }
            />

            {queue.error ? <ErrorState error={queue.error} onRetry={() => void queue.reload()} testID="content-error" /> : null}

            <FlatList
                testID="content-queue"
                data={waiting}
                keyExtractor={contentKey}
                contentContainerStyle={{ paddingBottom: spacing.xxl, gap: spacing.sm }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
                ListHeaderComponent={
                    <View style={{ paddingHorizontal: spacing.lg2 }}>
                        <SectionTitle>Library</SectionTitle>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                            {all.length === 0 ? (
                                <Muted>Nothing has been uploaded yet.</Muted>
                            ) : (
                                all.map((item) => (
                                    <View
                                        key={item.id}
                                        accessibilityLabel={`${item.caption}, ${item.status}`}
                                        testID={`content-thumb-${item.id}`}
                                        style={{
                                            width: 68,
                                            height: 102,
                                            borderRadius: radius.lg,
                                            overflow: 'hidden',
                                            backgroundColor: colors.panel2,
                                            borderWidth: 1,
                                            borderColor: colors.line,
                                            opacity: item.status === 'skipped' ? 0.4 : 1,
                                        }}
                                    >
                                        <Image
                                            source={client.assetThumbnailRef(item.assetId)}
                                            resizeMode="cover"
                                            style={{ width: '100%', height: '100%' }}
                                        />
                                    </View>
                                ))
                            )}
                        </View>
                        <SectionTitle>Up next</SectionTitle>
                    </View>
                }
                ListEmptyComponent={
                    <EmptyState title="Nothing waiting" detail="No planned posts in the drip queue." />
                }
                renderItem={({ item }) => (
                    <View style={{ paddingHorizontal: spacing.lg2 }}>
                        <Panel testID={`content-${item.id}`}>
                            <Row gap={spacing.md} style={{ alignItems: 'flex-start' }}>
                                <View
                                    style={{
                                        width: 64,
                                        height: 96,
                                        borderRadius: radius.md,
                                        overflow: 'hidden',
                                        backgroundColor: colors.panel2,
                                    }}
                                >
                                    <Image
                                        source={client.assetThumbnailRef(item.assetId)}
                                        resizeMode="cover"
                                        style={{ width: '100%', height: '100%' }}
                                    />
                                </View>
                                <View style={{ flex: 1, gap: 4 }}>
                                    <Text numberOfLines={3} style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>
                                        {item.caption}
                                    </Text>
                                    <Muted>
                                        {names.get(item.deviceUdid) ?? item.deviceUdid} ·{' '}
                                        {item.plannedFor ? formatRelative(item.plannedFor) : 'unscheduled'}
                                    </Muted>
                                    {item.status !== 'planned' ? <Badge label={item.status} color={colors.ok} /> : null}
                                </View>
                            </Row>
                            {item.status === 'planned' ? (
                                <Row gap={spacing.sm} style={{ marginTop: spacing.md }}>
                                    <Button
                                        label="Skip"
                                        style={{ flex: 1 }}
                                        disabled={!canAct}
                                        busy={busyId === item.id}
                                        onPress={() => void decide(item, 'skip')}
                                        testID={`content-skip-${item.id}`}
                                    />
                                    <Button
                                        label="Approve"
                                        variant="primary"
                                        style={{ flex: 1 }}
                                        disabled={!canAct}
                                        busy={busyId === item.id}
                                        onPress={() => void decide(item, 'approve')}
                                        testID={`content-approve-${item.id}`}
                                    />
                                </Row>
                            ) : null}
                        </Panel>
                    </View>
                )}
            />
        </View>
    );
}

function contentKey(item: ContentQueueItem): string {
    return item.id;
}
