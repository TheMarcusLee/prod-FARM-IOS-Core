/**
 * Rig: the machine that runs this, and the settings that point at it.
 *
 * The service rows are in plain words, like the desktop app's — "The worker ·
 * two runs going, one waiting", not `worker: RUNNING pid 41221`. Everything the
 * operator can change lives below them, because Settings is not a tab any more.
 *
 * A ScrollView rather than a FlatList on purpose: this is a bounded form, not a
 * list that grows with the farm.
 */
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import {
    FarmError,
    createFarmClient,
    type EventSeverity,
    type FleetSummary,
    type HealthResponse,
} from '@farm/client';
import {
    Badge,
    Button,
    Chip,
    InspectorRow,
    Muted,
    Panel,
    Row,
    ScreenHeader,
    SectionTitle,
    Segmented,
    StatusDot,
} from '../components';
import { useAlerts } from '../context/AlertsContext';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { useSettings, type ThemePreference } from '../context/SettingsContext';
import { useAsync } from '../hooks';
import { maskToken } from '../lib/storage';
import { registerPushToken, requestExpoPushToken } from '../lib/push';
import { useTheme } from '../theme';

export function RigScreen() {
    const { settings, token, update, setToken } = useSettings();
    const { snapshot, client, refresh, needsSetup } = useFarm();
    const { streamStatus } = useAlerts();
    const { available: biometricsAvailable } = useSafety();
    const { colors, spacing, radius } = useTheme();

    const [tokenDraft, setTokenDraft] = useState('');
    const [replacing, setReplacing] = useState(token === null);
    const [probe, setProbe] = useState<{ label: string; ok: boolean } | null>(null);
    const [testing, setTesting] = useState(false);
    const [pushState, setPushState] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const services = useAsync(async (): Promise<{ health: HealthResponse | null; summary: FleetSummary | null }> => {
        if (needsSetup) return { health: null, summary: null };
        const [health, summary] = await Promise.allSettled([client.health(), client.getFleetSummary()]);
        return {
            health: health.status === 'fulfilled' ? health.value : null,
            summary: summary.status === 'fulfilled' ? summary.value : null,
        };
    }, [client, needsSetup]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([refresh(), services.reload()]);
        setRefreshing(false);
    }, [refresh, services]);

    /** `/health` is the cheap reachability check — it does not touch USB. */
    const test = useCallback(async () => {
        const baseUrl = settings.tailscaleUrl || settings.lanUrl;
        if (!baseUrl) {
            setProbe({ label: 'No server URL set', ok: false });
            return;
        }
        setTesting(true);
        const started = Date.now();
        try {
            const probeClient = createFarmClient({ baseUrl, token, timeoutMs: 5_000 });
            const health = await probeClient.health();
            setProbe({
                label: `${Date.now() - started} ms · ${health.release?.sha ?? 'no release marker'}`,
                ok: health.ok !== false,
            });
        } catch (caught) {
            setProbe({ label: caught instanceof FarmError ? caught.message : String(caught), ok: false });
        } finally {
            setTesting(false);
        }
    }, [settings.tailscaleUrl, settings.lanUrl, token]);

    const saveToken = useCallback(async () => {
        await setToken(tokenDraft);
        setTokenDraft('');
        setReplacing(false);
        await refresh();
    }, [setToken, tokenDraft, refresh]);

    const enableNotifications = useCallback(
        async (enabled: boolean) => {
            update({ notifications: { ...settings.notifications, enabled } });
            if (!enabled) return;
            const { token: pushToken, reason } = await requestExpoPushToken();
            if (!pushToken) {
                setPushState(reason ?? 'No push token.');
                return;
            }
            try {
                await registerPushToken(client, {
                    expoPushToken: pushToken,
                    name: settings.deviceLabel,
                    minSeverity: settings.notifications.minSeverity,
                    kinds: settings.notifications.kinds,
                });
                setPushState(`Registered as ${settings.deviceLabel}.`);
            } catch (caught) {
                setPushState(caught instanceof FarmError ? caught.message : String(caught));
            }
        },
        [client, settings.deviceLabel, settings.notifications, update],
    );

    const inputStyle = {
        backgroundColor: colors.panel2,
        borderColor: colors.line,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        height: 44,
        color: colors.text,
        fontSize: 13.5,
    } as const;

    const summary = services.data?.summary ?? null;
    const health = services.data?.health ?? null;
    const counts = snapshot?.fleet.counts;
    const reachable = health?.ok !== false && health !== null;

    return (
        <ScrollView
            testID="rig-scroll"
            contentContainerStyle={{ paddingBottom: spacing.xxl }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        >
            <ScreenHeader
                title="Rig"
                subtitle={
                    <Row gap={spacing.xs2}>
                        <StatusDot color={needsSetup ? colors.text4 : reachable ? colors.ok : colors.bad} size={7} />
                        <Muted testID="rig-status">
                            {needsSetup
                                ? 'Not pointed at a farm yet'
                                : reachable
                                  ? 'The Mac is answering'
                                  : "The Mac is not answering"}
                        </Muted>
                    </Row>
                }
            />

            <View style={{ paddingHorizontal: spacing.lg2 }}>
                <SectionTitle>Services</SectionTitle>
                <Panel testID="rig-services">
                    <ServiceRow
                        label="The web API"
                        detail={
                            needsSetup
                                ? 'No server URL set.'
                                : reachable
                                  ? 'Answering on the tailnet.'
                                  : 'Not answering — check that the Mac is awake and on the tailnet.'
                        }
                        ok={reachable}
                        unknown={needsSetup}
                    />
                    <ServiceRow
                        label="The worker"
                        detail={
                            summary
                                ? `${plural(summary.running, 'run')} going, ${plural(summary.queued, 'run')} waiting${
                                      summary.stuck > 0 ? `, ${plural(summary.stuck, 'run')} stuck` : ''
                                  }.`
                                : 'No answer from the scheduler yet.'
                        }
                        ok={Boolean(summary) && (summary?.stuck ?? 0) === 0}
                        unknown={!summary}
                    />
                    <ServiceRow
                        label="The event log"
                        detail={
                            streamStatus === 'open'
                                ? 'Streaming to this phone.'
                                : streamStatus === 'reconnecting'
                                  ? 'Reconnecting.'
                                  : 'Not streaming — the app is not subscribed right now.'
                        }
                        ok={streamStatus === 'open'}
                        unknown={streamStatus === 'idle'}
                    />
                    <ServiceRow
                        label="The phones"
                        detail={
                            counts
                                ? `${counts.online + counts.busy} of ${counts.total} up${
                                      counts.error > 0 ? `, ${plural(counts.error, 'phone')} needing you` : ''
                                  }.`
                                : 'No fleet snapshot yet.'
                        }
                        ok={Boolean(counts) && (counts?.error ?? 0) === 0}
                        unknown={!counts}
                    />
                </Panel>

                <Panel style={{ marginTop: spacing.sm2 }}>
                    <InspectorRow label="Plugins" value={pluginLine(health)} />
                    <InspectorRow label="Backline release" value={snapshot?.releaseSha ?? health?.release?.sha ?? '—'} />
                    <InspectorRow label="Runs last 24h" value={summary ? `${summary.succeededLast24h} ok · ${summary.failedLast24h} failed` : '—'} />
                    <InspectorRow label="Planned next 24h" value={summary ? String(summary.plannedNext24h) : '—'} />
                    <InspectorRow label="App" value={Constants.expoConfig?.version ?? '—'} />
                </Panel>

                <SectionTitle>Server</SectionTitle>
                <Panel>
                    <Muted>Tailscale (primary)</Muted>
                    <TextInput
                        testID="settings-tailscale-url"
                        accessibilityLabel="Tailscale server URL"
                        value={settings.tailscaleUrl}
                        onChangeText={(value) => update({ tailscaleUrl: value.trim() })}
                        placeholder="http://farm-mac.tailnet-1234.ts.net:3000"
                        placeholderTextColor={colors.text4}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        style={[inputStyle, { marginTop: 4, marginBottom: spacing.sm }]}
                    />
                    <Muted>LAN (tried first at home, optional)</Muted>
                    <TextInput
                        testID="settings-lan-url"
                        accessibilityLabel="LAN server URL"
                        value={settings.lanUrl}
                        onChangeText={(value) => update({ lanUrl: value.trim() })}
                        placeholder="http://192.168.1.20:3000"
                        placeholderTextColor={colors.text4}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        style={[inputStyle, { marginTop: 4 }]}
                    />
                    <Row gap={spacing.sm} style={{ marginTop: spacing.md }}>
                        <Button label="Test" onPress={() => void test()} busy={testing} testID="settings-test" />
                        {probe ? (
                            <Text style={{ color: probe.ok ? colors.ok : colors.bad, fontSize: 12.5, flex: 1 }} numberOfLines={2}>
                                {probe.label}
                            </Text>
                        ) : null}
                    </Row>
                    <Muted style={{ marginTop: spacing.sm }}>
                        The farm is never exposed publicly. Join the Mac and this phone to the same tailnet; the bearer token
                        is a second, independent layer.
                    </Muted>
                </Panel>

                <SectionTitle>Token</SectionTitle>
                <Panel>
                    {replacing ? (
                        <>
                            <TextInput
                                testID="settings-token-input"
                                accessibilityLabel="Bearer token"
                                value={tokenDraft}
                                onChangeText={setTokenDraft}
                                placeholder="paste pf_…"
                                placeholderTextColor={colors.text4}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                style={inputStyle}
                            />
                            <Row gap={spacing.sm} style={{ marginTop: spacing.sm }}>
                                <Button label="Save" variant="primary" onPress={() => void saveToken()} testID="settings-token-save" />
                                {token ? <Button label="Cancel" variant="ghost" onPress={() => setReplacing(false)} /> : null}
                            </Row>
                        </>
                    ) : (
                        <Row gap={spacing.sm}>
                            <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{maskToken(token)}</Text>
                            <Button label="Replace" onPress={() => setReplacing(true)} testID="settings-token-replace" />
                        </Row>
                    )}
                    <Muted style={{ marginTop: spacing.sm }}>
                        Stored in the keychain, this device only. It never leaves the app except as an Authorization header.
                        Mint one per phone: npm run token:create -- --name marcus-iphone
                    </Muted>
                    <Row gap={spacing.sm} style={{ marginTop: spacing.sm }}>
                        <Muted>Registers as</Muted>
                        <TextInput
                            testID="settings-device-label"
                            accessibilityLabel="This phone's name"
                            value={settings.deviceLabel}
                            onChangeText={(value) => update({ deviceLabel: value })}
                            style={[inputStyle, { flex: 1 }]}
                        />
                    </Row>
                </Panel>

                <SectionTitle>Demo</SectionTitle>
                <Panel>
                    <ToggleRow
                        label="Use demo data"
                        detail="Swaps in an in-memory farm: 12 fake phones, fake runs, fake events that tick. Nothing leaves this phone."
                        value={settings.demoMode}
                        onValueChange={(value) => update({ demoMode: value })}
                        testID="settings-demo-toggle"
                    />
                    {snapshot?.fromMock ? (
                        <Row style={{ marginTop: spacing.sm }}>
                            <Badge label="demo data" color={colors.warn} />
                        </Row>
                    ) : null}
                </Panel>

                <SectionTitle>Safety</SectionTitle>
                <Panel>
                    <ToggleRow
                        label="Biometric unlock for remote control"
                        detail={
                            biometricsAvailable
                                ? 'Face ID or a fingerprint in front of taps, stops, reconnects and disables. Relocks after two minutes or when the app goes to the background. This lock is on the phone, not on the API — the farm cannot tell the difference.'
                                : 'No biometrics enrolled on this phone, so this gate cannot be enforced here.'
                        }
                        value={settings.biometricLock}
                        onValueChange={(value) => update({ biometricLock: value })}
                        testID="settings-biometric-toggle"
                    />
                </Panel>

                <SectionTitle>Notifications</SectionTitle>
                <Panel>
                    <ToggleRow
                        label="Push alerts"
                        detail="Registers this phone with the farm's push relay. Bodies carry a phone name and a task name only."
                        value={settings.notifications.enabled}
                        onValueChange={(value) => void enableNotifications(value)}
                        testID="settings-push-toggle"
                    />
                    <Row gap={spacing.xs2} style={{ marginTop: spacing.md, flexWrap: 'wrap' }}>
                        <Muted>Minimum severity</Muted>
                        <View style={{ flex: 1 }} />
                        {(['info', 'warning', 'error'] as EventSeverity[]).map((option) => (
                            <Chip
                                key={option}
                                label={option}
                                active={settings.notifications.minSeverity === option}
                                testID={`settings-severity-${option}`}
                                accessibilityLabel={`Minimum severity: ${option}`}
                                onPress={() => update({ notifications: { ...settings.notifications, minSeverity: option } })}
                            />
                        ))}
                    </Row>
                    {pushState ? <Muted style={{ marginTop: spacing.sm }}>{pushState}</Muted> : null}
                </Panel>

                <SectionTitle>Appearance</SectionTitle>
                <Panel>
                    <Segmented<ThemePreference>
                        testIDPrefix="settings-theme"
                        value={settings.theme}
                        onChange={(value) => update({ theme: value })}
                        options={[
                            { key: 'system', label: 'System' },
                            { key: 'light', label: 'Light' },
                            { key: 'dark', label: 'Dark' },
                        ]}
                    />
                    <Muted style={{ marginTop: spacing.sm }}>
                        Light is the design's primary appearance. System follows the phone.
                    </Muted>
                </Panel>

                <Button
                    label="Forget token"
                    variant="danger"
                    style={{ marginTop: spacing.lg }}
                    testID="settings-forget-token"
                    onPress={() =>
                        Alert.alert(
                            'Forget the token?',
                            'You will need to paste it again. Revoke it on the Mac too if this phone is lost.',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Forget',
                                    style: 'destructive',
                                    onPress: () => {
                                        void setToken(null);
                                        setReplacing(true);
                                    },
                                },
                            ],
                        )
                    }
                />
            </View>
        </ScrollView>
    );
}

