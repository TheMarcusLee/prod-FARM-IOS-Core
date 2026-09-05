import { isEventKind, isEventSeverity, type EventKind, type EventSeverity } from '../fleet/events.js';

export type ChannelName = 'webhook' | 'slack' | 'discord';

export interface NotificationChannel {
    name: ChannelName;
    url: string;
}

export interface NotificationConfig {
    channels: NotificationChannel[];
    minSeverity: EventSeverity;
    /** When set, only these kinds are delivered — overrides minSeverity entirely. */
    kinds?: EventKind[];
    digestLocalTime: string;
    digestTimezone: string;
    publicBaseUrl: string;
}

export const DEFAULT_DIGEST_LOCAL_TIME = '08:00';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function trimmed(value: string | undefined): string | undefined {
    const candidate = value?.trim();
    return candidate ? candidate : undefined;
}

/** Only http(s) — a webhook URL from the environment still gets sanity-checked. */
function httpUrl(value: string | undefined): string | undefined {
    const candidate = trimmed(value);
    if (!candidate) return undefined;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? candidate : undefined;
    } catch { return undefined; }
}

export function notificationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
    const channels: NotificationChannel[] = [];
    const webhook = httpUrl(env.NOTIFY_WEBHOOK_URL);
    const slack = httpUrl(env.NOTIFY_SLACK_WEBHOOK_URL);
    const discord = httpUrl(env.NOTIFY_DISCORD_WEBHOOK_URL);
    if (webhook) channels.push({ name: 'webhook', url: webhook });
    if (slack) channels.push({ name: 'slack', url: slack });
    if (discord) channels.push({ name: 'discord', url: discord });
    const kinds = (trimmed(env.NOTIFY_KINDS) ?? '').split(',').map((value) => value.trim()).filter(isEventKind);
    const minSeverity = trimmed(env.NOTIFY_MIN_SEVERITY);
    const digestLocalTime = trimmed(env.DIGEST_LOCAL_TIME);
    return {
        channels,
        minSeverity: isEventSeverity(minSeverity) ? minSeverity : 'warning',
        ...(kinds.length ? { kinds } : {}),
        digestLocalTime: digestLocalTime && TIME_PATTERN.test(digestLocalTime) ? digestLocalTime : DEFAULT_DIGEST_LOCAL_TIME,
        digestTimezone: trimmed(env.DIGEST_TIMEZONE) ?? 'UTC',
        publicBaseUrl: (trimmed(env.PUBLIC_BASE_URL) ?? '').replace(/\/+$/, ''),
    };
}
