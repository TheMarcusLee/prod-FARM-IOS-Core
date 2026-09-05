import { serializeEvent, type EventKind, type EventSeverity, type FarmEvent } from '../fleet/events.js';
import type { JsonObject } from '../types.js';
import type { ChannelName, NotificationChannel, NotificationConfig } from './config.js';

/** Discord embed colours, by severity. */
export const SEVERITY_COLOURS: Record<EventSeverity, number> = {
    info: 0x2563eb, warning: 0xf59e0b, error: 0xdc2626,
};

const SEVERITY_EMOJI: Record<EventSeverity, string> = { info: 'ℹ️', warning: '⚠️', error: '🚨' };

/**
 * Every channel below has a documented per-field ceiling and rejects the whole
 * message with a 400 when one is exceeded — a stack trace in `detail.error` is
 * more than enough to trip them, so nothing is interpolated without a limit.
 */
export const SLACK_LIMITS = { text: 3_000, headerText: 150, fieldText: 2_000 } as const;
export const DISCORD_LIMITS = { title: 256, fieldName: 256, fieldValue: 1_024, embedTotal: 6_000 } as const;

/** Cuts at `limit` characters and says so, rather than silently losing the tail. */
export function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** Deep link to the page that explains the event, when PUBLIC_BASE_URL is set. */
export function eventLink(event: FarmEvent, publicBaseUrl: string): string | undefined {
    if (!publicBaseUrl) return undefined;
    if (event.executionId) return `${publicBaseUrl}/api/executions/${event.executionId}`;
    if (event.deviceUdid) return `${publicBaseUrl}/devices/${encodeURIComponent(event.deviceUdid)}`;
    return `${publicBaseUrl}/fleet`;
}

/** The error text a channel should show in a code block, if the event carries one. */
export function eventErrorText(event: FarmEvent): string | undefined {
    const candidate = event.detail?.error;
    return typeof candidate === 'string' && candidate.trim() ? candidate.slice(0, 1_500) : undefined;
}

export function webhookPayload(event: FarmEvent): JsonObject {
    return { event: serializeEvent(event) };
}

export function slackPayload(event: FarmEvent, publicBaseUrl = ''): JsonObject {
    const link = eventLink(event, publicBaseUrl);
    const error = eventErrorText(event);
    const field = (text: string): JsonObject => ({ type: 'mrkdwn', text: truncate(text, SLACK_LIMITS.fieldText) });
    const blocks: JsonObject[] = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: truncate(`${SEVERITY_EMOJI[event.severity]} ${event.title}`, SLACK_LIMITS.headerText),
                emoji: true,
            },
        },
        {
            type: 'section',
            fields: [
                field(`*Device*\n${event.deviceUdid ?? '—'}`),
                field(`*Kind*\n${event.kind}`),
                field(`*Time*\n${event.createdAt.toISOString()}`),
                field(`*Severity*\n${event.severity}`),
            ],
        },
    ];
    // The fence itself counts towards the 3000, so the error is cut to fit inside it.
    if (error) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `\`\`\`${truncate(error, SLACK_LIMITS.text - 6)}\`\`\`` },
        });
    }
    if (link) {
        blocks.push({
            type: 'actions',
            elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Phone Farm' }, url: link }],
        });
    }
    return { text: truncate(`${event.severity.toUpperCase()}: ${event.title}`, SLACK_LIMITS.text), blocks };
}

export function discordPayload(event: FarmEvent, publicBaseUrl = ''): JsonObject {
    const link = eventLink(event, publicBaseUrl);
    const error = eventErrorText(event);
    const field = (name: string, value: string, inline: boolean): JsonObject => ({
        name: truncate(name, DISCORD_LIMITS.fieldName),
        value: truncate(value || '—', DISCORD_LIMITS.fieldValue),
        inline,
    });
    const title = truncate(event.title, DISCORD_LIMITS.title);
    const fields: JsonObject[] = [
        field('Device', event.deviceUdid ?? '—', true),
        field('Kind', event.kind, true),
        field('Severity', event.severity, true),
    ];
    if (error) {
        // Discord counts every title, name and value towards one 6000-character
        // budget per embed, so the error gets whatever the rest has left over.
        const spent = title.length + fields.reduce((total, entry) =>
            total + String(entry.name).length + String(entry.value).length, 0);
        const room = Math.max(0, Math.min(DISCORD_LIMITS.fieldValue, DISCORD_LIMITS.embedTotal - spent - 'Error'.length) - 6);
        if (room > 0) fields.push(field('Error', `\`\`\`${truncate(error, room)}\`\`\``, false));
    }
    return {
        embeds: [{
            title,
            color: SEVERITY_COLOURS[event.severity],
            timestamp: event.createdAt.toISOString(),
            fields,
            ...(link ? { url: link } : {}),
        }],
    };
}

/** ntfy's `Priority` header, 1 (min) to 5 (max). */
export const NTFY_PRIORITY: Record<EventSeverity, string> = { info: '3', warning: '4', error: '5' };

/** ntfy renders these shortcodes as the emoji in front of the title. */
export const NTFY_TAGS: Record<EventKind, string> = {
    'execution.started': 'arrow_forward',
    'execution.succeeded': 'white_check_mark',
    'execution.failed': 'x',
    'execution.stopped': 'octagonal_sign',
    'execution.stuck': 'hourglass',
    'device.connected': 'electric_plug',
    'device.disconnected': 'warning',
    'device.error': 'rotating_light',
    'schedule.created': 'calendar',
    'schedule.paused': 'pause_button',
    'schedule.cancelled': 'wastebasket',
    'digest.daily': 'newspaper',
};

/**
 * Header values must be one line of printable ASCII — a device name with an
 * emoji or a newline in it would otherwise produce an invalid request.
 */
export function headerSafe(value: string, limit = 200): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '').trim().slice(0, limit);
}

export interface NtfyRequest {
    headers: Record<string, string>;
    body: string;
}

/** ntfy publishes over plain HTTP POST: the body is the message, the rest is headers. */
export function ntfyRequest(
    event: FarmEvent, channel: Pick<NotificationChannel, 'token'>, publicBaseUrl = '',
): NtfyRequest {
    const link = eventLink(event, publicBaseUrl);
    const error = eventErrorText(event);
    const detail = error ?? `${event.kind}${event.deviceUdid ? ` · ${event.deviceUdid}` : ''}`;
    const headers: Record<string, string> = {
        'content-type': 'text/plain; charset=utf-8',
        Title: headerSafe(event.title) || event.kind,
        Priority: NTFY_PRIORITY[event.severity],
        Tags: NTFY_TAGS[event.kind] ?? 'bell',
    };
    // Header values, this one included, must survive as one printable ASCII line:
    // a stray newline in PUBLIC_BASE_URL would otherwise be header injection.
    if (link) headers.Click = headerSafe(link, 500);
    if (channel.token) headers.Authorization = `Bearer ${channel.token}`;
    return { headers, body: `${event.title}\n${detail}`.slice(0, 4_000) };
}

export function payloadFor(channel: ChannelName, event: FarmEvent, config: Pick<NotificationConfig, 'publicBaseUrl'>): JsonObject {
    if (channel === 'slack') return slackPayload(event, config.publicBaseUrl);
    if (channel === 'discord') return discordPayload(event, config.publicBaseUrl);
    return webhookPayload(event);
}
