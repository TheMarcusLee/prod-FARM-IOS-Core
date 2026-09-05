/**
 * Picks the client — the real one or `createMockFarm()` — runs the single
 * cold-start `/api/mobile/bootstrap` call, and owns the offline snapshot.
 *
 * "Cache what was last seen; never fabricate." The snapshot is written on every
 * successful refresh and read once at launch; when a refresh fails and we have
 * a snapshot, the screens render it behind the stale banner and disable every
 * action control.
 */
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
} from 'react';
import {
    FarmError,
    createFarmClient,
    createMockFarm,
    type Bootstrap,
    type Capabilities,
    type FarmClient,
    type FleetView,
    type MockFarm,
} from '@farm/client';
import { registerPushToken, requestExpoPushToken, resetPushRegistration } from '../lib/push';
import { StorageKeys, readJson, writeJson } from '../lib/storage';
import { useSettings } from './SettingsContext';

export interface Snapshot {
    /** `bootstrap().fleet` — counts plus the derived per-device badges. */
    fleet: FleetView;
    /** When the farm generated it, so the stale banner does not lie. */
    generatedAt: string;
    capabilities: Capabilities;
    unacknowledgedCount: number;
    releaseSha?: string;
    /** When this app last got a straight answer from the Mac. */
    fetchedAt: number;
    /** So a demo snapshot is never shown as if it were the real farm. */
    fromMock: boolean;
}

interface FarmValue {
    client: FarmClient;
    /** True while nothing has ever loaded. */
    initialising: boolean;
    snapshot: Snapshot | null;
    /** Non-null when the last refresh failed. */
    lastError: FarmError | null;
    /** The snapshot is older than the refresh interval and the last try failed. */
    isStale: boolean;
    /** Reads are cached; writes must be disabled while we cannot reach the Mac. */
    canAct: boolean;
    unacknowledgedCount: number;
    setUnacknowledgedCount: Dispatch<SetStateAction<number>>;
    refresh: () => Promise<void>;
    /** Settings has nothing to talk to yet. */
    needsSetup: boolean;
}

const FarmContext = createContext<FarmValue | null>(null);

/**
 * A hard ceiling on what goes to AsyncStorage. A farm is a dozen phones, but the
 * snapshot must not be able to grow without bound on disk if one day it is not.
 */
const MAX_SNAPSHOT_DEVICES = 100;

export function FarmProvider({ children }: { children: ReactNode }) {
    const { settings, token, loaded } = useSettings();
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [lastError, setLastError] = useState<FarmError | null>(null);
    const [initialising, setInitialising] = useState(true);
    const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);
    const mockRef = useRef<MockFarm | null>(null);

    const baseUrl = settings.tailscaleUrl || settings.lanUrl;
    const needsSetup = !settings.demoMode && (!baseUrl || !token);

    const client = useMemo<FarmClient>(() => {
        if (settings.demoMode) {
            mockRef.current?.dispose();
            // A little latency so the loading and pull-to-refresh states are
            // real in demo mode rather than instantaneous and untested.
            mockRef.current = createMockFarm({ tickMs: 5_000, latencyMs: 180 });
            return mockRef.current;
        }
        mockRef.current?.dispose();
        mockRef.current = null;
        return createFarmClient({ baseUrl, token, timeoutMs: 15_000 });
    }, [settings.demoMode, baseUrl, token]);

    useEffect(() => () => mockRef.current?.dispose(), []);

    /**
     * Re-register on every launch and whenever the client, the label or the
     * preferences change — an Expo token is not permanent, and a phone whose
     * token rotated silently stops getting alerts otherwise. The farm upserts
     * on the token, so this is safe to call as often as it fires; `push.ts`
     * skips the call when nothing actually changed.
     */
    useEffect(() => {
        resetPushRegistration();
    }, [client]);

    useEffect(() => {
        if (!loaded || needsSetup || !settings.notifications.enabled || client.isMock) return;
        let cancelled = false;
        void (async () => {
            const { token: pushToken } = await requestExpoPushToken();
            if (!pushToken || cancelled) return;
            try {
                await registerPushToken(client, {
                    expoPushToken: pushToken,
                    name: settings.deviceLabel,
                    minSeverity: settings.notifications.minSeverity,
                    kinds: settings.notifications.kinds,
                });
            } catch {
                // Not worth a screen: the next launch tries again, and Settings
                // reports the failure when the operator asks for it there.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, loaded, needsSetup, settings.deviceLabel, settings.notifications]);

    // Last snapshot from disk, so the first frame after a cold start on the
    // train is the fleet as it was, not a spinner.
    useEffect(() => {
        void (async () => {
            const cached = await readJson<Snapshot>(StorageKeys.snapshot);
            if (cached) {
                setSnapshot(cached);
                setUnacknowledgedCount(cached.unacknowledgedCount);
            }
        })();
    }, []);

    const refresh = useCallback(async () => {
        if (needsSetup) {
            setInitialising(false);
            return;
        }
        try {
            // Every refresh is the same one round trip. `/api/fleet/summary`
            // deliberately is *not* used here: it answers with counters only —
            // no device list and no derived badge — so it cannot back this
            // screen. See `summarizeFleet()` in `src/fleet/summary.ts`.
            const boot: Bootstrap = await client.bootstrap();
            const next: Snapshot = {
                fleet: { counts: boot.fleet.counts, devices: boot.fleet.devices.slice(0, MAX_SNAPSHOT_DEVICES) },
                generatedAt: boot.serverTime,
                capabilities: boot.capabilities ?? {},
                unacknowledgedCount: boot.unacknowledgedCount ?? 0,
                releaseSha: boot.release?.sha ?? undefined,
                fetchedAt: Date.now(),
                fromMock: client.isMock,
            };
            setSnapshot(next);
            setUnacknowledgedCount(next.unacknowledgedCount);
            setLastError(null);
            void writeJson(StorageKeys.snapshot, next);
        } catch (error) {
            // Keep whatever we had; the banner explains it is old.
            setLastError(error instanceof FarmError ? error : new FarmError('unknown', String(error)));
        } finally {
            setInitialising(false);
        }
    }, [client, needsSetup]);

    // A client swap (demo toggle, new URL, replaced token) restarts the cycle.
    useEffect(() => {
        setLastError(null);
        setInitialising(true);
        if (loaded) void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, loaded]);

    const isStale = lastError !== null && snapshot !== null;
    const canAct = !isStale && !needsSetup && snapshot !== null;

    const value = useMemo<FarmValue>(
        () => ({
            client,
            initialising,
            snapshot,
            lastError,
            isStale,
            canAct,
            unacknowledgedCount,
            setUnacknowledgedCount,
            refresh,
            needsSetup,
        }),
        [client, initialising, snapshot, lastError, isStale, canAct, unacknowledgedCount, refresh, needsSetup],
    );

    return <FarmContext.Provider value={value}>{children}</FarmContext.Provider>;
}

export function useFarm(): FarmValue {
    const value = useContext(FarmContext);
    if (!value) throw new Error('useFarm must be used inside FarmProvider');
    return value;
}
