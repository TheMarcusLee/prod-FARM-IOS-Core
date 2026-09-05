/**
 * The events list and the SSE connection.
 *
 * Foregrounded → one stream. Backgrounded → nothing: both platforms suspend
 * sockets within seconds, and push is the background transport. On return we
 * reconnect with the last id the app *rendered*, which is what gets persisted.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { FarmError, type FarmEvent, type SseStatus } from '@farm/client';
import { isForegroundState } from '../hooks';
import { StorageKeys, readJson, writeJson } from '../lib/storage';
import { useFarm } from './FarmContext';

const MAX_HELD = 200;

interface AlertsValue {
    events: FarmEvent[];
    loading: boolean;
    error: FarmError | null;
    streamStatus: SseStatus;
    /** Newest page first; walks backwards with the keyset cursor. */
    loadMore: () => Promise<void>;
    hasMore: boolean;
    refresh: () => Promise<void>;
    acknowledgeAll: () => Promise<void>;
}

const AlertsContext = createContext<AlertsValue | null>(null);

export function AlertsProvider({ children }: { children: ReactNode }) {
    const { client, needsSetup, setUnacknowledgedCount } = useFarm();
    const [events, setEvents] = useState<FarmEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<FarmError | null>(null);
    const [streamStatus, setStreamStatus] = useState<SseStatus>('idle');
    const [nextBefore, setNextBefore] = useState<number | undefined>();
    const lastRenderedId = useRef<number | undefined>(undefined);

    useEffect(() => {
        void (async () => {
            const stored = await readJson<{ id: number }>(StorageKeys.lastEventId);
            if (typeof stored?.id === 'number') lastRenderedId.current = stored.id;
        })();
    }, []);

    const remember = useCallback((id: number) => {
        if (lastRenderedId.current !== undefined && id <= lastRenderedId.current) return;
        lastRenderedId.current = id;
        void writeJson(StorageKeys.lastEventId, { id });
    }, []);

    const refresh = useCallback(async () => {
        if (needsSetup) {
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const page = await client.listEvents({ limit: 50 });
            setEvents(page.events);
            setNextBefore(page.nextBefore);
            setError(null);
            if (page.events[0]) remember(page.events[0].id);
        } catch (caught) {
            setError(caught instanceof FarmError ? caught : new FarmError('unknown', String(caught)));
        } finally {
            setLoading(false);
        }
    }, [client, needsSetup, remember]);

    const loadMore = useCallback(async () => {
        if (!nextBefore) return;
        try {
            const page = await client.listEvents({ limit: 50, before: nextBefore });
            setEvents((previous) => [...previous, ...page.events]);
            setNextBefore(page.nextBefore);
        } catch {
            // A failed "older" page is not worth replacing the list for.
        }
    }, [client, nextBefore]);

    const acknowledgeAll = useCallback(async () => {
        const newest = events[0];
        if (!newest) return;
        const result = await client.ackEvents(newest.id);
        setUnacknowledgedCount(result.unacknowledgedCount);
    }, [client, events, setUnacknowledgedCount]);

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client]);

    // The stream, only while foregrounded. There is no `sse` capability flag —
    // `/api/events/stream` has always existed and answers 503 when the event
    // store is not wired up, which the reconnect backoff already handles.
    useEffect(() => {
        if (needsSetup) return;
        let unsubscribe: (() => void) | null = null;

        const open = () => {
            if (unsubscribe) return;
            unsubscribe = client.subscribeEvents({
                // The SSE resume header is a string on the wire.
                lastEventId: lastRenderedId.current === undefined ? undefined : String(lastRenderedId.current),
                onStatus: (status) => setStreamStatus(status),
                onEvent: (event) => {
                    setEvents((previous) => {
                        if (previous.some((row) => row.id === event.id)) return previous;
                        return [event, ...previous].slice(0, MAX_HELD);
                    });
                    setUnacknowledgedCount((count: number) => count + 1);
                    remember(event.id);
                },
            });
        };
        const close = () => {
            unsubscribe?.();
            unsubscribe = null;
            setStreamStatus('idle');
        };

        if (isForegroundState(AppState.currentState)) open();
        const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
            if (isForegroundState(next)) {
                open();
                // Events describe transitions; the summary describes state.
                void refresh();
            } else {
                close();
            }
        });

        return () => {
            subscription.remove();
            close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, needsSetup]);

    const value = useMemo<AlertsValue>(
        () => ({ events, loading, error, streamStatus, loadMore, hasMore: Boolean(nextBefore), refresh, acknowledgeAll }),
        [events, loading, error, streamStatus, loadMore, nextBefore, refresh, acknowledgeAll],
    );

    return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): AlertsValue {
    const value = useContext(AlertsContext);
    if (!value) throw new Error('useAlerts must be used inside AlertsProvider');
    return value;
}
