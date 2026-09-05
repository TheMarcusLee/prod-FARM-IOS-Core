/**
 * Everything the operator configures, and the only place the token is read.
 *
 * The token is kept in state for the lifetime of the process because the HTTP
 * client needs it synchronously on every request; it is loaded from the
 * keychain once at start and never written to AsyncStorage or logged.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EventKind, EventSeverity } from '@farm/client';
import { StorageKeys, readJson, readToken, writeJson, writeToken } from '../lib/storage';

export interface NotificationPreferences {
    enabled: boolean;
    minSeverity: EventSeverity;
    /** `null` means every kind at or above `minSeverity`. */
    kinds: EventKind[] | null;
}

export interface PersistedSettings {
    /** The MagicDNS name. Primary. */
    tailscaleUrl: string;
    /** Optional LAN address, tried first when it answers fast (plan §3). */
    lanUrl: string;
    demoMode: boolean;
    biometricLock: boolean;
    /** Name this phone registers under, so one lost phone is one revocation. */
    deviceLabel: string;
    notifications: NotificationPreferences;
}

const DEFAULTS: PersistedSettings = {
    tailscaleUrl: '',
    lanUrl: '',
    // Demo by default: a fresh install has no token and no Mac to talk to, and
    // an empty grid is a worse first screen than fake data clearly labelled.
    demoMode: true,
    biometricLock: true,
    deviceLabel: 'this-phone',
    notifications: {
        enabled: false,
        minSeverity: 'warning',
        kinds: ['execution.failed', 'device.disconnected', 'device.error', 'execution.stuck'],
    },
};

interface SettingsValue {
    settings: PersistedSettings;
    token: string | null;
    loaded: boolean;
    update: (patch: Partial<PersistedSettings>) => void;
    setToken: (token: string | null) => Promise<void>;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<PersistedSettings>(DEFAULTS);
    const [token, setTokenState] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [stored, storedToken] = await Promise.all([readJson<PersistedSettings>(StorageKeys.settings), readToken()]);
            if (cancelled) return;
            if (stored) {
                setSettings({ ...DEFAULTS, ...stored, notifications: { ...DEFAULTS.notifications, ...stored.notifications } });
            }
            setTokenState(storedToken);
            setLoaded(true);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const update = useCallback((patch: Partial<PersistedSettings>) => {
        setSettings((previous) => {
            const next = { ...previous, ...patch };
            void writeJson(StorageKeys.settings, next);
            return next;
        });
    }, []);

    const setToken = useCallback(async (next: string | null) => {
        const trimmed = next?.trim() ?? null;
        await writeToken(trimmed && trimmed.length > 0 ? trimmed : null);
        setTokenState(trimmed && trimmed.length > 0 ? trimmed : null);
    }, []);

    const value = useMemo<SettingsValue>(
        () => ({ settings, token, loaded, update, setToken }),
        [settings, token, loaded, update, setToken],
    );

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
    const value = useContext(SettingsContext);
    if (!value) throw new Error('useSettings must be used inside SettingsProvider');
    return value;
}

export { DEFAULTS as DEFAULT_SETTINGS };
