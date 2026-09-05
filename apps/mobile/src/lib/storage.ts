/**
 * Two stores, deliberately separate.
 *
 * The bearer token goes to `expo-secure-store` — Keychain with
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is never synced to iCloud and never
 * restored onto a different phone from a backup. Everything else — server URLs,
 * preferences, the last fleet snapshot — is AsyncStorage, which is plain disk.
 * Nothing sensitive crosses that line.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'farm.bearerToken';

export async function readToken(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(TOKEN_KEY, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    } catch {
        // A locked keychain or an unsupported simulator: behave as "no token".
        return null;
    }
}

export async function writeToken(token: string | null): Promise<void> {
    if (token === null) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        return;
    }
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}

/** `pf_live_9f3c…802e` — what Settings shows instead of the value. */
export function maskToken(token: string | null): string {
    if (!token) return 'not set';
    if (token.length <= 12) return `…${token.slice(-4)}`;
    return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/* ------------------------------------------------------- plain preferences */

export async function readJson<T>(key: string): Promise<T | null> {
    try {
        const raw = await AsyncStorage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
        return null;
    }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
    try {
        await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {
        // A full disk is not worth crashing a fleet view over.
    }
}

export async function removeKey(key: string): Promise<void> {
    try {
        await AsyncStorage.removeItem(key);
    } catch {
        // Ignore.
    }
}

export const StorageKeys = {
    settings: 'farm.settings.v1',
    snapshot: 'farm.snapshot.v1',
    lastEventId: 'farm.lastRenderedEventId.v1',
} as const;
