/**
 * Minimal projection of a pm item used for iCalendar export: a stable id plus
 * the optional fields the VEVENT builder reads (title, type, status, priority,
 * deadline, assignee, tags). Only `deadline` is required to produce an event.
 */
export type CalendarItem = {
    id: string;
    title?: string;
    type?: string;
    status?: string;
    priority?: number;
    deadline?: string;
    assignee?: string;
    tags?: string[];
};
/**
 * Options for {@link buildIcsCalendar}: the displayed calendar name, a stable
 * UID domain suffix that keeps events from different projects from colliding
 * in a multi-calendar client, and an optional fixed `now` to make output
 * deterministic in tests.
 */
export type IcsOptions = {
    calendarName?: string;
    uidDomain?: string;
    now?: Date;
};
/**
 * Escape a value for an RFC 5545 (§3.3.11) TEXT property.
 *
 * Prefixes backslash, and escapes semicolons, commas, and any newline variant
 * (CRLF/CR/LF) as the literal `\n` sequence, so the value can be embedded in a
 * property without breaking line or field structure.
 *
 * @param value - The raw text to escape.
 * @returns The escaped text, safe to place after a property name and colon.
 */
export declare function icsEscapeText(value: string): string;
/**
 * Fold a content line to 75-octet segments per RFC 5545 (§3.1).
 *
 * Lines at or under 75 octets are returned unchanged; longer lines are split
 * with the first segment taking 75 octets and each continuation taking 74 plus
 * a single leading space, joined with CRLF. Folding is done on character
 * boundaries, which is safe for the ASCII-dominant content pm produces.
 *
 * @param line - A single unfolded content line.
 * @returns The line, folded into CRLF-joined 75-octet segments when needed.
 */
export declare function foldLine(line: string): string;
/**
 * Format a Date as a UTC `DATE-TIME` value (`YYYYMMDDTHHMMSSZ`, RFC 5545 form
 * 2). Uses the UTC components of the date so the result is timezone-stable.
 *
 * @param d - The instant to format.
 * @returns The UTC timestamp string ending in `Z`.
 */
export declare function formatUtcTimestamp(d: Date): string;
/**
 * Format a Date as an all-day `DATE` value (`YYYYMMDD`, RFC 5545 §3.3.4),
 * using the UTC calendar date.
 *
 * @param d - The date to format.
 * @returns The `YYYYMMDD` date string.
 */
export declare function formatDateValue(d: Date): string;
/**
 * Build a single VEVENT (RFC 5545) for a pm item that has a usable deadline.
 *
 * Returns `null` when the item has no deadline or one {@link parseDeadline}
 * cannot read. Otherwise emits UID/DTSTAMP, all-day or timed DTSTART/DTEND,
 * an escaped SUMMARY and DESCRIPTION (status/assignee/priority/tags), an iCal
 * PRIORITY mapped from pm's 0–4 scale, CATEGORIES from tags, and a STATUS of
 * CANCELLED for closed/canceled items (CONFIRMED otherwise). Each line is
 * folded and the event is joined with CRLF.
 *
 * @param item - The item to render.
 * @param opts - The UID domain suffix and the shared DTSTAMP value.
 * @returns The folded VEVENT text, or `null` when the item has no deadline.
 */
export declare function itemToVevent(item: CalendarItem, opts: {
    uidDomain: string;
    dtstamp: string;
}): string | null;
/**
 * Build a complete VCALENDAR document from pm items.
 *
 * Emits the VCALENDAR header (version, PRODID, calendar name), one VEVENT per
 * item that has a usable deadline (items without one are skipped), and the
 * closing tag, all CRLF-joined with a trailing CRLF per RFC 5545. The UID
 * domain defaults to `pm-web` and is sanitized to hostname-safe characters.
 *
 * @param items - The items to export.
 * @param opts - Optional calendar name, UID domain, and fixed `now` for tests.
 * @returns The full iCalendar (.ics) document text.
 */
export declare function buildIcsCalendar(items: CalendarItem[], opts?: IcsOptions): string;
