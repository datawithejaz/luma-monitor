"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calendarUrl,
  formatDigestEmail,
  selectPendingCalendars,
  shouldSendDigest,
} = require("./calendar-digest");

const cal = (over = {}) => ({
  api_id: "cal-new",
  name: "five degrees",
  slug: "joinfivedegrees",
  source: "sitemap",
  first_seen_at: "2026-09-04T10:00:00.000Z",
  london_event_count: 3,
  ...over,
});

test("a newly discovered untracked calendar is pending", () => {
  const pending = selectPendingCalendars({
    registry: { "cal-new": cal() },
    trackedIds: new Set(),
    lastSentAt: null,
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].api_id, "cal-new");
});

test("already-followed calendars are omitted", () => {
  const pending = selectPendingCalendars({
    registry: { "cal-new": cal() },
    trackedIds: new Set(["cal-new"]),
    lastSentAt: null,
  });
  assert.equal(pending.length, 0);
});

test("legacy registry entries without first_seen_at are omitted", () => {
  const pending = selectPendingCalendars({
    registry: { "cal-old": cal({ first_seen_at: undefined }) },
    trackedIds: new Set(),
    lastSentAt: null,
  });
  assert.equal(pending.length, 0);
});

test("calendars already included in the last digest are omitted", () => {
  const pending = selectPendingCalendars({
    registry: { "cal-new": cal({ first_seen_at: "2026-09-03T10:00:00.000Z" }) },
    trackedIds: new Set(),
    lastSentAt: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(pending.length, 0);
});

test("calendars discovered after the last digest are pending", () => {
  const pending = selectPendingCalendars({
    registry: { "cal-new": cal({ first_seen_at: "2026-09-10T10:00:00.000Z" }) },
    trackedIds: new Set(),
    lastSentAt: "2026-09-04T10:00:00.000Z",
  });
  assert.equal(pending.length, 1);
});

test("manual and subscription sources are never suggested", () => {
  const pending = selectPendingCalendars({
    registry: {
      a: cal({ api_id: "a", source: "manual", first_seen_at: "2026-09-10T10:00:00.000Z" }),
      b: cal({ api_id: "b", source: "subscription", first_seen_at: "2026-09-10T10:00:00.000Z" }),
    },
    trackedIds: new Set(),
    lastSentAt: null,
  });
  assert.equal(pending.length, 0);
});

test("pending calendars sort by upcoming London event count", () => {
  const pending = selectPendingCalendars({
    registry: {
      a: cal({ api_id: "a", name: "Alpha", london_event_count: 1 }),
      b: cal({ api_id: "b", name: "Beta", london_event_count: 8 }),
      c: cal({ api_id: "c", name: "Gamma", london_event_count: 3 }),
    },
    trackedIds: new Set(),
    lastSentAt: null,
  });
  assert.deepEqual(pending.map((c) => c.api_id), ["b", "c", "a"]);
});

test("the first digest sends as soon as something is pending", () => {
  assert.equal(
    shouldSendDigest({ lastSentAt: null, pendingCount: 2, now: new Date("2026-09-04T10:00:00Z") }),
    true
  );
});

test("an empty week does not send", () => {
  assert.equal(
    shouldSendDigest({ lastSentAt: null, pendingCount: 0, now: new Date("2026-09-04T10:00:00Z") }),
    false
  );
});

test("a second digest waits the full interval", () => {
  const lastSentAt = "2026-09-04T10:00:00.000Z";
  assert.equal(
    shouldSendDigest({
      lastSentAt,
      pendingCount: 1,
      now: new Date("2026-09-10T09:00:00Z"),
      intervalDays: 7,
    }),
    false
  );
  assert.equal(
    shouldSendDigest({
      lastSentAt,
      pendingCount: 1,
      now: new Date("2026-09-11T10:00:00Z"),
      intervalDays: 7,
    }),
    true
  );
});

test("intervalDays of 0 disables the digest", () => {
  assert.equal(
    shouldSendDigest({ lastSentAt: null, pendingCount: 3, intervalDays: 0 }),
    false
  );
});

test("the email names the calendar and links to the follow page", () => {
  const { subject, text } = formatDigestEmail([cal()]);
  assert.match(subject, /five degrees/);
  assert.match(text, /Follow: https:\/\/lu\.ma\/joinfivedegrees/);
  assert.match(text, /3 upcoming London event\(s\)/);
  assert.match(text, /sitemap crawl/);
  assert.match(text, /tracked_calendars\.json automatically/);
});

test("a calendar without a slug is still listed", () => {
  const { text } = formatDigestEmail([cal({ slug: "" })]);
  assert.match(text, /no public slug/);
  assert.doesNotMatch(text, /Follow: https:\/\/lu\.ma\//);
});

test("calendarUrl encodes the slug", () => {
  assert.equal(calendarUrl({ slug: "Vibecoders.global" }), "https://lu.ma/Vibecoders.global");
  assert.equal(calendarUrl({ slug: "" }), null);
});
