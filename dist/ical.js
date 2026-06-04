// Pure, dependency-free RFC 5545 (iCalendar) generation for pm items.
//
// Kept in its own module (no db/express/neo4j imports) so it is unit-testable
// without booting the server or a database. The pm route layer reads items via
// the pm CLI and hands the relevant fields here.
// Escape a text value per RFC 5545 §3.3.11 (TEXT): backslash, semicolon,
// comma and newlines must be escaped.
export function icsEscapeText(value) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r\n|\r|\n/g, "\\n");
}
// Fold long content lines to 75 octets per RFC 5545 §3.1. Continuation lines
// begin with a single space. We fold on character boundaries which is safe for
// the ASCII-dominant content pm produces.
export function foldLine(line) {
    if (line.length <= 75)
        return line;
    const parts = [];
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
export function formatUtcTimestamp(d) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`);
}
// Format a Date as an all-day DATE value: YYYYMMDD (RFC 5545 §3.3.4).
export function formatDateValue(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
// A pm deadline may be a date-only string (YYYY-MM-DD) or a full ISO datetime.
// Returns null for anything unparseable so callers can skip the item.
function parseDeadline(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const d = new Date(dateOnly ? `${trimmed}T00:00:00Z` : trimmed);
    if (Number.isNaN(d.getTime()))
        return null;
    // pm normalizes date-only deadlines to a midnight-UTC ISO timestamp
    // (e.g. "2026-06-10T00:00:00.000Z"). Treat any exact-midnight-UTC value as
    // an all-day event, which renders far better in calendar clients than a
    // zero-length event at 00:00.
    const isMidnightUtc = d.getUTCHours() === 0 &&
        d.getUTCMinutes() === 0 &&
        d.getUTCSeconds() === 0 &&
        d.getUTCMilliseconds() === 0;
    return { date: d, allDay: dateOnly || isMidnightUtc };
}
// Build a single VEVENT for a pm item with a deadline. Returns null when the
// item has no usable deadline.
export function itemToVevent(item, opts) {
    if (!item.deadline)
        return null;
    const parsed = parseDeadline(item.deadline);
    if (!parsed)
        return null;
    const lines = ["BEGIN:VEVENT"];
    lines.push(`UID:${item.id}@${opts.uidDomain}`);
    lines.push(`DTSTAMP:${opts.dtstamp}`);
    if (parsed.allDay) {
        // All-day event: DTSTART/DTEND use VALUE=DATE, DTEND is the next day
        // (exclusive end) per RFC 5545.
        const end = new Date(parsed.date.getTime() + 24 * 60 * 60 * 1000);
        lines.push(`DTSTART;VALUE=DATE:${formatDateValue(parsed.date)}`);
        lines.push(`DTEND;VALUE=DATE:${formatDateValue(end)}`);
    }
    else {
        lines.push(`DTSTART:${formatUtcTimestamp(parsed.date)}`);
        lines.push(`DTEND:${formatUtcTimestamp(parsed.date)}`);
    }
    const summaryPrefix = item.type ? `[${item.type}] ` : "";
    lines.push(`SUMMARY:${icsEscapeText(summaryPrefix + (item.title ?? item.id))}`);
    const descParts = [`pm item ${item.id}`];
    if (item.status)
        descParts.push(`Status: ${item.status}`);
    if (item.assignee)
        descParts.push(`Assignee: ${item.assignee}`);
    if (item.priority !== undefined && item.priority !== null)
        descParts.push(`Priority: P${item.priority}`);
    if (item.tags && item.tags.length)
        descParts.push(`Tags: ${item.tags.join(", ")}`);
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
export function buildIcsCalendar(items, opts = {}) {
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
    const events = [];
    for (const item of items) {
        const vevent = itemToVevent(item, { uidDomain, dtstamp });
        if (vevent)
            events.push(vevent);
    }
    const all = [...head.map(foldLine), ...events, "END:VCALENDAR"];
    // Trailing CRLF is conventional and accepted by all major parsers.
    return all.join("\r\n") + "\r\n";
}
//# sourceMappingURL=ical.js.map