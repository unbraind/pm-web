// Pure, dependency-free RFC 5545 (iCalendar) generation for pm items.
//
// Kept in its own module (no db/express/neo4j imports) so it is unit-testable
// without booting the server or a database. The pm route layer reads items via
// the pm CLI and hands the relevant fields here.

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
  // Calendar name shown in the subscribing client (e.g. project name).
  calendarName?: string;
  // Stable per-calendar UID suffix so events from different projects don't
  // collide in a client that subscribes to several pm-web calendars.
  uidDomain?: string;
  // Fixed timestamp for DTSTAMP / generation, used to make output
  // deterministic in tests. Defaults to "now".
  now?: Date;
};

// Escape a text value per RFC 5545 §3.3.11 (TEXT): backslash, semicolon,
// comma and newlines must be escaped.
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
export function icsEscapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Fold long content lines to 75 octets per RFC 5545 §3.1. Continuation lines
// begin with a single space. We fold on character boundaries which is safe for
// the ASCII-dominant content pm produces.
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
export function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  parts.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    // 74 chars + 1 leading space = 75 octets per continuation line.
    parts.push(" " + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return parts.join("\r\n");
}

// Format a Date as a UTC timestamp: YYYYMMDDTHHMMSSZ (RFC 5545 form 2).
/**
 * Format a Date as a UTC `DATE-TIME` value (`YYYYMMDDTHHMMSSZ`, RFC 5545 form
 * 2). Uses the UTC components of the date so the result is timezone-stable.
 *
 * @param d - The instant to format.
 * @returns The UTC timestamp string ending in `Z`.
 */
export function formatUtcTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// Format a Date as an all-day DATE value: YYYYMMDD (RFC 5545 §3.3.4).
/**
 * Format a Date as an all-day `DATE` value (`YYYYMMDD`, RFC 5545 §3.3.4),
 * using the UTC calendar date.
 *
 * @param d - The date to format.
 * @returns The `YYYYMMDD` date string.
 */
export function formatDateValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

// A pm deadline may be a date-only string (YYYY-MM-DD) or a full ISO datetime.
// Returns null for anything unparseable so callers can skip the item.
/**
 * Parse a pm deadline string into a date plus an all-day flag.
 *
 * Accepts a date-only `YYYY-MM-DD` value or a full ISO datetime; surrounding
 * whitespace and empty strings yield `null`, as do values `new Date` cannot
 * parse. A date-only value, or any instant that lands exactly on midnight UTC,
 * is treated as an all-day event (which calendar clients render far better
 * than a zero-length 00:00 event).
 *
 * @param raw - The raw deadline string from a pm item.
 * @returns The parsed date and all-day flag, or `null` when unparseable.
 */
function parseDeadline(raw: string): { date: Date; allDay: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const d = new Date(dateOnly ? `${trimmed}T00:00:00Z` : trimmed);
  if (Number.isNaN(d.getTime())) return null;
  // pm normalizes date-only deadlines to a midnight-UTC ISO timestamp
  // (e.g. "2026-06-10T00:00:00.000Z"). Treat any exact-midnight-UTC value as
  // an all-day event, which renders far better in calendar clients than a
  // zero-length event at 00:00.
  const isMidnightUtc =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  return { date: d, allDay: dateOnly || isMidnightUtc };
}

// Build a single VEVENT for a pm item with a deadline. Returns null when the
// item has no usable deadline.
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
export function itemToVevent(
  item: CalendarItem,
  opts: { uidDomain: string; dtstamp: string },
): string | null {
  if (!item.deadline) return null;
  const parsed = parseDeadline(item.deadline);
  if (!parsed) return null;

  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${item.id}@${opts.uidDomain}`);
  lines.push(`DTSTAMP:${opts.dtstamp}`);

  if (parsed.allDay) {
    // All-day event: DTSTART/DTEND use VALUE=DATE, DTEND is the next day
    // (exclusive end) per RFC 5545.
    const end = new Date(parsed.date.getTime() + 24 * 60 * 60 * 1000);
    lines.push(`DTSTART;VALUE=DATE:${formatDateValue(parsed.date)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateValue(end)}`);
  } else {
    lines.push(`DTSTART:${formatUtcTimestamp(parsed.date)}`);
    lines.push(`DTEND:${formatUtcTimestamp(parsed.date)}`);
  }

  const summaryPrefix = item.type ? `[${item.type}] ` : "";
  lines.push(`SUMMARY:${icsEscapeText(summaryPrefix + (item.title ?? item.id))}`);

  const descParts: string[] = [`pm item ${item.id}`];
  if (item.status) descParts.push(`Status: ${item.status}`);
  if (item.assignee) descParts.push(`Assignee: ${item.assignee}`);
  if (item.priority !== undefined && item.priority !== null) descParts.push(`Priority: P${item.priority}`);
  if (item.tags && item.tags.length) descParts.push(`Tags: ${item.tags.join(", ")}`);
  // Join with real newlines; icsEscapeText turns them into the RFC 5545 "\n"
  // escape sequence (escaping here directly would double-escape).
  lines.push(`DESCRIPTION:${icsEscapeText(descParts.join("\n"))}`);

  // Map pm priority (0 highest .. 4 lowest) onto the iCal 1..9 scale where 1
  // is highest. Leave unset when no priority is present.
  if (typeof item.priority === "number" && item.priority >= 0 && item.priority <= 4) {
    const icalPriority = Math.min(9, Math.max(1, item.priority * 2 + 1));
    lines.push(`PRIORITY:${icalPriority}`);
  }

  if (item.tags && item.tags.length) {
    lines.push(`CATEGORIES:${item.tags.map(icsEscapeText).join(",")}`);
  }

  // Closed/canceled items are recorded as CANCELLED so subscribers can hide
  // them; everything else is CONFIRMED.
  const cancelled = item.status === "closed" || item.status === "canceled";
  lines.push(`STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`);

  lines.push("END:VEVENT");
  return lines.map(foldLine).join("\r\n");
}

// Build a complete VCALENDAR document from pm items. Items without a usable
// deadline are skipped. Output uses CRLF line endings per RFC 5545 §3.1.
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
export function buildIcsCalendar(items: CalendarItem[], opts: IcsOptions = {}): string {
  const now = opts.now ?? new Date();
  const dtstamp = formatUtcTimestamp(now);
  const uidDomain = (opts.uidDomain ?? "pm-web").replace(/[^A-Za-z0-9._-]/g, "-");
  const calName = opts.calendarName ?? "pm-web";

  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//pm-web//pm-cli calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscapeText(calName)}`,
    `NAME:${icsEscapeText(calName)}`,
  ];

  const events: string[] = [];
  for (const item of items) {
    const vevent = itemToVevent(item, { uidDomain, dtstamp });
    if (vevent) events.push(vevent);
  }

  const all = [...head.map(foldLine), ...events, "END:VCALENDAR"];
  // Trailing CRLF is conventional and accepted by all major parsers.
  return all.join("\r\n") + "\r\n";
}