/* ------------------------------------------------------------- fragments */

function ServiceRow({ label, detail, ok, unknown }: { label: string; detail: string; ok: boolean; unknown: boolean }) {
    const { colors, spacing } = useTheme();
    return (
        <Row
            gap={spacing.sm2}
            style={{ alignItems: 'flex-start', paddingVertical: spacing.xs2 }}
            // One label for the screen reader: the dot is not a word.
        >
            <View style={{ paddingTop: 5 }}>
                <StatusDot color={unknown ? colors.text4 : ok ? colors.ok : colors.bad} />
            </View>
            <View style={{ flex: 1 }} accessibilityLabel={`${label}. ${detail}`}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>{label}</Text>
                <Muted>{detail}</Muted>
            </View>
        </Row>
    );
}

function ToggleRow({
    label,
    detail,
    value,
    onValueChange,
    testID,
}: {
    label: string;
    detail: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    testID?: string;
}) {
    const { colors, spacing } = useTheme();
    return (
        <View>
            <Row gap={spacing.md}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600', flex: 1 }}>{label}</Text>
                <Switch
                    testID={testID}
                    accessibilityLabel={label}
                    value={value}
                    onValueChange={onValueChange}
                    trackColor={{ true: colors.accent, false: colors.lineStrong }}
                />
            </Row>
            <Muted style={{ marginTop: spacing.xs }}>{detail}</Muted>
        </View>
    );
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function pluginLine(health: HealthResponse | null): string {
    const plugins = health?.plugins ?? [];
    if (plugins.length === 0) return '—';
    return plugins.map((plugin) => `${plugin.id.split('.').pop()} ${plugin.version}`).join(', ');
}
