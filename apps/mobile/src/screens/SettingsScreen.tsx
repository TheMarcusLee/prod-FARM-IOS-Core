import { useCallback, useState } from 'react';
import { Alert, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { FarmError, createFarmClient, type EventSeverity } from '@farm/client';
import { Badge, Button, Card, Muted, Row, SectionTitle } from '../components';
import { useFarm } from '../context/FarmContext';
import { useSafety } from '../context/SafetyContext';
import { useSettings } from '../context/SettingsContext';
import { maskToken } from '../lib/storage';
import { registerPushToken, requestExpoPushToken } from '../lib/push';
import { useTheme } from '../theme';

export function SettingsScreen() {
    const { settings, token, update, setToken } = useSettings();
    const { snapshot, client, refresh } = useFarm();
    const { available: biometricsAvailable } = useSafety();
    const { colors, spacing, radius } = useTheme();

    const [tokenDraft, setTokenDraft] = useState('');
    const [replacing, setReplacing] = useState(token === null);
    const [probe, setProbe] = useState<{ label: string; ok: boolean } | null>(null);
    const [testing, setTesting] = useState(false);
    const [pushState, setPushState] = useState<string | null>(null);

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
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: 10,
        color: colors.text,
        fontSize: 14,
    } as const;

    return (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm }}>
            <SectionTitle>Server</SectionTitle>
            <Card>
                <Muted>Tailscale (primary)</Muted>
                <TextInput
                    testID="settings-tailscale-url"
                    value={settings.tailscaleUrl}
                    onChangeText={(value) => update({ tailscaleUrl: value.trim() })}
                    placeholder="http://farm-mac.tailnet-1234.ts.net:3000"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[inputStyle, { marginTop: 4, marginBottom: spacing.sm }]}
                />
                <Muted>LAN (tried first at home, optional)</Muted>
                <TextInput
                    testID="settings-lan-url"
                    value={settings.lanUrl}
                    onChangeText={(value) => update({ lanUrl: value.trim() })}
                    placeholder="http://192.168.1.20:3000"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[inputStyle, { marginTop: 4 }]}
                />
                <Row style={{ marginTop: spacing.md }}>
                    <Button label="Test" onPress={() => void test()} busy={testing} testID="settings-test" />
                    {probe ? (
                        <Text style={{ color: probe.ok ? colors.online : colors.danger, fontSize: 12, flex: 1 }} numberOfLines={2}>
                            {probe.label}
                        </Text>
                    ) : null}
                </Row>
                <Muted style={{ marginTop: spacing.sm }}>
                    The farm is never exposed publicly. Join the Mac and this phone to the same tailnet; the bearer token is a
                    second, independent layer.
                </Muted>
            </Card>

            <SectionTitle>Token</SectionTitle>
            <Card>
                {replacing ? (
                    <>
                        <TextInput
                            testID="settings-token-input"
                            value={tokenDraft}
                            onChangeText={setTokenDraft}
                            placeholder="paste pf_live_…"
                            placeholderTextColor={colors.textFaint}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            style={inputStyle}
                        />
                        <Row style={{ marginTop: spacing.sm }}>
                            <Button label="Save" variant="primary" onPress={() => void saveToken()} testID="settings-token-save" />
                            {token ? <Button label="Cancel" variant="ghost" onPress={() => setReplacing(false)} /> : null}
                        </Row>
                    </>
                ) : (
                    <Row>
                        <Text style={{ color: colors.text, fontFamily: 'Courier', flex: 1 }}>{maskToken(token)}</Text>
                        <Button label="Replace" onPress={() => setReplacing(true)} testID="settings-token-replace" />
                    </Row>
                )}
                <Muted style={{ marginTop: spacing.sm }}>
                    Stored in the keychain, this device only. It is never shown again and never leaves the app except as an
                    Authorization header. Mint one per phone: `npm run token:create -- --name marcus-iphone`.
                </Muted>
                <Row style={{ marginTop: spacing.sm }}>
                    <Muted>Registers as</Muted>
                    <TextInput
                        testID="settings-device-label"
                        value={settings.deviceLabel}
                        onChangeText={(value) => update({ deviceLabel: value })}
                        style={[inputStyle, { flex: 1, paddingVertical: 6 }]}
                    />
                </Row>
            </Card>

            <SectionTitle>Demo</SectionTitle>
            <Card>
                <ToggleRow
                    label="Use demo data"
                    detail="Swaps in an in-memory farm: 12 fake devices, fake runs, fake events that tick. Nothing leaves the phone."
                    value={settings.demoMode}
                    onValueChange={(value) => update({ demoMode: value })}
                    testID="settings-demo-toggle"
                />
            </Card>

            <SectionTitle>Safety</SectionTitle>
            <Card>
                <ToggleRow
                    label="Biometric unlock for remote control"
                    detail={
                        biometricsAvailable
                            ? 'Face ID or fingerprint in front of taps, stops, reconnects and disables. Relocks after 2 minutes or when the app backgrounds. This is a lock on the phone, not on the API — the farm cannot tell the difference.'
                            : 'No biometrics enrolled on this phone, so this gate cannot be enforced here.'
                    }
                    value={settings.biometricLock}
                    onValueChange={(value) => update({ biometricLock: value })}
                    testID="settings-biometric-toggle"
                />
            </Card>

            <SectionTitle>Notifications</SectionTitle>
            <Card>
                <ToggleRow
                    label="Push alerts"
                    detail="Registers this phone with the farm's push relay. Bodies carry a device name and a task name only."
                    value={settings.notifications.enabled}
                    onValueChange={(value) => void enableNotifications(value)}
                    testID="settings-push-toggle"
                />
                <Row style={{ marginTop: spacing.md }}>
                    <Muted>Minimum severity</Muted>
                    <View style={{ flex: 1 }} />
                    {(['info', 'warning', 'error'] as EventSeverity[]).map((option) => (
                        <Text
                            key={option}
                            accessibilityRole="button"
                            onPress={() => update({ notifications: { ...settings.notifications, minSeverity: option } })}
                            style={{
                                color: settings.notifications.minSeverity === option ? colors.accentText : colors.textMuted,
                                backgroundColor: settings.notifications.minSeverity === option ? colors.accent : colors.surfaceRaised,
                                paddingHorizontal: spacing.sm,
                                paddingVertical: 4,
                                borderRadius: radius.pill,
                                overflow: 'hidden',
                                fontSize: 11,
                                fontWeight: '700',
                            }}
                        >
                            {option}
                        </Text>
                    ))}
                </Row>
                {pushState ? <Muted style={{ marginTop: spacing.sm }}>{pushState}</Muted> : null}
                <Muted style={{ marginTop: spacing.sm }}>
                    Kind-by-kind selection lands with the relay; today this registers the four push-worthy kinds.
                </Muted>
            </Card>

            <SectionTitle>About</SectionTitle>
            <Card>
                <Row>
                    <Muted>App</Muted>
                    <View style={{ flex: 1 }} />
                    <Text style={{ color: colors.text, fontSize: 12 }}>{Constants.expoConfig?.version ?? '—'}</Text>
                </Row>
                <Row style={{ marginTop: 4 }}>
                    <Muted>Farm release</Muted>
                    <View style={{ flex: 1 }} />
                    <Text style={{ color: colors.text, fontSize: 12 }}>{snapshot?.releaseSha ?? '—'}</Text>
                </Row>
                {snapshot?.fromMock ? (
                    <Row style={{ marginTop: spacing.sm }}>
                        <Badge label="demo data" color={colors.warning} />
                    </Row>
                ) : null}
                <Button
                    label="Forget token"
                    variant="danger"
                    style={{ marginTop: spacing.md }}
                    onPress={() =>
                        Alert.alert('Forget the token?', 'You will need to paste it again. Revoke it on the Mac too if the phone is lost.', [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Forget',
                                style: 'destructive',
                                onPress: () => {
                                    void setToken(null);
                                    setReplacing(true);
                                },
                            },
                        ])
                    }
                />
            </Card>
        </ScrollView>
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
            <Row>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 }}>{label}</Text>
                <Switch
                    testID={testID}
                    value={value}
                    onValueChange={onValueChange}
                    trackColor={{ true: colors.accent, false: colors.border }}
                />
            </Row>
            <Muted style={{ marginTop: spacing.xs }}>{detail}</Muted>
        </View>
    );
}
