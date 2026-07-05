const https = require("https");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const SEEN_PATH = path.join(__dirname, "seen_events.json");
const META_PATH = path.join(__dirname, "event_meta.json");
const LONDON_SLUG = "london";
const PAGINATION_LIMIT = 50; // lu.ma caps the discover API around 50 per page
const MAX_PAGES = 10; // safety cap: 10 x 50 = up to 500 events
// Send at most one alert per workflow run so bursts don't hit your inbox all at once.
// Additional new events stay queued and alert on subsequent runs (~5–15 min apart).
const MAX_ALERTS_PER_RUN = 1;
const LONDON_TZ = "Europe/London";

// lu.ma's discover API is keyed by an internal place id, not the city slug.
// We resolve it live from the page; this is a fallback if resolution ever fails.
const FALLBACK_PLACE_ID = "discplace-QCcNk3HXowOR97j"; // London (verified 2026-06)

// An event is kept if name / host text matches at least one keyword (case-insensitive).
// Short tokens use word boundaries to avoid false positives (e.g. "ai" in "Saint").
const CATEGORY_KEYWORDS = [
  "tech", "ai", "artificial intelligence", "marketing", "entrepreneurship",
  "entrepreneur", "founder", "business", "networking", "startup", "data",
  "product", "design", "developer", "coding", "hackathon", "workshop", "demo",
  "fintech", "vc", "venture", "seo",
];

// Keywords that must match as whole words, not substrings inside other words.
const WORD_BOUNDARY_KEYWORDS = new Set([
  "ai", "vc", "seo", "data", "tech", "demo", "product", "design",
]);

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

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  const sorted = Object.fromEntries(
    Object.entries(meta).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(META_PATH, JSON.stringify(sorted, null, 2));
}

function noteFirstSeen(meta, event, iso) {
  if (!meta[event.api_id]) {
    meta[event.api_id] = {
      name: event.name,
      first_seen_at: iso,
    };
  }
}

