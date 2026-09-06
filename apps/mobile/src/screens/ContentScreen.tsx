/**
 * Content: what is in the library, and what is waiting on a decision.
 *
 * Approve and skip are optimistic with rollback — the operator is often
 * approving five in a row on a train, and a round trip per tap is the wrong
 * feel. If the farm refuses, the row goes back to what it was and says so.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { FarmError, formatRelative, uploadFileFromBlob, type ContentQueueItem } from '@farm/client';
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

interface UploadState {
    name: string;
    /** 0…1 while sending, and null once the farm is assembling the file. */
    fraction: number | null;
    error?: string;
}

export function ContentScreen() {
    const { client, snapshot, canAct, needsSetup } = useFarm();
    const { colors, spacing, radius } = useTheme();
    const [overrides, setOverrides] = useState<Record<string, ContentQueueItem>>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [upload, setUpload] = useState<UploadState | null>(null);
    const aborter = useRef<AbortController | null>(null);

    const queue = useAsync(async () => (needsSetup ? { items: [] } : client.listContentQueue()), [client, needsSetup]);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        // The full name, slot suffix and all: these rows carry no number chip,
        // so stripping it would throw away the only slot the operator can see.
        for (const device of snapshot?.fleet.devices ?? []) map.set(device.udid, device.name);
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

    /**
     * Pick one clip and send it up in chunks. The picker hands back a `uri`, so
     * the bytes come from `fetch(uri)` — which in React Native is a local read,
     * not a network call — and go out through the resumable protocol, because a
     * phone on cell data will drop part way through a 400 MB clip.
     */
    const addClip = useCallback(async () => {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            Alert.alert('No access to the library', 'Allow photo access for Backline in Settings, then try again.');
            return;
        }
        const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['videos', 'images'],
            quality: 1,
            allowsMultipleSelection: false,
        });
        const asset = picked.canceled ? null : picked.assets[0];
        if (!asset) return;

        const name = asset.fileName ?? (asset.type === 'video' ? 'clip.mp4' : 'photo.jpg');
        const controller = new AbortController();
        aborter.current = controller;
        setUpload({ name, fraction: 0 });
        try {
            const blob = await (await fetch(asset.uri)).blob();
            await client.uploadAsset(uploadFileFromBlob(blob, name, asset.mimeType ?? blob.type), {
                signal: controller.signal,
                onProgress: ({ fraction }) => setUpload({ name, fraction }),
            });
            setUpload({ name, fraction: null });
            await queue.reload();
            setUpload(null);
        } catch (caught) {
            // An abort is the operator's own decision, not a failure to report.
            if (caught instanceof FarmError && caught.kind === 'aborted') setUpload(null);
            else setUpload({ name, fraction: null, error: caught instanceof FarmError ? caught.message : String(caught) });
        } finally {
            aborter.current = null;
        }
    }, [client, queue]);

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
                right={
                    <Button
                        label="Add clip"
                        variant="primary"
                        compact
                        icon="upload"
                        disabled={!canAct || upload !== null}
                        onPress={() => void addClip()}
                        testID="content-add"
                    />
                }
            />

            {upload ? (
                <View style={{ paddingHorizontal: spacing.lg2, paddingBottom: spacing.sm }}>
                    <Panel testID="content-upload">
                        <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                            {upload.name}
                        </Text>
                        <Muted testID="content-upload-status">
                            {upload.error
                                ? upload.error
                                : upload.fraction === null
                                  ? 'Finishing up…'
                                  : `Uploading · ${Math.round(upload.fraction * 100)}%`}
                        </Muted>
                        <View
                            style={{
                                height: 4, borderRadius: 999, backgroundColor: colors.line,
                                overflow: 'hidden', marginTop: spacing.sm,
                            }}
                        >
                            <View
                                style={{
                                    height: '100%',
                                    width: `${Math.round((upload.fraction ?? 1) * 100)}%`,
                                    backgroundColor: upload.error ? colors.bad : colors.accent,
                                }}
                            />
                        </View>
                        <Row gap={spacing.sm} style={{ marginTop: spacing.sm }}>
                            <Button
                                label={upload.error ? 'Dismiss' : 'Cancel'}
                                style={{ flex: 1 }}
                                onPress={() => {
                                    aborter.current?.abort();
                                    setUpload(null);
                                }}
                                testID="content-upload-cancel"
                            />
                        </Row>
                    </Panel>
                </View>
            ) : null}

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
