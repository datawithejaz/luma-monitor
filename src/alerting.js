"use strict";

/**
 * Alert shaping: collapsing recurring listings into one notification and slicing
 * batches into sendable emails.
 *
 * Kept out of monitor.js because that file runs a live poll on require, so none
 * of this could otherwise be unit-tested. See alerting.test.js.
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
];

const WEEKDAYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

// Markers that separate one instalment of a series from the next. Lu.ma gives
// every date its own api_id, so "Open Code #20" and "Open Code #21" are distinct
// events that should still collapse to a single alert.
const EDITION_PATTERNS = [
  /#\s*\d+/g,                      // Open Code #20
  /\bvol(?:ume)?\.?\s*\d+/g,       // vol. 3
  /\bpart\s*\d+/g,
  /\bep(?:isode)?\.?\s*\d+/g,
  /\b(?:no|nr)\.?\s*\d+/g,
  /\bweek\s*\d+/g,
  /\bday\s*\d+/g,
  /\b\d+\.\d+\b/g,                 // Class 2.0
  /\b\d{1,2}(?:st|nd|rd|th)\b/g,   // 4th London Meetup
  /\b(?:19|20)\d{2}\b/g,           // years
  new RegExp(`\\b(?:${MONTHS.join("|")})\\b`, "g"),
  new RegExp(`\\b(?:${WEEKDAYS.join("|")})\\b`, "g"),
];

const DEFAULT_REALERT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Hosts bolt a brand onto some instalments and not others ("TRD: London
 * Startups Operator RunClub" vs "London Startups Operator RunClub"). Drop a
 * short leading "Brand:" as long as enough of the title survives to identify it.
 */
function stripBrandPrefix(text) {
  const match = text.match(/^([^:]{1,24}):\s*(.+)$/);
  if (!match) return text;
  const remainder = match[2].trim();
  if (remainder.split(/\s+/).length < 3) return text;
  return remainder;
}

/**
 * Crude singularisation, so "Startups"/"Startup" and "Operators"/"Operator"
 * reach the same key. Only equality matters here — this never reaches a subject
 * line or an email body.
 */
function stemToken(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function normalizeSeriesTitle(name) {
  let text = (name || "").toLowerCase();
  text = stripBrandPrefix(text);
  for (const pattern of EDITION_PATTERNS) text = text.replace(pattern, " ");
  return text
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stemToken)
    .join(" ");
}

function normalizeSeriesHost(host) {
  return (host || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stemToken)
    .join(" ");
}

/** Key for a recurring series: normalised title plus the organiser. */
function seriesKey(event) {
  const title = normalizeSeriesTitle(event.name);
  // An untitled event can't be grouped — keep it unique rather than collapsing
  // every nameless listing into one bucket.
  if (!title) return `id::${event.api_id}`;
  return `${title}::${normalizeSeriesHost(event.host)}`;
}

function compareByStartAt(a, b) {
  if (!a.start_at && !b.start_at) return 0;
  if (!a.start_at) return 1;
  if (!b.start_at) return -1;
  return new Date(a.start_at) - new Date(b.start_at);
}

/**
 * Collapse a single run's new events to one per series, keeping the earliest
 * date. Guards against one email repeating the same listing several times over.
 */
function dedupeRecurringSeries(events) {
  const groups = new Map();
  for (const event of events) {
    const key = seriesKey(event);
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }

  const toAlert = [];
  const skipped = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      toAlert.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(compareByStartAt);
    toAlert.push(sorted[0]);
    skipped.push(...sorted.slice(1));
  }

  return { toAlert, skipped };
}

/**
 * Index previously alerted events by series, from event_meta.json.
 *
 * Entries written before this file existed have no `host`, so the host is left
 * null and treated as a wildcard when matching — the alternative is losing all
 * history on the first run.
 */
function buildSeriesHistory(meta) {
  const history = new Map();
  for (const entry of Object.values(meta || {})) {
    if (!entry || !entry.first_alerted_at) continue;
    const title = normalizeSeriesTitle(entry.name);
    if (!title) continue;
    const list = history.get(title) || [];
    list.push({
      host: entry.host ? normalizeSeriesHost(entry.host) : null,
      alertedAt: entry.first_alerted_at,
    });
    history.set(title, list);
  }
  return history;
}

/**
 * Hold back events whose series was already alerted recently. Without this,
 * a weekly series emails you again every time the host publishes another date,
 * because each date is a new api_id that no single run ever sees together.
 *
 * A window rather than a permanent block, so a long-running series resurfaces
 * eventually instead of going silent forever.
 */
function suppressAlertedSeries(events, history, options = {}) {
  const { now = new Date(), windowDays = DEFAULT_REALERT_DAYS } = options;
  if (!(windowDays > 0)) return { toAlert: [...events], suppressed: [] };

  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const toAlert = [];
  const suppressed = [];

  for (const event of events) {
    const title = normalizeSeriesTitle(event.name);
    const host = normalizeSeriesHost(event.host);
    const candidates = history.get(title) || [];

    let latest = null;
    for (const past of candidates) {
      // Null host on either side means we can't tell them apart; treat as a match.
      if (past.host && host && past.host !== host) continue;
      const alertedAt = Date.parse(past.alertedAt);
      if (!Number.isFinite(alertedAt) || alertedAt < cutoff) continue;
      if (latest === null || alertedAt > Date.parse(latest)) latest = past.alertedAt;
    }

    if (latest) suppressed.push({ event, lastAlertedAt: latest });
    else toAlert.push(event);
  }

  return { toAlert, suppressed };
}

/** Split a batch into email-sized slices. */
function chunkEvents(events, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError(`chunkEvents: size must be a positive integer, got ${size}`);
  }
  const chunks = [];
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  DEFAULT_REALERT_DAYS,
  buildSeriesHistory,
  chunkEvents,
  compareByStartAt,
  dedupeRecurringSeries,
  normalizeSeriesHost,
  normalizeSeriesTitle,
  seriesKey,
  suppressAlertedSeries,
};
