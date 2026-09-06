"use strict";

/**
 * Build a RFC 5545 iCalendar (.ics) document from normalised Lu.ma events.
 * Pure helpers — no network — so they can be unit-tested offline.
 */

const PRODID = "-//luma-monitor//my-events//EN";
const CAL_NAME = "My Luma Events";

/** Escape TEXT values per RFC 5545 §3.3.11. */
function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/** UTC timestamp as YYYYMMDDTHHMMSSZ. */
function toIcsUtc(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Fold content lines to ≤75 octets (RFC 5545 §3.1). ASCII-only for our fields,
 * so octet ≈ character. Continuation lines start with a single space.
 */
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

function eventStatus(approvalStatus) {
  const status = (approvalStatus || "").toLowerCase();
  if (status === "approved" || status === "confirmed") return "CONFIRMED";
  if (status === "declined" || status === "rejected") return "CANCELLED";
  // pending / waitlist / unknown — still show on the calendar
  return "TENTATIVE";
}

function buildDescription(event) {
  const lines = [];
  if (event.host) lines.push(`Host: ${event.host}`);
  if (event.approval_status) lines.push(`Registration: ${event.approval_status}`);
  if (event.url) lines.push(event.url);
  if (event.description) {
    lines.push("");
    lines.push(event.description);
  }
  return lines.join("\n");
}

function buildVEvent(event, nowUtc) {
  const uid = `${event.api_id || "unknown"}@luma.com`;
  const dtStart = toIcsUtc(event.start_at);
  if (!dtStart) return null;

  let dtEnd = toIcsUtc(event.end_at);
  if (!dtEnd) {
    // Default 2h if Lu.ma omitted end_at — better than a zero-length block.
    const startMs = new Date(event.start_at).getTime();
    dtEnd = toIcsUtc(new Date(startMs + 2 * 60 * 60 * 1000).toISOString());
  }

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${nowUtc}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeText(event.name || "Luma event")}`,
    `STATUS:${eventStatus(event.approval_status)}`,
  ];

  if (event.venue) lines.push(`LOCATION:${escapeText(event.venue)}`);
  const description = buildDescription(event);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * @param {Array<object>} events normalised my-events
 * @param {{ calName?: string, now?: Date }} [opts]
 * @returns {string} CRLF-terminated .ics body
 */
function buildCalendar(events, opts = {}) {
  const calName = opts.calName || CAL_NAME;
  const nowUtc = toIcsUtc((opts.now || new Date()).toISOString());
  const sorted = [...events]
    .filter((e) => e && e.start_at)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];

  for (const event of sorted) {
    const vevent = buildVEvent(event, nowUtc);
    if (vevent) lines.push(...vevent);
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

module.exports = {
  PRODID,
  CAL_NAME,
  escapeText,
  toIcsUtc,
  foldLine,
  eventStatus,
  buildCalendar,
};
