import type { ContentStatus, DripOrder, DripSource, PostDestination } from '../database/schema.js';
import { isLocalTime, isTimeZone, minutesOfDay } from './time.js';

/**
 * Every request body is read through an explicit whitelist. Nothing reaches the
 * database that was not named here — a stray `id` or `usedCount` in a PATCH is
 * dropped, not persisted.
 */

export class ValidationError extends Error {
    readonly statusCode = 400;
}

function fail(message: string): never {
    throw new ValidationError(message);
}

export function asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Request body must be an object');
    return value as Record<string, unknown>;
}

export function optionalText(value: unknown, name: string, max = 2200): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') fail(`${name} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > max) fail(`${name} must be ${max} characters or fewer`);
    return trimmed || undefined;
}

export function requiredText(value: unknown, name: string, max = 200): string {
    return optionalText(value, name, max) ?? fail(`${name} is required`);
}

export function uuidOrUndefined(value: unknown, name: string): string | undefined {
    const text = optionalText(value, name, 64);
    if (text === undefined) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) fail(`${name} must be a UUID`);
    return text;
}

/** Accepts an array or a comma/space separated string, which is what the HTML form sends. */
export function tagList(value: unknown, name: string, max = 40): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : fail(`${name} must be a list`);
    const tags = raw
        .map((entry) => typeof entry === 'string' ? entry.trim().replace(/^#+/, '').toLowerCase() : fail(`${name} must contain strings`))
        .filter(Boolean);
    if (tags.length > max) fail(`${name} accepts at most ${max} entries`);
    if (tags.some((tag) => tag.length > 64 || !/^[a-z0-9._-]+$/.test(tag))) {
        fail(`${name} may contain letters, numbers, periods, underscores, and hyphens`);
    }
    return [...new Set(tags)];
}

export function boundedInteger(value: unknown, name: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`${name} must be an integer between ${min} and ${max}`);
    return parsed;
}

