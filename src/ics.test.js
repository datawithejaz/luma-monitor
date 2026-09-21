"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeText,
  toIcsUtc,
  foldLine,
  eventStatus,
  buildCalendar,
  PRODID,
} = require("./ics");
const { extractEntries, normaliseMyEvent, isUpcomingOrRecent } = require("./my-events");

describe("ics.escapeText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    assert.equal(escapeText("a\\b;c,d\ne"), "a\\\\b\\;c\\,d\\ne");
  });
});

describe("ics.toIcsUtc", () => {
  it("formats an ISO timestamp as YYYYMMDDTHHMMSSZ", () => {
    assert.equal(toIcsUtc("2026-09-04T17:30:00.000Z"), "20260904T173000Z");
  });

  it("returns null for empty / invalid input", () => {
    assert.equal(toIcsUtc(""), null);
    assert.equal(toIcsUtc("not-a-date"), null);
  });
});

describe("ics.foldLine", () => {
  it("leaves short lines alone", () => {
    assert.equal(foldLine("SUMMARY:Hello"), "SUMMARY:Hello");
  });

  it("folds long lines with a leading space on continuations", () => {
    const long = "DESCRIPTION:" + "x".repeat(80);
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    assert.ok(parts[0].length <= 75);
    assert.ok(parts[1].startsWith(" "));
    assert.equal(parts.join("").replace(/ /g, "").length, long.length);
  });
});

describe("ics.eventStatus", () => {
  it("maps approval statuses to VEVENT STATUS", () => {
    assert.equal(eventStatus("approved"), "CONFIRMED");
    assert.equal(eventStatus("pending"), "TENTATIVE");
    assert.equal(eventStatus("waitlist"), "TENTATIVE");
    assert.equal(eventStatus("declined"), "CANCELLED");
  });
});

describe("ics.buildCalendar", () => {
  const sample = [
    {
      api_id: "evt-aaa",
      name: "Open Code #21",
      start_at: "2026-09-10T18:00:00.000Z",
      end_at: "2026-09-10T20:00:00.000Z",
      venue: "Shoreditch, London",
      host: "Builders",
      url: "https://lu.ma/opencode",
      approval_status: "approved",
      description: "Bring a laptop",
    },
    {
      api_id: "evt-bbb",
      name: "Pending Meetup",
      start_at: "2026-09-12T12:00:00.000Z",
      end_at: "",
      venue: "",
      host: "",
      url: "https://lu.ma/pending",
      approval_status: "pending",
    },
  ];

  it("emits a VCALENDAR with one VEVENT per event", () => {
    const ics = buildCalendar(sample, { now: new Date("2026-09-04T12:00:00.000Z") });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /PRODID:-\/\/luma-monitor\/\/my-events\/\/EN/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.match(ics, /UID:evt-aaa@luma\.com/);
    assert.match(ics, /DTSTART:20260910T180000Z/);
    assert.match(ics, /DTEND:20260910T200000Z/);
    assert.match(ics, /STATUS:CONFIRMED/);
    assert.match(ics, /STATUS:TENTATIVE/);
    assert.match(ics, /LOCATION:Shoreditch\\, London/);
    assert.match(ics, /URL:https:\/\/lu\.ma\/opencode/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
    // Default 2h end when missing
    assert.match(ics, /DTSTART:20260912T120000Z/);
    assert.match(ics, /DTEND:20260912T140000Z/);
  });

  it("skips events without start_at", () => {
    const ics = buildCalendar([{ api_id: "evt-x", name: "Nope" }], {
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0);
  });

  it("exposes PRODID constant", () => {
    assert.match(PRODID, /luma-monitor/);
  });
});

describe("my-events.extractEntries", () => {
  it("reads common response shapes", () => {
    assert.equal(extractEntries({ entries: [1] }).length, 1);
    assert.equal(extractEntries({ events: [1, 2] }).length, 2);
    assert.equal(extractEntries({ items: [] }).length, 0);
    assert.equal(extractEntries(null).length, 0);
  });
});

describe("my-events.normaliseMyEvent", () => {
  it("flattens nested event + guest_data", () => {
    const n = normaliseMyEvent({
      event: {
        api_id: "evt-1",
        name: "Demo Night",
        url: "demo",
        start_at: "2026-09-05T18:00:00.000Z",
        end_at: "2026-09-05T21:00:00.000Z",
        timezone: "Europe/London",
        location_type: "offline",
        geo_address_info: { full_address: "1 Example St, London" },
        description_short: "Ship something",
      },
      calendar: { name: "Demo Cal" },
      guest_data: { approval_status: "approved" },
      hosts: [{ name: "Ada" }],
    });
    assert.equal(n.api_id, "evt-1");
    assert.equal(n.url, "https://lu.ma/demo");
    assert.equal(n.venue, "1 Example St, London");
    assert.equal(n.host, "Demo Cal");
    assert.equal(n.approval_status, "approved");
  });
});

describe("my-events.isUpcomingOrRecent", () => {
  it("keeps events that ended within the grace window", () => {
    const now = new Date("2026-09-04T15:00:00.000Z");
    assert.equal(
      isUpcomingOrRecent(
        { start_at: "2026-09-04T12:00:00.000Z", end_at: "2026-09-04T14:00:00.000Z" },
        now,
        3
      ),
      true
    );
    assert.equal(
      isUpcomingOrRecent(
        { start_at: "2026-09-03T12:00:00.000Z", end_at: "2026-09-03T14:00:00.000Z" },
        now,
        3
      ),
      false
    );
  });
});
