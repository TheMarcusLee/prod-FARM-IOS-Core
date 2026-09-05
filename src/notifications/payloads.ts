import { serializeEvent, type EventKind, type EventSeverity, type FarmEvent } from '../fleet/events.js';
import type { JsonObject } from '../types.js';
import type { ChannelName, NotificationChannel, NotificationConfig } from './config.js';

/** Discord embed colours, by severity. */
export const SEVERITY_COLOURS: Record<EventSeverity, number> = {
    info: 0x2563eb, warning: 0xf59e0b, error: 0xdc2626,
};

const SEVERITY_EMOJI: Record<EventSeverity, string> = { info: 'ℹ️', warning: '⚠️', error: '🚨' };

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
    const blocks: JsonObject[] = [
        { type: 'header', text: { type: 'plain_text', text: `${SEVERITY_EMOJI[event.severity]} ${event.title}`.slice(0, 150), emoji: true } },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Device*\n${event.deviceUdid ?? '—'}` },
                { type: 'mrkdwn', text: `*Kind*\n${event.kind}` },
                { type: 'mrkdwn', text: `*Time*\n${event.createdAt.toISOString()}` },
                { type: 'mrkdwn', text: `*Severity*\n${event.severity}` },
            ],
        },
    ];
    if (error) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${error}\`\`\`` } });
    if (link) {
        blocks.push({
            type: 'actions',
            elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Phone Farm' }, url: link }],
        });
    }
    return { text: `${event.severity.toUpperCase()}: ${event.title}`, blocks };
}

export function discordPayload(event: FarmEvent, publicBaseUrl = ''): JsonObject {
    const link = eventLink(event, publicBaseUrl);
    const error = eventErrorText(event);
    const fields: JsonObject[] = [
        { name: 'Device', value: event.deviceUdid ?? '—', inline: true },
        { name: 'Kind', value: event.kind, inline: true },
        { name: 'Severity', value: event.severity, inline: true },
    ];
    if (error) fields.push({ name: 'Error', value: `\`\`\`${error.slice(0, 1_000)}\`\`\``, inline: false });
    return {
        embeds: [{
            title: event.title.slice(0, 250),
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
    if (link) headers.Click = link;
    if (channel.token) headers.Authorization = `Bearer ${channel.token}`;
    return { headers, body: `${event.title}\n${detail}`.slice(0, 4_000) };
}

export function payloadFor(channel: ChannelName, event: FarmEvent, config: Pick<NotificationConfig, 'publicBaseUrl'>): JsonObject {
    if (channel === 'slack') return slackPayload(event, config.publicBaseUrl);
    if (channel === 'discord') return discordPayload(event, config.publicBaseUrl);
    return webhookPayload(event);
}
