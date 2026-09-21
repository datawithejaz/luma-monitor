"use strict";

/**
 * Fetch events the signed-in user is registered for (or hosting) via
 * home/get-events. Requires LUMA_AUTH_COOKIE.
 *
 * Privacy: returns structured event objects for local ICS / filtering only —
 * never commit the raw payload or generated .ics to a public repo.
 */

const https = require("https");

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

const GET_EVENTS_URLS = [
  "https://api.lu.ma/home/get-events?period=future",
  "https://api.lu.ma/home/get-events?period=upcoming",
  "https://api.lu.ma/home/get-events",
];

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { ...HEADERS, ...extraHeaders } }, (res) => {
        const { statusCode } = res;
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (statusCode && statusCode >= 400) {
            return reject(new Error(`HTTP ${statusCode} for ${url}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

function authHeaders() {
  const cookie = process.env.LUMA_AUTH_COOKIE;
  if (!cookie) {
    throw new Error(
      "LUMA_AUTH_COOKIE is not set. Add it as a GitHub Actions secret or export it locally."
    );
  }
  return { Cookie: cookie };
}

/** Pull the list of entry objects out of whichever shape Lu.ma returned. */
function extractEntries(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.infos)) return payload.infos;
  return [];
}

/**
 * Flatten a home/get-events entry (or event/get payload) into the fields the
 * ICS exporter and the monitor's skip-filter need.
 */
function normaliseMyEvent(entry) {
  const event = entry.event || entry;
  const calendar = entry.calendar || {};
  const geo = event.geo_address_info || {};
  const guest =
    entry.guest_data ||
    entry.guest ||
    event.guest_data ||
    {};
  const slug = event.url || "";
  const hostNames = (entry.hosts || [])
    .map((h) => h.name || h.user?.name || "")
    .filter(Boolean)
    .join(", ");

  return {
    api_id: event.api_id || entry.api_id || "",
    name: event.name || "",
    description: event.description_short || "",
    url: slug ? `https://lu.ma/${slug}` : "",
    start_at: event.start_at || entry.start_at || "",
    end_at: event.end_at || entry.end_at || "",
    timezone: event.timezone || "Europe/London",
    location_type: event.location_type || "",
    venue:
      geo.full_address ||
      geo.address ||
      geo.city_state ||
      geo.city ||
      "",
    host: calendar.name || hostNames || "",
    approval_status:
      guest.approval_status ||
      entry.approval_status ||
      entry.rsvp_status ||
      "",
  };
}

/**
 * Fetch registered/hosted events. Tries known period query variants until one
 * returns 200 (same approach as probe_auth.js).
 *
 * @returns {Promise<{ events: object[], sourceUrl: string }>}
 */
async function fetchMyEvents() {
  const headers = authHeaders();
  let lastError = null;

  for (const url of GET_EVENTS_URLS) {
    try {
      const data = await fetchJSON(url, headers);
      const entries = extractEntries(data);
      const events = entries
        .map(normaliseMyEvent)
        .filter((e) => e.api_id && e.start_at);
      return { events, sourceUrl: url };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("home/get-events failed for every parameter variant");
}

/** Just the api_id set — for the monitor's "already going" filter. */
async function fetchMyEventIds() {
  const { events } = await fetchMyEvents();
  return new Set(events.map((e) => e.api_id));
}

function isUpcomingOrRecent(event, now = new Date(), graceHours = 3) {
  if (!event.end_at && !event.start_at) return true;
  const end = new Date(event.end_at || event.start_at);
  if (Number.isNaN(end.getTime())) return true;
  return end.getTime() + graceHours * 60 * 60 * 1000 >= now.getTime();
}

module.exports = {
  GET_EVENTS_URLS,
  extractEntries,
  normaliseMyEvent,
  fetchMyEvents,
  fetchMyEventIds,
  isUpcomingOrRecent,
};
