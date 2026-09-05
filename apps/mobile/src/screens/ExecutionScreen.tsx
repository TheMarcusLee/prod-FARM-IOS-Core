/**
 * One run: what it was, what happened, and the tail of its log.
 *
 * Kept as a detail view rather than a list screen — the inspector rows are
 * fixed and the log tail is capped, so there is nothing here that grows.
 */
import { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import {
    clipLabel,
    deviceDisplayName,
    formatDuration,
    formatRelative,
    type ExecutionDetail,
} from '@farm/client';
import { Badge, ErrorState, InspectorRow, Loading, LogBlock, Muted, Panel, Row, SectionTitle } from '../components';
import { useFarm } from '../context/FarmContext';
import { useAsync } from '../hooks';
import { executionStatusColor, useTheme } from '../theme';

/** Logs are a flat array across attempts; show the tail and cap what we hold. */
const TAIL_LINES = 50;

export function ExecutionScreen({ id }: { id: string }) {
    const { client, snapshot } = useFarm();
    const { colors, spacing } = useTheme();
    const execution = useAsync(() => client.getExecution(id), [client, id]);

    const deviceName = useMemo(() => {
        const udid = execution.data?.deviceUdid;
        const device = snapshot?.fleet.devices.find((row) => row.udid === udid);
        return device ? deviceDisplayName(device.name) : (udid ?? '');
    }, [execution.data, snapshot]);

    const lines = useMemo(() => tailOf(execution.data), [execution.data]);

    if (execution.loading && !execution.data) return <Loading />;
    if (execution.error) {
        return <ErrorState error={execution.error} onRetry={() => void execution.reload()} testID="execution-error" />;
    }
    if (!execution.data) return null;

    const row = execution.data;
    const started = row.startedAt ? Date.parse(row.startedAt) : null;
    const finished = row.finishedAt ? Date.parse(row.finishedAt) : Date.now();

    return (
        <ScrollView contentContainerStyle={{ padding: spacing.lg2, gap: spacing.sm, paddingBottom: spacing.xxl }}>
            <Row gap={spacing.sm}>
                <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                    {clipLabel(row.taskType)} · {deviceName}
                </Text>
                <Badge label={row.status} color={executionStatusColor(row.status, colors)} />
            </Row>

            <Panel>
                <InspectorRow label="Scheduled" value={formatRelative(row.scheduledFor)} />
                <InspectorRow label="Started" value={formatRelative(row.startedAt)} />
                <InspectorRow label="Took" value={started ? formatDuration(finished - started) : '—'} />
                <InspectorRow label="Plugin" value={`${row.pluginId} v${row.taskVersion}`} />
                {row.exitCode === null ? null : <InspectorRow label="Exit code" value={String(row.exitCode)} />}
            </Panel>

            {row.error ? (
                <Panel borderColor={colors.badLine} style={{ backgroundColor: colors.badSoft }}>
                    <Text style={{ color: colors.bad, fontSize: 13.5, fontWeight: '600' }}>What went wrong</Text>
                    <Text style={{ color: colors.text2, fontSize: 12.5, marginTop: 4 }}>{row.error}</Text>
                </Panel>
            ) : null}

            <SectionTitle>
                Log tail ({lines.length} of {row.logs.length})
            </SectionTitle>
            <LogBlock lines={lines} testID="execution-log" />
            {row.logs.length === 0 ? <Muted>The farm kept no log for this run.</Muted> : null}
        </ScrollView>
    );
}

/**
 * `[2026-09-05T18:31:02.004Z] driver session opened` and `[wda] feed reached`
 * are both shapes the farm emits. Split the leading bracket into the timestamp
 * column when it parses as a time, and leave it alone when it does not.
 */
function tailOf(detail: ExecutionDetail | null): { at: string; text: string; current?: boolean; error?: boolean }[] {
    const logs = detail?.logs ?? [];
    const tail = logs.slice(-TAIL_LINES);
    return tail.map((line, index) => {
        const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
        const stamp = match?.[1] ?? '';
        const parsed = Date.parse(stamp);
        const at = Number.isNaN(parsed) ? '' : new Date(parsed).toTimeString().slice(0, 8);
        return {
            at: at || (match ? stamp : ''),
            text: match ? (match[2] ?? '') : line,
            current: index === tail.length - 1 && detail?.status === 'running',
            error: line.startsWith('[error]'),
        };
    });
}
