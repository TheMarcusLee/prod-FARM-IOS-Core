/**
 * Timezone helpers for the drip planner. The planner thinks in a rule's local
 * wall clock ("post between 09:00 and 21:00 in America/New_York") but the
 * scheduler stores absolute instants, so every window edge is converted here.
 * Only the Intl API is used — no date library.
 */

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86_400_000;

export function isLocalTime(value: string): boolean {
    return TIME_PATTERN.test(value);
}

export function minutesOfDay(localTime: string): number {
    if (!isLocalTime(localTime)) throw new Error(`"${localTime}" must use HH:MM`);
    const [hour, minute] = localTime.split(':').map(Number);
    return (hour as number) * 60 + (minute as number);
}

export function isTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
}

function zonedParts(instant: Date, timeZone: string): number[] {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
    return [read('year'), read('month'), read('day'), read('hour'), read('minute'), read('second')];
}

/** How far the zone is from UTC at `instant`, in minutes (positive east of UTC). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
    const [year, month, day, hour, minute, second] = zonedParts(instant, timeZone);
    const asUtc = Date.UTC(year as number, (month as number) - 1, day as number, hour, minute, second);
    return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** 'YYYY-MM-DD' for `instant` as seen in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
    const [year, month, day] = zonedParts(instant, timeZone);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${pad(month as number)}-${pad(day as number)}`;
}

export function addDays(localDateString: string, days: number): string {
    const [year, month, day] = localDateString.split('-').map(Number);
    const shifted = new Date(Date.UTC(year as number, (month as number) - 1, day as number) + days * DAY_MS);
    return shifted.toISOString().slice(0, 10);
}

/**
 * The instant at which the wall clock in `timeZone` reads `localDateString`
 * plus `minutes`. Two passes settle the offset around a DST transition; a
 * skipped local time lands on the instant the clock jumped to.
 */
export function zonedTimeToUtc(localDateString: string, minutes: number, timeZone: string): Date {
    const [year, month, day] = localDateString.split('-').map(Number);
    const naive = Date.UTC(year as number, (month as number) - 1, day as number) + minutes * 60_000;
    let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
    instant = new Date(naive - zoneOffsetMinutes(instant, timeZone) * 60_000);
    return instant;
}

export interface PostingWindow { start: Date; end: Date }

/**
 * The absolute window a rule may post inside on one local date. An end at or
 * before the start means the window runs past midnight into the next day.
 */
export function windowForDate(
    localDateString: string,
    windowStart: string,
    windowEnd: string,
    timeZone: string,
): PostingWindow {
    const startMinutes = minutesOfDay(windowStart);
    const endMinutes = minutesOfDay(windowEnd);
    const start = zonedTimeToUtc(localDateString, startMinutes, timeZone);
    const end = endMinutes > startMinutes
        ? zonedTimeToUtc(localDateString, endMinutes, timeZone)
        : zonedTimeToUtc(addDays(localDateString, 1), endMinutes, timeZone);
    return { start, end };
}
