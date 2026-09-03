"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertPlausibleSync, mergeTracked } = require("./sync-tracked-calendars");

const sub = (n) => ({ api_id: `cal-${n}`, name: `Calendar ${n}`, slug: `c${n}` });
const tracked = (n) => ({ ...sub(n), reason: "User subscription" });

test("an empty follows list never overwrites the tracked file", () => {
  // How the `calendars` -> `infos` rename silently dropped 62 calendars.
  const existing = Array.from({ length: 64 }, (_, i) => tracked(i));
  assert.throws(
    () => assertPlausibleSync(existing, [], [existing[0]]),
    /returned 0 followed calendars/
  );
});

test("a sync that halves the list is refused", () => {
  const existing = Array.from({ length: 64 }, (_, i) => tracked(i));
  const subscriptions = Array.from({ length: 10 }, (_, i) => sub(i));
  const { merged } = mergeTracked(existing, subscriptions);
  assert.throws(() => assertPlausibleSync(existing, subscriptions, merged), /Refusing/);
});

test("ALLOW_TRACKED_SHRINK lets a real cleanup through", () => {
  const existing = Array.from({ length: 64 }, (_, i) => tracked(i));
  const subscriptions = Array.from({ length: 10 }, (_, i) => sub(i));
  const { merged } = mergeTracked(existing, subscriptions);

  process.env.ALLOW_TRACKED_SHRINK = "1";
  try {
    assert.doesNotThrow(() => assertPlausibleSync(existing, subscriptions, merged));
  } finally {
    delete process.env.ALLOW_TRACKED_SHRINK;
  }
});

test("a normal sync with one new follow passes", () => {
  const existing = Array.from({ length: 63 }, (_, i) => tracked(i));
  const subscriptions = Array.from({ length: 64 }, (_, i) => sub(i));
  const { merged, added } = mergeTracked(existing, subscriptions);

  assert.doesNotThrow(() => assertPlausibleSync(existing, subscriptions, merged));
  assert.equal(merged.length, 64);
  assert.equal(added.length, 64);
});

test("a first-ever sync onto an empty file is allowed", () => {
  const subscriptions = [sub(1)];
  const { merged } = mergeTracked([], subscriptions);
  assert.doesNotThrow(() => assertPlausibleSync([], subscriptions, merged));
});

test("include_all_events entries survive a sync that drops them", () => {
  const pinned = { api_id: "cal-abrc", name: "ABRC", slug: "abrc", include_all_events: true };
  const existing = [pinned, tracked(1)];
  const { merged } = mergeTracked(existing, [sub(1)]);
  assert.ok(merged.some((c) => c.api_id === "cal-abrc"));
});
