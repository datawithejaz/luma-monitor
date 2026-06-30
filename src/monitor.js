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

function formatEventEmail(events) {
  return events
    .map((e) => {
      const start = e.start_at
        ? new Date(e.start_at).toLocaleString("en-GB", { timeZone: "Europe/London" })
        : "TBC";
      const venue = e.venue || "London";
      const price = e.price_label || "Check page";
      return [
        "🔴 NEW EVENT DETECTED",
        "━━━━━━━━━━━━━━━━━━━━",
        `📌 ${e.name}`,
        `📅 ${start}`,
        `📍 ${venue}`,
        `🎟  ${price}`,
        `📋 ${formatRegistrationStatus(e)}`,
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

  const sorted = [...events].sort((a, b) => registrationPriority(a) - registrationPriority(b));
  const openCount = sorted.filter((e) => registrationPriority(e) === 0).length;
  const count = sorted.length;

  let subject = `🚨 ${count} New Luma London Event${count > 1 ? "s" : ""}`;
  if (openCount > 0) {
    subject += ` — ${openCount} Open for Registration`;
  } else {
    subject += " — Waitlist / Sold Out";
  }

  const text =
    `${count} new upcoming event${count > 1 ? "s" : ""} matching your criteria on Lu.ma London.\n` +
    `Sorted with open registration first.\n\n` +
    `${formatEventEmail(sorted)}\n\n---\nLuma London: https://lu.ma/london`;

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
      const sorted = [...newEvents].sort((a, b) => registrationPriority(a) - registrationPriority(b));
      sorted.forEach((e) =>
        console.log(`   • ${e.name} — ${formatRegistrationStatus(e)} — ${e.url}`)
      );
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