export function booleanFlag(value: unknown, name: string): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'on' || value === '1') return true;
    if (value === 'false' || value === 'off' || value === '0') return false;
    fail(`${name} must be true or false`);
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${name} must be one of ${allowed.join(', ')}`);
    return value as T;
}

export interface ItemPatch { tags?: string[]; caption?: string | null; hashtags?: string[]; status?: ContentStatus }

export function parseItemPatch(body: unknown): ItemPatch {
    const input = asObject(body);
    const patch: ItemPatch = {};
    const tags = tagList(input.tags, 'tags');
    if (tags) patch.tags = tags;
    const hashtags = tagList(input.hashtags, 'hashtags');
    if (hashtags) patch.hashtags = hashtags;
    if ('caption' in input) patch.caption = optionalText(input.caption, 'caption', 2200) ?? null;
    const status = oneOf(input.status, 'status', ['ready', 'archived'] as const);
    if (status) patch.status = status;
    if (!Object.keys(patch).length) fail('Nothing to update');
    return patch;
}

export interface IngestRequest { directory: string; tags?: string[]; crop?: boolean }

export function parseIngestRequest(body: unknown): IngestRequest {
    const input = asObject(body);
    const directory = requiredText(input.directory, 'directory', 1024);
    const tags = tagList(input.tags, 'tags');
    const crop = booleanFlag(input.crop, 'crop');
    return { directory, ...(tags ? { tags } : {}), ...(crop === undefined ? {} : { crop }) };
}

export function parseIngestUrl(body: unknown): { url: string; tags?: string[]; crop?: boolean } {
    const input = asObject(body);
    const url = requiredText(input.url, 'url', 2048);
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return fail('url must be an absolute URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('url must be http or https');
    const tags = tagList(input.tags, 'tags');
    const crop = booleanFlag(input.crop, 'crop');
    return { url: parsed.toString(), ...(tags ? { tags } : {}), ...(crop === undefined ? {} : { crop }) };
}

export function parseSetInput(body: unknown): { name: string; notes?: string | null } {
    const input = asObject(body);
    return { name: requiredText(input.name, 'name', 120), notes: optionalText(input.notes, 'notes', 1000) ?? null };
}

export function parseSetItems(body: unknown): { itemIds: string[] } {
    const input = asObject(body);
    const raw = Array.isArray(input.itemIds) ? input.itemIds
        : typeof input.itemIds === 'string' ? input.itemIds.split(/[\s,]+/).filter(Boolean)
            : fail('itemIds must be a list');
    if (raw.length > 100) fail('itemIds accepts at most 100 entries');
    return { itemIds: raw.map((value, index) => uuidOrUndefined(value, `itemIds[${index}]`) ?? fail('itemIds must contain UUIDs')) };
}

export function parseTemplateInput(body: unknown): { name: string; template: string } {
    const input = asObject(body);
    return { name: requiredText(input.name, 'name', 120), template: requiredText(input.template, 'template', 2200) };
}

export interface RuleInput {
    deviceUdid: string;
    account: string;
    enabled: boolean;
    postsPerDay: number;
    windowStart: string;
    windowEnd: string;
    timezone: string;
    minGapMinutes: number;
    destination: PostDestination;
    source: DripSource;
    setId: string | null;
    tag: string | null;
    captionTemplateId: string | null;
    pickOrder: DripOrder;
    avoidReuseDays: number;
}

function assertWindow(rule: Pick<RuleInput, 'windowStart' | 'windowEnd' | 'postsPerDay' | 'minGapMinutes'>): void {
    const start = minutesOfDay(rule.windowStart);
    const end = minutesOfDay(rule.windowEnd);
    const span = end > start ? end - start : 24 * 60 - start + end;
    const needed = (rule.postsPerDay - 1) * rule.minGapMinutes;
    if (needed > span) {
        fail(`${rule.postsPerDay} posts ${rule.minGapMinutes} minutes apart do not fit in a ${span}-minute window`);
    }
}

function assertSource(rule: Pick<RuleInput, 'source' | 'setId' | 'tag'>): void {
    if (rule.source === 'set' && !rule.setId) fail('Choose a content set');
    if (rule.source === 'tag' && !rule.tag) fail('Choose a tag');
}

export function parseRuleInput(body: unknown): RuleInput {
    const input = asObject(body);
    const account = requiredText(input.account, 'account', 80);
    if (!/^@?[A-Za-z0-9._]{1,64}$/.test(account)) fail('account must be a TikTok handle');
    const timezone = optionalText(input.timezone, 'timezone', 64) ?? 'UTC';
    if (!isTimeZone(timezone)) fail('timezone must be an IANA time zone');
    const windowStart = optionalText(input.windowStart, 'windowStart', 5) ?? '09:00';
    const windowEnd = optionalText(input.windowEnd, 'windowEnd', 5) ?? '21:00';
    if (!isLocalTime(windowStart) || !isLocalTime(windowEnd)) fail('window times must use HH:MM');
    const rule: RuleInput = {
        deviceUdid: requiredText(input.deviceUdid, 'deviceUdid', 128),
        account: account.startsWith('@') ? account : `@${account}`,
        enabled: booleanFlag(input.enabled, 'enabled') ?? true,
        postsPerDay: boundedInteger(input.postsPerDay, 'postsPerDay', 1, 24) ?? 1,
        windowStart,
        windowEnd,
        timezone,
        minGapMinutes: boundedInteger(input.minGapMinutes, 'minGapMinutes', 0, 1440) ?? 90,
        destination: oneOf(input.destination, 'destination', ['draft', 'publish'] as const) ?? 'draft',
        source: oneOf(input.source, 'source', ['set', 'tag'] as const) ?? 'tag',
        setId: uuidOrUndefined(input.setId, 'setId') ?? null,
        tag: tagList(input.tag, 'tag', 1)?.[0] ?? null,
        captionTemplateId: uuidOrUndefined(input.captionTemplateId, 'captionTemplateId') ?? null,
        pickOrder: oneOf(input.order ?? input.pickOrder, 'order', ['random', 'fifo'] as const) ?? 'random',
        avoidReuseDays: boundedInteger(input.avoidReuseDays, 'avoidReuseDays', 0, 3650) ?? 30,
    };
    assertWindow(rule);
    assertSource(rule);
    return rule;
}

export function parseRulePatch(body: unknown, current: RuleInput): RuleInput {
    const input = asObject(body);
    const merged: Record<string, unknown> = {
        deviceUdid: input.deviceUdid ?? current.deviceUdid,
        account: input.account ?? current.account,
        enabled: input.enabled ?? current.enabled,
        postsPerDay: input.postsPerDay ?? current.postsPerDay,
        windowStart: input.windowStart ?? current.windowStart,
        windowEnd: input.windowEnd ?? current.windowEnd,
        timezone: input.timezone ?? current.timezone,
        minGapMinutes: input.minGapMinutes ?? current.minGapMinutes,
        destination: input.destination ?? current.destination,
        source: input.source ?? current.source,
        setId: 'setId' in input ? input.setId : current.setId,
        tag: 'tag' in input ? input.tag : current.tag,
        captionTemplateId: 'captionTemplateId' in input ? input.captionTemplateId : current.captionTemplateId,
        order: input.order ?? input.pickOrder ?? current.pickOrder,
        avoidReuseDays: input.avoidReuseDays ?? current.avoidReuseDays,
    };
    return parseRuleInput(merged);
}
