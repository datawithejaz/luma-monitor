"use strict";

/**
 * Compact alert-email shaping. Kept out of monitor.js so the body/subject
 * helpers can be unit-tested without triggering a live poll.
 */

const LONDON_TZ = "Europe/London";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function londonDateParts(iso) {
  const map = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: LONDON_TZ,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

/** e.g. "Thu 25 Sep" */
function formatCompactDay(iso) {
  if (!iso) return "TBC";
  const parts = londonDateParts(iso);
  const month = MONTHS_SHORT[Number(parts.month) - 1] || parts.month;
  return `${parts.weekday} ${parts.day} ${month}`;
}

/** e.g. "18:00" */
function formatCompactTime(iso) {
  if (!iso) return "TBC";
  const parts = londonDateParts(iso);
  return `${parts.hour}:${parts.minute}`;
}

/**
 * Keep the meta line short. Full street addresses blow up a one-liner card,
 * so prefer the first comma segment when it's a venue-sized name, else London.
 */
function formatPlace(venue) {
  const raw = (venue || "").trim();
  if (!raw) return "London";
  const first = raw.split(",")[0].trim();
  if (first && first.length <= 36) return first;
  return "London";
}

function formatCardPrice(event) {
  if (event.is_free || event.price_label === "FREE") return "Free";
  if (event.price_label) return event.price_label;
  return null;
}

/**
 * One event → three lines:
 *
 *   OpenAI Builder Lounge London
 *   Thu 25 Sep · 18:00 · London · Free
 *   https://lu.ma/event/...
 */
function formatEventCard(event) {
  const day = formatCompactDay(event.start_at);
  const time = formatCompactTime(event.start_at);
  const place = formatPlace(event.venue);
  const price = formatCardPrice(event);
  const meta = [day, time, place, price].filter(Boolean).join(" · ");
  return [event.name || "Untitled event", meta, event.url || ""].join("\n");
}

/** Subject: event name alone; batches use a plain count. */
function batchEmailSubject(events) {
  if (events.length === 1) return events[0].name || "New London event";
  return `${events.length} new London events`;
}

function formatAlertEmailBody(events) {
  return events.map(formatEventCard).join("\n\n");
}

module.exports = {
  formatCompactDay,
  formatCompactTime,
  formatPlace,
  formatCardPrice,
  formatEventCard,
  batchEmailSubject,
  formatAlertEmailBody,
};
