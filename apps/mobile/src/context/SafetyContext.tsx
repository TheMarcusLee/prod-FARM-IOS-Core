/**
 * The biometric gate in front of anything that touches a phone.
 *
 * This is a **client-side** lock. The API cannot tell a Face ID-verified
 * request from any other, and the farm's own `409` guard is the real one. This
 * exists to stop someone holding the unlocked phone — nothing more. Do not
 * describe it as more than that in the UI.
 *
 * The unlock lasts 2 minutes or until the app leaves the foreground, whichever
 * is first.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useSettings } from './SettingsContext';

const UNLOCK_WINDOW_MS = 120_000;

interface SafetyValue {
    unlocked: boolean;
    /** Seconds left on the current unlock, for the countdown in the UI. */
    secondsRemaining: number;
    /** No enrolled biometrics: the toggle explains itself instead of failing. */
    available: boolean;
    unlock: () => Promise<boolean>;
    lock: () => void;
}

const SafetyContext = createContext<SafetyValue | null>(null);

export function SafetyProvider({ children }: { children: ReactNode }) {
    const { settings } = useSettings();
    const [unlockedAt, setUnlockedAt] = useState<number | null>(null);
    const [available, setAvailable] = useState(false);
    const [now, setNow] = useState(Date.now());
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        void (async () => {
            const [hasHardware, enrolled] = await Promise.all([
                LocalAuthentication.hasHardwareAsync(),
                LocalAuthentication.isEnrolledAsync(),
            ]);
            setAvailable(hasHardware && enrolled);
        })();
    }, []);

    // Backgrounding relocks immediately — the whole point of the gate.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state !== 'active') setUnlockedAt(null);
        });
        return () => subscription.remove();
    }, []);

    useEffect(() => {
        if (unlockedAt === null) {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
            return;
        }
        timer.current = setInterval(() => setNow(Date.now()), 1_000);
        return () => {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
        };
    }, [unlockedAt]);

    const expired = unlockedAt !== null && now - unlockedAt > UNLOCK_WINDOW_MS;
    const unlocked = unlockedAt !== null && !expired;

    const unlock = useCallback(async () => {
        // With the gate turned off in Settings there is nothing to prompt for.
        if (!settings.biometricLock) {
            setUnlockedAt(Date.now());
            setNow(Date.now());
            return true;
        }
        if (!available) return false;
        const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Unlock remote control',
            cancelLabel: 'Cancel',
            disableDeviceFallback: false,
        });
        if (!result.success) return false;
        setUnlockedAt(Date.now());
        setNow(Date.now());
        return true;
    }, [available, settings.biometricLock]);

    const lock = useCallback(() => setUnlockedAt(null), []);

    const value = useMemo<SafetyValue>(
        () => ({
            unlocked,
            secondsRemaining: unlocked && unlockedAt ? Math.max(0, Math.ceil((UNLOCK_WINDOW_MS - (now - unlockedAt)) / 1000)) : 0,
            available: available || !settings.biometricLock,
            unlock,
            lock,
        }),
        [unlocked, unlockedAt, now, available, settings.biometricLock, unlock, lock],
    );

    return <SafetyContext.Provider value={value}>{children}</SafetyContext.Provider>;
}

export function useSafety(): SafetyValue {
    const value = useContext(SafetyContext);
    if (!value) throw new Error('useSafety must be used inside SafetyProvider');
    return value;
}
