import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { FarmError } from '@farm/client';

/**
 * `AppState.currentState` is `null` before the first event and `'unknown'` on
 * Android in some states, so foreground is defined by exclusion. Only
 * `background` and `inactive` stop the polling and the stream.
 */
export function isForegroundState(state: AppStateStatus | null): boolean {
    return state !== 'background' && state !== 'inactive';
}

export interface AsyncState<T> {
    data: T | null;
    error: FarmError | null;
    loading: boolean;
    reload: () => Promise<void>;
}

/** One fetch, one reload, and no state written after unmount. */
export function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<FarmError | null>(null);
    const [loading, setLoading] = useState(true);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const result = await run();
            if (alive.current) {
                setData(result);
                setError(null);
            }
        } catch (caught) {
            if (alive.current) setError(caught instanceof FarmError ? caught : new FarmError('unknown', String(caught)));
        } finally {
            if (alive.current) setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { data, error, loading, reload };
}

/** A poll that pauses when the app is not in front — battery, and honesty. */
export function useForegroundInterval(callback: () => void, intervalMs: number, enabled = true): void {
    const saved = useRef(callback);
    saved.current = callback;

    useEffect(() => {
        if (!enabled || intervalMs <= 0) return;
        let timer: ReturnType<typeof setInterval> | null = null;

        const start = () => {
            if (timer) return;
            timer = setInterval(() => saved.current(), intervalMs);
        };
        const stop = () => {
            if (timer) clearInterval(timer);
            timer = null;
        };

        if (isForegroundState(AppState.currentState)) start();
        const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (isForegroundState(state)) start();
            else stop();
        });
        return () => {
            subscription.remove();
            stop();
        };
    }, [intervalMs, enabled]);
}

export function useIsForeground(): boolean {
    const [foreground, setForeground] = useState(isForegroundState(AppState.currentState));
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => setForeground(isForegroundState(state)));
        return () => subscription.remove();
    }, []);
    return foreground;
}
