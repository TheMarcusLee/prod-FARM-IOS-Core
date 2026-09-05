import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { formatDuration, formatRelative } from '@farm/client';
import { Badge, Card, ErrorBanner, Loading, Muted, Row, SectionTitle } from '../components';
import { useFarm } from '../context/FarmContext';
import { useAsync } from '../hooks';
import { executionStatusColor, useTheme } from '../theme';

/** Logs are a flat array across attempts; show the tail and cap what we hold. */
const TAIL_LINES = 50;

export function ExecutionScreen({ id }: { id: string }) {
    const { client, snapshot } = useFarm();
    const { colors, spacing, radius } = useTheme();
    const execution = useAsync(() => client.getExecution(id), [client, id]);

    const deviceName = useMemo(() => {
        const udid = execution.data?.deviceUdid;
        return snapshot?.fleet.devices.find((device) => device.udid === udid)?.name ?? udid ?? '';
    }, [execution.data, snapshot]);

    if (execution.loading && !execution.data) return <Loading />;
    if (execution.error) return <ErrorBanner message={execution.error.message} onRetry={() => void execution.reload()} />;
    if (!execution.data) return null;

    const row = execution.data;
    const started = row.startedAt ? Date.parse(row.startedAt) : null;
    const finished = row.finishedAt ? Date.parse(row.finishedAt) : Date.now();
    const tail = row.logs.slice(-TAIL_LINES);

    return (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }}>
            <Row>
                <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', flex: 1 }}>
                    {row.taskType} · {deviceName}
                </Text>
                <Badge label={row.status} color={executionStatusColor(row.status, colors)} />
            </Row>

            <Card>
                <Muted>
                    scheduled {formatRelative(row.scheduledFor)} · started {formatRelative(row.startedAt)} ·{' '}
                    {started ? formatDuration(finished - started) : '—'}
                </Muted>
                <Muted style={{ marginTop: 4 }}>
                    {row.pluginId} v{row.taskVersion}
                    {row.exitCode === null ? '' : ` · exit ${row.exitCode}`}
                </Muted>
                {row.error ? (
                    <Text style={{ color: colors.danger, fontSize: 13, marginTop: spacing.sm }}>{row.error}</Text>
                ) : null}
            </Card>

            <SectionTitle>Log tail ({tail.length} of {row.logs.length})</SectionTitle>
            <View
                style={{
                    backgroundColor: colors.surfaceRaised,
                    borderRadius: radius.md,
                    padding: spacing.md,
                    borderColor: colors.border,
                    borderWidth: 1,
                }}
            >
                {tail.map((line, index) => (
                    <Text
                        key={`${index}-${line.slice(0, 12)}`}
                        style={{ color: line.startsWith('[error]') ? colors.danger : colors.textMuted, fontSize: 11, fontFamily: 'Courier' }}
                    >
                        {line}
                    </Text>
                ))}
            </View>
        </ScrollView>
    );
}