function formatLondonDay(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: LONDON_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatLondonTime(iso) {
  return (
    new Date(iso).toLocaleTimeString("en-GB", {
      timeZone: LONDON_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " (London)"
  );
}

function formatLondonDateTime(iso) {
  return `${formatLondonDay(iso)} at ${formatLondonTime(iso)}`;
}

function formatEventSchedule(event) {
  if (!event.start_at) return { day: "TBC", time: "TBC" };
  return {
    day: formatLondonDay(event.start_at),
    time: formatLondonTime(event.start_at),
  };
}

function formatListedOn(meta, apiId) {
  const entry = meta[apiId];
  if (!entry?.first_seen_at) return "Just detected this run";
  return formatLondonDateTime(entry.first_seen_at);
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

    // Stop when there is no cursor or the API returns an empty page.
    // Don't rely on has_more alone — Lu.ma sometimes sets has_more=false while
    // still returning a next_cursor.
    if (!data.next_cursor || batch.length === 0) break;
    cursor = data.next_cursor;
  }

  console.log(`Total fetched: ${entries.length} events`);
  return entries;
}

function formatPrice(ticket) {
  if (!ticket) return null;
  if (ticket.is_free) return "FREE";
  const price = ticket.price;
  if (!price || price.cents == null) return null;
  const amount = price.cents / 100;
  const currency = (price.currency || "gbp").toUpperCase();
  if (currency === "GBP") return `£${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
  return `${amount} ${currency}`;
}

/** Flatten a raw discover entry into the fields this monitor cares about. */
function normalise(entry) {
  const event = entry.event || entry;
  const calendar = entry.calendar || {};
  const geo = event.geo_address_info || {};
  const slug = event.url || "";
  const ticket = entry.ticket_info || {};
  const hostNames = (entry.hosts || [])
    .map((h) => h.name || h.user?.name || "")
    .filter(Boolean)
    .join(" ");

  return {
    api_id: event.api_id || entry.api_id || "",
    name: event.name || "",
    url: slug ? `https://lu.ma/${slug}` : "",
    start_at: event.start_at || entry.start_at || "",
    location_type: event.location_type || "",
    venue: geo.full_address || geo.city_state || geo.city || "",
    host: calendar.name || hostNames || "",
    hosts_text: hostNames,
    is_free: ticket.is_free === true,
    price_label: formatPrice(ticket),
    registration_availability: entry.registration_availability || "",
    is_sold_out: ticket.is_sold_out === true,
    spots_remaining: ticket.spots_remaining ?? null,
    is_near_capacity: ticket.is_near_capacity === true,
  };
}

function isInPerson(event) {
  return event.location_type === "offline";
}

function isUpcoming(event) {
  if (!event.start_at) return true;
  return new Date(event.start_at) >= new Date();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(haystack, kw) {
  const lower = haystack.toLowerCase();
  const token = kw.toLowerCase();

  if (token.includes(" ")) return lower.includes(token);

  if (WORD_BOUNDARY_KEYWORDS.has(token)) {
    return new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(lower);
  }

  return lower.includes(token);
}

function matchesCategory(event) {
  // Match on title and hosts only — venue addresses cause false positives.
  const haystack = `${event.name} ${event.host} ${event.hosts_text}`.trim();
  return CATEGORY_KEYWORDS.some((kw) => keywordMatches(haystack, kw));
}

function registrationPriority(event) {
  if (event.is_sold_out || event.registration_availability === "sold-out") return 2;
  if (event.registration_availability === "waitlist") return 1;
  return 0;
}

function formatRegistrationStatus(event) {
  if (event.is_sold_out || event.registration_availability === "sold-out") {
    return "🔴 SOLD OUT — join waitlist on page";
  }
  if (event.registration_availability === "waitlist") {
    return "🟡 WAITLIST — registration full, waitlist open";
  }
  if (event.is_near_capacity) {
    const spots =
      event.spots_remaining != null ? ` (${event.spots_remaining} spots left)` : "";
    return `🟠 NEAR CAPACITY${spots} — register soon`;
  }
  if (event.spots_remaining != null && event.spots_remaining > 0) {
    return `🟢 OPEN — ${event.spots_remaining} spot${event.spots_remaining === 1 ? "" : "s"} left`;
  }
  if (event.registration_availability === "open") {
    return "🟢 OPEN — registration available";
  }
  return "🟢 OPEN — check page for availability";
}

// ── Email ─────────────────────────────────────────────────────────────────────
function emailConfigured() {
  return Boolean(
    process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.NOTIFY_EMAIL
  );
}

function formatEventBlock(event, meta) {
  const { day, time } = formatEventSchedule(event);
  const venue = event.venue || "London";
  const price = event.price_label || "Check page";
  return [
    "🔴 NEW EVENT DETECTED",
    "━━━━━━━━━━━━━━━━━━━━",
    `📌 ${event.name}`,
    `📅 Day:   ${day}`,
    `🕐 Time:  ${time}`,
    `📡 Listed on Lu.ma London: ${formatListedOn(meta, event.api_id)}`,
    `📍 ${venue}`,
    `🎟  ${price}`,
    `📋 ${formatRegistrationStatus(event)}`,
    `🏷  ${event.host || "—"}`,
    `🔗 ${event.url}`,
  ].join("\n");
}

function eventEmailSubject(event) {
  const priority = registrationPriority(event);
  let subject = `🚨 New: ${event.name}`;
  if (subject.length > 90) subject = `${subject.slice(0, 87)}...`;
  if (priority === 0) return `${subject} — Register Now`;
  if (priority === 1) return `${subject} — Waitlist`;
  return `${subject} — Sold Out`;
}

/** Send one email per event in the batch (usually one per run). */
async function alertNewEvents(events, seen, meta) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  const sorted = [...events].sort((a, b) => registrationPriority(a) - registrationPriority(b));
  let sent = 0;

  for (const event of sorted) {
    const text =
      "A new event matching your criteria just appeared on Lu.ma London.\n\n" +
      `${formatEventBlock(event, meta)}\n\n---\nLuma London: https://lu.ma/london`;

    await transporter.sendMail({
      from: `"Luma Monitor" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject: eventEmailSubject(event),
      text,
    });

    seen.add(event.api_id);
    if (meta[event.api_id]) {
      meta[event.api_id].first_alerted_at = new Date().toISOString();
    }
    saveSeen(seen);
    saveMeta(meta);
    sent++;
    console.log(`✅ Email sent — ${event.name}`);
  }

  return sent;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Starting Luma monitor...`);

  const seen = loadSeen();
  const meta = loadMeta();
  const placeId = await resolvePlaceId(LONDON_SLUG);
  const entries = await fetchAllEntries(placeId);

  const normalised = entries.map(normalise);
  const inPerson = normalised.filter((e) => e.api_id && isInPerson(e));
  const upcoming = inPerson.filter(isUpcoming);
  const relevant = upcoming.filter(matchesCategory);

  console.log(`In-person: ${inPerson.length}`);
  console.log(`Upcoming (not started): ${upcoming.length}`);
  console.log(`Relevant after category filter: ${relevant.length}`);

  const newEvents = relevant.filter((e) => !seen.has(e.api_id));
  console.log(`New events: ${newEvents.length}`);

  if (newEvents.length > 0) {
    const sorted = [...newEvents].sort((a, b) => registrationPriority(a) - registrationPriority(b));
    const detectedAt = new Date().toISOString();
    sorted.forEach((event) => noteFirstSeen(meta, event, detectedAt));
    saveMeta(meta);

    const toAlert = sorted.slice(0, MAX_ALERTS_PER_RUN);
    const queued = sorted.length - toAlert.length;
    if (queued > 0) {
      console.log(
        `Queueing ${queued} additional new event(s) for upcoming runs (max ${MAX_ALERTS_PER_RUN} alert per run).`
      );
    }

    if (emailConfigured()) {
      const sent = await alertNewEvents(toAlert, seen, meta);
      console.log(`Sent ${sent} alert(s) this run.`);
    } else {
      console.warn(
        "⚠️  Email not configured (set GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL secrets). " +
          `Found ${newEvents.length} new event(s); not recording them so they alert once email is set up.`
      );
      sorted.forEach((e) =>
        console.log(
          `   • ${e.name} — listed ${formatListedOn(meta, e.api_id)} — ${formatRegistrationStatus(e)} — ${e.url}`
        )
      );
    }
  } else {
    console.log("No new events.");
  }

  saveSeen(seen);
  saveMeta(meta);
  console.log(`Done. Seen pool: ${seen.size}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
