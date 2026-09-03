"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSeriesHistory,
  chunkEvents,
  dedupeRecurringSeries,
  normalizeSeriesTitle,
  seriesKey,
  suppressAlertedSeries,
} = require("./alerting");

// Titles below are real ones this monitor has emailed. The duplicates they
// produced are what this module exists to stop.

test("numbered instalments collapse to one series", () => {
  const key = normalizeSeriesTitle("Open Code #20");
  assert.equal(normalizeSeriesTitle("Open Code #21"), key);
  assert.equal(normalizeSeriesTitle("Open Code #22"), key);
  assert.equal(normalizeSeriesTitle("Open Code"), key);
});

test("brand prefix and plural drift collapse to one series", () => {
  const variants = [
    "TRD: London Startups Operator RunClub & Social",
    "London Startups Operator RunClub & Social",
    "London Startup Operator RunClub & Social",
    "London Startup Operators RunClub & Social",
  ];
  const keys = new Set(variants.map(normalizeSeriesTitle));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(" | ")}`);
});

test("decimal editions and emoji collapse to one series", () => {
  assert.equal(
    normalizeSeriesTitle("TRD x BEYOND FITNESS Class 1.0 💪🔥🧡"),
    normalizeSeriesTitle("TRD x BEYOND FITNESS Class 2.0 💪🔥🧡")
  );
});

test("trailing month and year collapse to one series", () => {
  assert.equal(
    normalizeSeriesTitle("React Native London Meetup - September 2026"),
    normalizeSeriesTitle("React Native London Meetup - October 2026")
  );
});

test("genuinely different events stay separate", () => {
  assert.notEqual(
    normalizeSeriesTitle("AI on Draught: The Day Your AI Goes Wrong"),
    normalizeSeriesTitle("Side-project September: Get some writing done")
  );
  assert.notEqual(
    normalizeSeriesTitle("founder coworking + pizza night"),
    normalizeSeriesTitle("founder dinner + pizza night")
  );
});

test("a short title is not swallowed by brand-prefix stripping", () => {
  // Only two words survive the colon, so the prefix has to stay.
  assert.equal(normalizeSeriesTitle("Demo: Robotics Night"), "demo robotic night");
});

test("same title from different hosts is not one series", () => {
  const a = { api_id: "evt-a", name: "Coffee & Code", host: "PLUGGED" };
  const b = { api_id: "evt-b", name: "Coffee & Code", host: "Newspeak House" };
  assert.notEqual(seriesKey(a), seriesKey(b));
});

test("untitled events are never grouped together", () => {
  const a = { api_id: "evt-a", name: "", host: "PLUGGED" };
  const b = { api_id: "evt-b", name: null, host: "PLUGGED" };
  assert.notEqual(seriesKey(a), seriesKey(b));
});

test("dedupe keeps the earliest date of a series", () => {
  const events = [
    { api_id: "evt-22", name: "Open Code #22", host: "Open Code", start_at: "2026-10-01T18:00:00Z" },
    { api_id: "evt-20", name: "Open Code #20", host: "Open Code", start_at: "2026-09-04T18:00:00Z" },
    { api_id: "evt-21", name: "Open Code #21", host: "Open Code", start_at: "2026-09-18T18:00:00Z" },
    { api_id: "evt-x", name: "GenAI London", host: "GenAI", start_at: "2026-09-10T18:00:00Z" },
  ];

  const { toAlert, skipped } = dedupeRecurringSeries(events);

  assert.deepEqual(toAlert.map((e) => e.api_id).sort(), ["evt-20", "evt-x"]);
  assert.deepEqual(skipped.map((e) => e.api_id).sort(), ["evt-21", "evt-22"]);
});

test("events without a start date still survive dedupe", () => {
  const events = [
    { api_id: "evt-a", name: "Mystery Night", host: "H" },
    { api_id: "evt-b", name: "Other Thing", host: "H" },
  ];
  const { toAlert, skipped } = dedupeRecurringSeries(events);
  assert.equal(toAlert.length, 2);
  assert.equal(skipped.length, 0);
});

test("a series alerted recently is held back", () => {
  const meta = {
    "evt-old": {
      name: "TRD: London Startups Operator RunClub & Social",
      host: "The Run Down",
      first_alerted_at: "2026-09-03T14:40:37.812Z",
    },
  };
  const events = [
    {
      api_id: "evt-new",
      name: "London Startup Operators RunClub & Social",
      host: "The Run Down",
      start_at: "2026-09-20T18:00:00Z",
    },
  ];

  const { toAlert, suppressed } = suppressAlertedSeries(events, buildSeriesHistory(meta), {
    now: new Date("2026-09-03T15:12:11Z"),
    windowDays: 30,
  });

  assert.equal(toAlert.length, 0);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].lastAlertedAt, "2026-09-03T14:40:37.812Z");
});

test("a series alerted long ago resurfaces", () => {
  const meta = {
    "evt-old": {
      name: "Open Code #4",
      host: "Open Code",
      first_alerted_at: "2026-07-01T10:00:00.000Z",
    },
  };
  const events = [{ api_id: "evt-new", name: "Open Code #20", host: "Open Code" }];

  const { toAlert, suppressed } = suppressAlertedSeries(events, buildSeriesHistory(meta), {
    now: new Date("2026-09-03T15:00:00Z"),
    windowDays: 30,
  });

  assert.equal(toAlert.length, 1);
  assert.equal(suppressed.length, 0);
});

test("history entries with no host act as a wildcard", () => {
  // Everything written before `host` was recorded in event_meta.json.
  const meta = {
    "evt-legacy": { name: "Open Code #19", first_alerted_at: "2026-09-02T10:00:00.000Z" },
  };
  const events = [{ api_id: "evt-new", name: "Open Code #20", host: "Open Code" }];

  const { suppressed } = suppressAlertedSeries(events, buildSeriesHistory(meta), {
    now: new Date("2026-09-03T15:00:00Z"),
    windowDays: 30,
  });

  assert.equal(suppressed.length, 1);
});

test("a recent alert from a different host does not hold anything back", () => {
  const meta = {
    "evt-other": {
      name: "Coffee & Code",
      host: "Newspeak House",
      first_alerted_at: "2026-09-02T10:00:00.000Z",
    },
  };
  const events = [{ api_id: "evt-new", name: "Coffee & Code", host: "PLUGGED" }];

  const { toAlert, suppressed } = suppressAlertedSeries(events, buildSeriesHistory(meta), {
    now: new Date("2026-09-03T15:00:00Z"),
    windowDays: 30,
  });

  assert.equal(toAlert.length, 1);
  assert.equal(suppressed.length, 0);
});

test("seen-but-never-alerted events are not treated as history", () => {
  const meta = {
    "evt-held": { name: "Open Code #19", host: "Open Code", first_seen_at: "2026-09-02T10:00:00.000Z" },
  };
  assert.equal(buildSeriesHistory(meta).size, 0);
});

test("a zero window disables suppression", () => {
  const meta = {
    "evt-old": { name: "Open Code #19", host: "Open Code", first_alerted_at: "2026-09-03T10:00:00.000Z" },
  };
  const events = [{ api_id: "evt-new", name: "Open Code #20", host: "Open Code" }];

  const { toAlert, suppressed } = suppressAlertedSeries(events, buildSeriesHistory(meta), {
    now: new Date("2026-09-03T15:00:00Z"),
    windowDays: 0,
  });

  assert.equal(toAlert.length, 1);
  assert.equal(suppressed.length, 0);
});

test("a 41-event backlog splits into six emails", () => {
  const events = Array.from({ length: 41 }, (_, i) => ({ api_id: `evt-${i}` }));
  const chunks = chunkEvents(events, 8);

  assert.deepEqual(chunks.map((c) => c.length), [8, 8, 8, 8, 8, 1]);
  assert.equal(chunks.flat().length, 41);
});

test("chunking handles the common small cases", () => {
  assert.deepEqual(chunkEvents([], 8), []);
  assert.equal(chunkEvents([{ api_id: "a" }], 8).length, 1);
  assert.throws(() => chunkEvents([{ api_id: "a" }], 0), TypeError);
});
