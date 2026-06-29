const https = require("https");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const SEEN_PATH = path.join(__dirname, "seen_events.json");
const LONDON_SLUG = "london";
const PAGINATION_LIMIT = 50; // lu.ma caps the discover API around 50 per page
const MAX_PAGES = 10; // safety cap: 10 x 50 = up to 500 events

// lu.ma's discover API is keyed by an internal place id, not the city slug.
// We resolve it live from the page; this is a fallback if resolution ever fails.
const FALLBACK_PLACE_ID = "discplace-QCcNk3HXowOR97j"; // London (verified 2026-06)

// An event is kept if its text matches at least one of these (case-insensitive).
const CATEGORY_KEYWORDS = [
  "tech", "ai", "artificial intelligence", "marketing", "entrepreneurship",
  "business", "networking", "startup", "data", "product", "design",
  "developer", "coding", "hackathon", "workshop", "demo",
];

const HEADERS = {
  "Accept": "application/json, text/html",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: HEADERS }, (res) => {
        const { statusCode, headers } = res;
        // lu.ma 301-redirects (e.g. lu.ma/london -> luma.com/london); follow it.
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const next = new URL(headers.location, url).toString();
          return resolve(fetchText(next, redirectsLeft - 1));
        }
        if (statusCode && statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function fetchJSON(url) {
  const body = await fetchText(url);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`JSON parse failed: ${body.slice(0, 200)}`);
  }
}

// ── Seen-state persistence ────────────────────────────────────────────────────
function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  // Sorted so the committed diff is deterministic (no spurious churn).
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].sort(), null, 2));
}

// ── lu.ma fetching ────────────────────────────────────────────────────────────
/** Resolve a city slug (e.g. "london") to its discover place id via __NEXT_DATA__. */
async function resolvePlaceId(slug) {
  try {
    const html = await fetchText(`https://lu.ma/${slug}`);
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error("__NEXT_DATA__ not found");
    const blob = JSON.parse(match[1]);
    const placeId = blob?.props?.pageProps?.initialData?.data?.place?.api_id;
    if (!placeId) throw new Error("place id not present in page data");
    return placeId;
  } catch (err) {
    console.warn(`Could not resolve place id for "${slug}" (${err.message}) — using fallback.`);
    return FALLBACK_PLACE_ID;
  }
}

/** Page through the discover API and return raw entries. */
async function fetchAllEntries(placeId) {
  const entries = [];
  let cursor = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let url =
      `https://api.lu.ma/discover/get-paginated-events` +
      `?discover_place_api_id=${encodeURIComponent(placeId)}` +
      `&pagination_limit=${PAGINATION_LIMIT}`;
    if (cursor) url += `&pagination_cursor=${encodeURIComponent(cursor)}`;

    console.log(`Fetching page ${page}...`);
    const data = await fetchJSON(url);
    const batch = data.entries || [];
    entries.push(...batch);

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  console.log(`Total fetched: ${entries.length} events`);
  return entries;
}

/** Flatten a raw discover entry into the fields this monitor cares about. */
function normalise(entry) {
  const event = entry.event || entry;
  const calendar = entry.calendar || {};
  const geo = event.geo_address_info || {};
  const slug = event.url || "";

  return {
    api_id: event.api_id || entry.api_id || "",
    name: event.name || "",
    url: slug ? `https://lu.ma/${slug}` : "",
    start_at: event.start_at || "",
    location_type: event.location_type || "",
    venue: geo.full_address || geo.city_state || geo.city || "",
    host: calendar.name || "",
    is_free: event.ticket_info ? event.ticket_info.is_free === true : null,
    price: event.ticket_info ? event.ticket_info.price : null,
  };
}

function isInPerson(event) {
  return event.location_type === "offline";
}

function matchesCategory(event) {
  const haystack = `${event.name} ${event.host} ${event.venue}`.toLowerCase();
  return CATEGORY_KEYWORDS.some((kw) => haystack.includes(kw));
}

// ── Email ─────────────────────────────────────────────────────────────────────
function emailConfigured() {
  return Boolean(
    process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.NOTIFY_EMAIL
  );
}

function formatEventEmail(events) {
  return events
    .map((e) => {
      const start = e.start_at
        ? new Date(e.start_at).toLocaleString("en-GB", { timeZone: "Europe/London" })
        : "TBC";
      const venue = e.venue || "London";
      const price = e.is_free ? "FREE" : e.price ? `£${e.price}` : "Check page";
      return [
        "🔴 NEW EVENT DETECTED",
        "━━━━━━━━━━━━━━━━━━━━",
        `📌 ${e.name}`,
        `📅 ${start}`,
        `📍 ${venue}`,
        `🎟  ${price}`,
        `🏷  ${e.host || "—"}`,
        `🔗 ${e.url}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function sendEmail(events) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const count = events.length;
  const subject = `🚨 ${count} New Luma London Event${count > 1 ? "s" : ""} — Register Now`;
  const text =
    `${count} new event${count > 1 ? "s" : ""} matching your criteria just appeared on Lu.ma London.\n\n` +
    `${formatEventEmail(events)}\n\n---\nLuma London: https://lu.ma/london`;

  await transporter.sendMail({
    from: `"Luma Monitor" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject,
    text,
  });
  console.log(`✅ Email sent — ${count} new event(s)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Starting Luma monitor...`);

  const seen = loadSeen();
  const placeId = await resolvePlaceId(LONDON_SLUG);
  const entries = await fetchAllEntries(placeId);

  const relevant = entries
    .map(normalise)
    .filter((e) => e.api_id && isInPerson(e) && matchesCategory(e));
  console.log(`Relevant after filter (in-person + category): ${relevant.length}`);

  const newEvents = relevant.filter((e) => !seen.has(e.api_id));
  console.log(`New events: ${newEvents.length}`);

  if (newEvents.length > 0) {
    if (emailConfigured()) {
      await sendEmail(newEvents);
      // Only mark events as seen once they've actually been emailed, so a run
      // without email configured (or a failed send) re-alerts on the next run.
      newEvents.forEach((e) => seen.add(e.api_id));
    } else {
      console.warn(
        "⚠️  Email not configured (set GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL secrets). " +
          `Found ${newEvents.length} new event(s); not recording them so they alert once email is set up.`
      );
      newEvents.forEach((e) => console.log(`   • ${e.name} — ${e.url}`));
    }
  } else {
    console.log("No new events.");
  }

  saveSeen(seen);
  console.log(`Done. Seen pool: ${seen.size}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
