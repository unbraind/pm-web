import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIcsCalendar,
  itemToVevent,
  icsEscapeText,
  foldLine,
  formatUtcTimestamp,
  formatDateValue,
} from "../dist/ical.js";

const NOW = new Date("2026-06-04T12:00:00Z");

test("icsEscapeText escapes RFC 5545 special characters", () => {
  assert.equal(icsEscapeText("a,b;c\\d"), "a\\,b\\;c\\\\d");
  assert.equal(icsEscapeText("line1\nline2"), "line1\\nline2");
});

test("formatUtcTimestamp and formatDateValue produce RFC 5545 forms", () => {
  assert.equal(formatUtcTimestamp(new Date("2026-06-04T09:05:07Z")), "20260604T090507Z");
  assert.equal(formatDateValue(new Date("2026-06-04T00:00:00Z")), "20260604");
});

test("foldLine folds content lines longer than 75 octets", () => {
  const long = "X".repeat(200);
  const folded = foldLine(long);
  const physical = folded.split("\r\n");
  assert.ok(physical.length > 1, "expected multiple physical lines");
  assert.ok(physical[0].length <= 75);
  // continuation lines start with a single space
  for (const l of physical.slice(1)) assert.equal(l[0], " ");
});

test("itemToVevent emits an all-day VEVENT for a date-only deadline", () => {
  const v = itemToVevent(
    { id: "demo-1", title: "Ship it", type: "Feature", status: "open", priority: 1, deadline: "2026-06-10", tags: ["release"] },
    { uidDomain: "demo.pm-web", dtstamp: formatUtcTimestamp(NOW) },
  );
  assert.ok(v);
  assert.match(v!, /BEGIN:VEVENT/);
  assert.match(v!, /UID:demo-1@demo\.pm-web/);
  assert.match(v!, /DTSTART;VALUE=DATE:20260610/);
  // exclusive end = next day
  assert.match(v!, /DTEND;VALUE=DATE:20260611/);
  assert.match(v!, /SUMMARY:\[Feature\] Ship it/);
  assert.match(v!, /CATEGORIES:release/);
  assert.match(v!, /STATUS:CONFIRMED/);
});

test("itemToVevent emits a timed VEVENT for an ISO datetime deadline", () => {
  const v = itemToVevent(
    { id: "demo-2", title: "Standup", deadline: "2026-06-10T15:30:00Z" },
    { uidDomain: "demo.pm-web", dtstamp: formatUtcTimestamp(NOW) },
  );
  assert.ok(v);
  assert.match(v!, /DTSTART:20260610T153000Z/);
});

test("itemToVevent treats a midnight-UTC ISO deadline as an all-day event", () => {
  // pm normalizes a date-only deadline to e.g. "2026-06-10T00:00:00.000Z".
  const v = itemToVevent(
    { id: "demo-4", title: "Release", deadline: "2026-06-10T00:00:00.000Z" },
    { uidDomain: "demo.pm-web", dtstamp: formatUtcTimestamp(NOW) },
  );
  assert.match(v!, /DTSTART;VALUE=DATE:20260610/);
  assert.match(v!, /DTEND;VALUE=DATE:20260611/);
});

test("itemToVevent escapes DESCRIPTION newlines exactly once", () => {
  const v = itemToVevent(
    { id: "demo-5", title: "T", status: "open", assignee: "bob", deadline: "2026-06-10" },
    { uidDomain: "demo.pm-web", dtstamp: formatUtcTimestamp(NOW) },
  );
  // Single backslash-n, never the double-escaped "\\n".
  assert.ok(/DESCRIPTION:pm item demo-5\\nStatus: open\\nAssignee: bob/.test(v!.replace(/\r\n /g, "")));
  assert.ok(!v!.includes("\\\\n"));
});

test("itemToVevent marks closed/canceled items as CANCELLED", () => {
  const v = itemToVevent(
    { id: "demo-3", title: "Done", status: "closed", deadline: "2026-06-10" },
    { uidDomain: "demo.pm-web", dtstamp: formatUtcTimestamp(NOW) },
  );
  assert.match(v!, /STATUS:CANCELLED/);
});

test("itemToVevent returns null when there is no usable deadline", () => {
  assert.equal(itemToVevent({ id: "x" }, { uidDomain: "d", dtstamp: "x" }), null);
  assert.equal(
    itemToVevent({ id: "x", deadline: "not-a-date" }, { uidDomain: "d", dtstamp: "x" }),
    null,
  );
});

test("buildIcsCalendar wraps events in a valid VCALENDAR and skips deadline-less items", () => {
  const ics = buildIcsCalendar(
    [
      { id: "demo-1", title: "Ship it", deadline: "2026-06-10" },
      { id: "demo-2", title: "No deadline" },
      { id: "demo-3", title: "Standup", deadline: "2026-06-11T15:30:00Z" },
    ],
    { calendarName: "pm · demo", uidDomain: "demo.pm-web", now: NOW },
  );
  // CRLF line endings
  assert.ok(ics.includes("\r\n"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /PRODID:-\/\/pm-web\/\/pm-cli calendar\/\/EN/);
  assert.match(ics, /X-WR-CALNAME:pm · demo/);
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  // exactly two VEVENTs (deadline-less item skipped)
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
});
