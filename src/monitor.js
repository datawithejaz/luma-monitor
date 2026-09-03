const https = require("https");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { discoverLondonCalendars } = require("./sitemap-discovery");
const {
  DEFAULT_REALERT_DAYS,
  buildSeriesHistory,
  chunkEvents,
  dedupeRecurringSeries,
  suppressAlertedSeries,
} = require("./alerting");
const {
  DEFAULT_DIGEST_DAYS,
  formatDigestEmail,
  selectPendingCalendars,
  shouldSendDigest,
} = require("./calendar-digest");

// ── Config ────────────────────────────────────────────────────────────────────
const SEEN_PATH = path.join(__dirname, "seen_events.json");
const META_PATH = path.join(__dirname, "event_meta.json");
const TRACKED_CALENDARS_PATH = path.join(__dirname, "tracked_calendars.json");
const KNOWN_CALENDARS_PATH = path.join(__dirname, "known_calendars.json");
const DIGEST_PATH = path.join(__dirname, "calendar_digest.json");
const LONDON_SLUG = "london";
const PAGINATION_LIMIT = 50; // lu.ma caps the discover API around 50 per page
const MAX_PAGES = 10; // safety cap: 10 x 50 = up to 500 events
// Ceiling on calendars polled per run. Applied to the final list, registry
// included, so it is a real timeout guard — at ~0.5s per calendar, 400 keeps a
// run well inside the workflow's 15-minute limit.
const MAX_CALENDARS_TO_POLL = 400;
const SITEMAP_BATCH_SIZE = 250; // sitemap slugs resolved per run (~35s)
// Keep each alert email small — one giant batch (40+) often lands in spam
// or gets quietly dropped even when SMTP accepts it.
const MAX_EVENTS_PER_EMAIL = 8;
// Don't re-alert a recurring series that already emailed within this many days.
// Set SERIES_REALERT_DAYS=0 to alert on every new date.
const SERIES_REALERT_DAYS = parseDaysEnv(
  process.env.SERIES_REALERT_DAYS,
  DEFAULT_REALERT_DAYS
);
// Weekly email of newly discovered calendars you don't follow yet.
// Set CALENDAR_DIGEST_DAYS=0 to disable.
const CALENDAR_DIGEST_DAYS = parseDaysEnv(
  process.env.CALENDAR_DIGEST_DAYS,
  DEFAULT_DIGEST_DAYS
);

function parseDaysEnv(raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : fallback;
}
const LONDON_TZ = "Europe/London";

// lu.ma's discover API is keyed by an internal place id, not the city slug.
// We resolve it live from the page; this is a fallback if resolution ever fails.
const FALLBACK_PLACE_ID = "discplace-QCcNk3HXowOR97j"; // London (verified 2026-06)

// An event is kept if name / host / description text matches at least one keyword
// (case-insensitive). Short tokens use word boundaries to avoid false positives
// (e.g. "ai" in "Saint"). Only applies to calendars you don't explicitly follow.
const CATEGORY_KEYWORDS = [
  "tech", "ai", "artificial intelligence", "marketing", "entrepreneurship",
  "entrepreneur", "founder", "business", "networking", "startup", "data",
  "product", "design", "developer", "coding", "hackathon", "workshop", "demo",
  "fintech", "vc", "venture", "seo", "cursor", "abrc",
  // Terms that were letting obvious matches slip through (builder evenings,
  // agent/LLM meetups, demo days, accelerator and infra events).
  "builder", "build", "agent", "agentic", "llm", "gpt", "copilot", "prompt",
  "engineer", "engineering", "software", "meetup", "pitch", "accelerator",
  "incubator", "saas", "b2b", "growth", "crypto", "web3", "robotics",
  "quantum", "devops", "infra", "infrastructure", "platform", "open source",
  "opensource", "community", "coworking", "reliability", "security", "cyber",
];

// Keywords that must match as whole words, not substrings inside other words.
const WORD_BOUNDARY_KEYWORDS = new Set([
  "ai", "vc", "seo", "data", "tech", "demo", "product", "design",
  "build", "agent", "llm", "gpt", "b2b", "infra", "cyber",
]);

// "ai" as a bare word misses the cases that matter most: OpenAI, GenAI, A.I.,
// AI/ML, #AI. Match those explicitly instead of loosening the word boundary,
// which would match "Saint", "Dubai", "chair", etc.
const AI_PATTERNS = [
  /\ba\.?\s?i\.?\b/i,
  /\b(?:open|gen|vertex|azure|safe|xet)ai\b/i,
  /\bai[-/](?:ml|native|first|agents?|engineer)/i,
  /\b(?:ml|mlops|genai|agi)\b/i,
];

const HEADERS = {
  "Accept": "application/json, text/html",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchText(url, redirectsLeft = 5, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { ...HEADERS, ...extraHeaders } }, (res) => {
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

async function fetchJSON(url, extraHeaders = {}) {
  const body = await fetchText(url, 5, extraHeaders);
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
      // Recorded so a later run can tell two identically titled series apart
      // when deciding whether one has already been alerted.
      host: event.host || null,
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

function loadTrackedCalendars() {
  try {
    const data = JSON.parse(fs.readFileSync(TRACKED_CALENDARS_PATH, "utf8"));
    return (data.calendars || []).map((cal) => ({
      api_id: cal.api_id,
      name: cal.name || "",
      slug: cal.slug || "",
      source: "manual",
      reason: cal.reason || "",
      include_all_events: cal.include_all_events === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Calendar api_ids where every in-person London event should alert.
 *
 * Following a calendar on Lu.ma is already a relevance signal, so tracked
 * calendars are trusted by default — keyword filtering them dropped things like
 * "OpenAI Builder Lounge London". Set `"keyword_filter": true` on a noisy
 * calendar to opt it back into the keyword check.
 */
function loadIncludeAllCalendarIds() {
  try {
    const data = JSON.parse(fs.readFileSync(TRACKED_CALENDARS_PATH, "utf8"));
    return new Set(
      (data.calendars || [])
        .filter((cal) => cal.api_id && cal.keyword_filter !== true)
        .map((cal) => cal.api_id)
    );
  } catch {
    return new Set();
  }
}

function loadKnownCalendars() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_CALENDARS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Turn the persisted registry into a pollable calendar list. */
function listKnownCalendars(registry) {
  return Object.values(registry)
    .filter((cal) => cal?.api_id)
    .map((cal) => ({
      api_id: cal.api_id,
      name: cal.name || "",
      slug: cal.slug || "",
      source: "known",
    }));
}

function saveKnownCalendars(registry) {
  const sorted = Object.fromEntries(
    Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(KNOWN_CALENDARS_PATH, JSON.stringify(sorted, null, 2));
}

function loadCalendarDigest() {
  try {
    return JSON.parse(fs.readFileSync(DIGEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCalendarDigest(digest) {
  fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2) + "\n");
}

function upsertCalendar(registry, cal) {
  if (!cal?.api_id) return;
  const existing = registry[cal.api_id];
  const isNew = !existing;
  const now = new Date().toISOString();
  // listKnownCalendars tags everything "known" on reload, which would wipe the
  // original discovery source (sitemap / discover / featured) that the weekly
  // digest uses. Prefer a specific incoming source, else keep the stored one.
  const incomingSource = cal.source && cal.source !== "known" ? cal.source : null;
  const storedSource =
    existing?.source && existing.source !== "known" ? existing.source : null;
  registry[cal.api_id] = {
    api_id: cal.api_id,
    name: cal.name || existing?.name || "",
    slug: cal.slug || existing?.slug || "",
    source: incomingSource || storedSource || cal.source || existing?.source || "unknown",
    reason: cal.reason || existing?.reason || "",
    last_seen_at: now,
    ...(existing?.london_event_count != null
      ? { london_event_count: existing.london_event_count }
      : {}),
  };
  // Only brand-new calendars get first_seen_at, so the first digest isn't a
  // dump of the whole pre-existing registry.
  const firstSeen = existing?.first_seen_at || (isNew ? now : undefined);
  if (firstSeen) registry[cal.api_id].first_seen_at = firstSeen;
}

function extractCalendarsFromEntries(entries, source) {
  const calendars = [];
  for (const entry of entries) {
    const cal = entry.calendar || {};
    const apiId = cal.api_id || entry.calendar_api_id;
    if (!apiId) continue;
    // Skip anonymous one-off "Personal" calendars — noisy and rarely hold hidden gems.
    if (cal.name === "Personal" && !cal.slug) continue;
    calendars.push({
      api_id: apiId,
      name: cal.name || "",
      slug: cal.slug || "",
      source,
    });
  }
  return calendars;
}

function isLondonEntry(entry) {
  const event = entry.event || entry;
  if (event.location_type === "online") return false;
  const geo = event.geo_address_info || {};
  const parts = [geo.city, geo.city_state, geo.full_address, geo.short_address]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return parts.includes("london");
}

function mergeCalendarList(...lists) {
  const registry = new Map();
  const priority = {
    manual: 0,
    subscription: 1,
    featured: 2,
    discover: 3,
    sitemap: 4,
    known: 5,
  };

  for (const list of lists) {
    for (const cal of list) {
      if (!cal?.api_id) continue;
      const existing = registry.get(cal.api_id);
      if (!existing || priority[cal.source] < priority[existing.source]) {
        registry.set(cal.api_id, { ...existing, ...cal });
      } else if (existing) {
        registry.set(cal.api_id, {
          ...existing,
          name: existing.name || cal.name,
          slug: existing.slug || cal.slug,
        });
      }
    }
  }

  return [...registry.values()].sort((a, b) => {
    const byPriority = priority[a.source] - priority[b.source];
    if (byPriority !== 0) return byPriority;
    return (a.name || a.api_id).localeCompare(b.name || b.api_id);
  });
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

/** Fetch Lu.ma calendars the signed-in user follows (requires LUMA_AUTH_COOKIE secret). */
async function fetchFollowingCalendars() {
  const cookie = process.env.LUMA_AUTH_COOKIE;
  if (!cookie) {
    console.log("LUMA_AUTH_COOKIE not set — skipping your Lu.ma calendar subscriptions.");
    return [];
  }

  try {
    const data = await fetchJSON("https://api.lu.ma/home/get-following-calendars", {
      Cookie: cookie,
    });
    // lu.ma returns `infos: [{ calendar, featured_events }]`; the others are
    // defensive fallbacks in case the shape changes again.
    const raw = data.infos || data.calendars || data.entries || data.items || [];
    const calendars = raw
      .map((item) => {
        const cal = item.calendar || item;
        return {
          api_id: cal.api_id,
          name: cal.name || "",
          slug: cal.slug || "",
          source: "subscription",
        };
      })
      .filter((cal) => cal.api_id);

    // A valid session with zero subscriptions is possible but unlikely — far more
    // likely the payload shape moved again, which would otherwise fail silently.
    if (calendars.length === 0) {
      console.warn(
        `Lu.ma subscriptions: 0 calendar(s) — unexpected payload shape? Top-level keys: ${Object.keys(data).join(", ")}`
      );
      return [];
    }

    console.log(`Lu.ma subscriptions: ${calendars.length} calendar(s)`);
    return calendars;
  } catch (err) {
    console.warn(`Could not fetch Lu.ma subscriptions (${err.message}).`);
    return [];
  }
}

/**
 * Walk a slice of Lu.ma's calendar sitemap looking for London calendars we
 * don't track yet. Disable with SKIP_SITEMAP_DISCOVERY=1.
 */
async function discoverCalendarsFromSitemap(alreadyKnown) {
  if (process.env.SKIP_SITEMAP_DISCOVERY === "1") {
    console.log("Sitemap discovery skipped (SKIP_SITEMAP_DISCOVERY=1).");
    return [];
  }

  const batchSize = Number(process.env.SITEMAP_BATCH_SIZE) || SITEMAP_BATCH_SIZE;
  const knownCalendarIds = new Set(alreadyKnown.map((cal) => cal.api_id).filter(Boolean));

  try {
    const { calendars } = await discoverLondonCalendars({ knownCalendarIds, batchSize });
    return calendars;
  } catch (err) {
    console.warn(`Sitemap discovery failed (${err.message}) — continuing without it.`);
    return [];
  }
}

/** Calendars featured on the London discover page (small curated list). */
async function fetchFeaturedCalendars(placeId) {
  try {
    const data = await fetchJSON(
      `https://api.lu.ma/discover/get-calendars?discover_place_api_id=${encodeURIComponent(placeId)}`
    );
    return (data.calendars || []).map((cal) => ({
      api_id: cal.api_id,
      name: cal.name || "",
      slug: cal.slug || "",
      source: "featured",
    }));
  } catch (err) {
    console.warn(`Could not fetch featured calendars (${err.message}).`);
    return [];
  }
}

/** Fetch all events published on a host calendar by api id. */
async function fetchCalendarItems(calendarId) {
  const data = await fetchJSON(
    `https://api.lu.ma/calendar/get-items?calendar_api_id=${encodeURIComponent(calendarId)}`
  );
  return data.entries || [];
}

function dedupeEntries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = entry.event?.api_id || entry.api_id;
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  return [...byId.values()];
}

/** Page through the London discover API and return raw entries. */
async function fetchDiscoverEntries(placeId) {
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

  console.log(`Discover feed: ${entries.length} events`);
  return entries;
}

/** Fetch events from every calendar we know about, not just the city discover feed. */
async function fetchAllSources(placeId) {
  const discover = await fetchDiscoverEntries(placeId);
  const manual = loadTrackedCalendars();
  const subscriptions = await fetchFollowingCalendars();
  const featured = await fetchFeaturedCalendars(placeId);
  const fromDiscover = extractCalendarsFromEntries(discover, "discover");
  const knownRegistry = loadKnownCalendars();
  const fromKnown = listKnownCalendars(knownRegistry);

  // Walk a slice of Lu.ma's sitemap each run to find London calendars that
  // never surface on the city page. Newly found ones join the registry below
  // and are polled on every subsequent run.
  const fromSitemap = await discoverCalendarsFromSitemap([
    ...manual,
    ...subscriptions,
    ...featured,
    ...fromDiscover,
    ...fromKnown,
  ]);

  const calendars = mergeCalendarList(
    manual,
    subscriptions,
    featured,
    fromDiscover,
    fromSitemap,
    fromKnown
  );
  let toPoll = [...calendars];

  // Always poll every calendar in the persisted registry, even if it dropped
  // off the London discover feed — that's the whole point of known_calendars.json.
  // Appended last so the cap below drops registry stragglers before anything
  // you actually follow.
  const polledIds = new Set(toPoll.map((cal) => cal.api_id));
  let addedFromRegistry = 0;
  for (const cal of fromKnown) {
    if (!polledIds.has(cal.api_id)) {
      toPoll.push(cal);
      polledIds.add(cal.api_id);
      addedFromRegistry++;
    }
  }
  if (addedFromRegistry > 0) {
    console.log(`Added ${addedFromRegistry} calendar(s) from known_calendars.json registry.`);
  }

  if (toPoll.length > MAX_CALENDARS_TO_POLL) {
    console.warn(
      `Calendar cap: polling ${MAX_CALENDARS_TO_POLL} of ${toPoll.length} ` +
        "(manual/subscription/featured/discover first, registry last)."
    );
    toPoll = toPoll.slice(0, MAX_CALENDARS_TO_POLL);
  }

  console.log(
    `Calendars to poll: ${toPoll.length} ` +
      `(manual ${manual.length}, subscriptions ${subscriptions.length}, ` +
      `featured ${featured.length}, discover ${fromDiscover.length}, ` +
      `sitemap ${fromSitemap.length}, known registry ${fromKnown.length})`
  );

  toPoll.forEach((cal) => upsertCalendar(knownRegistry, cal));
  saveKnownCalendars(knownRegistry);

  const merged = [...discover];

  for (const cal of toPoll) {
    try {
      const items = (await fetchCalendarItems(cal.api_id)).filter(isLondonEntry);
      merged.push(...items);
      if (knownRegistry[cal.api_id]) {
        knownRegistry[cal.api_id].london_event_count = items.length;
      }
      if (items.length > 0) {
        console.log(`  • ${cal.name || cal.api_id}: ${items.length} London event(s)`);
      }
    } catch (err) {
      console.warn(`  • ${cal.name || cal.api_id}: failed (${err.message})`);
    }
  }

  saveKnownCalendars(knownRegistry);

  const unique = dedupeEntries(merged);
  console.log(`Total unique events: ${unique.length} (discover ${discover.length}, +${unique.length - discover.length} from calendars)`);
  return { entries: unique, knownRegistry };
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
    calendar_api_id: calendar.api_id || entry.calendar_api_id || "",
    name: event.name || "",
    description: event.description_short || event.description_mirror?.text || "",
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

function matchesCategory(event, includeAllCalendarIds = new Set()) {
  if (event.calendar_api_id && includeAllCalendarIds.has(event.calendar_api_id)) {
    return true;
  }
  // Match on title, hosts and description — venue addresses cause false positives.
  const haystack = `${event.name} ${event.host} ${event.hosts_text} ${event.description}`.trim();
  if (AI_PATTERNS.some((re) => re.test(haystack))) return true;
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
  return `🟢 OPEN — check page for availability`;
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
    "",
    `📌 Event: ${event.name}`,
    `🏷 Host: ${event.host || "—"}`,
    "",
    "🗓 DATE & TIME",
    `• Day: ${day}`,
    `• Time: ${time}`,
    "",
    "📡 LISTED",
    `• Seen on Lu.ma London: ${formatListedOn(meta, event.api_id)}`,
    "",
    "📍 LOCATION",
    `• ${venue}`,
    "",
    "🎟 REGISTRATION",
    `• Status: ${formatRegistrationStatus(event)}`,
    `• Price: ${price}`,
    "",
    "🔗 LINK",
    event.url,
  ].join("\n");
}

/** Subject: single-event mails use the event name; batches keep a count summary. */
function batchEmailSubject(events) {
  if (events.length === 1) {
    return `🚨 ${events[0].name}`;
  }

  const openCount = events.filter((e) => registrationPriority(e) === 0).length;
  const count = events.length;
  let subject = `🚨 ${count} New Luma London Event${count > 1 ? "s" : ""}`;
  if (openCount > 0) subject += ` — ${openCount} Open for Registration`;
  else subject += " — Waitlist / Sold Out";
  return subject;
}

function createMailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

function describeSmtp(info) {
  const accepted = info?.accepted?.length ?? 0;
  const rejected = info?.rejected?.length ?? 0;
  return { accepted, rejected, response: info?.response || "no response" };
}

/** Send one batched email when multiple new events are found in the same run. */
async function alertNewEvents(events, seen, meta) {
  const transporter = createMailer();

  const sorted = [...events].sort((a, b) => registrationPriority(a) - registrationPriority(b));
  const chunks = chunkEvents(sorted, MAX_EVENTS_PER_EMAIL);
  let totalSent = 0;
  let emails = 0;

  for (const [index, chunk] of chunks.entries()) {
    const count = chunk.length;
    const batchLabel = chunks.length > 1 ? ` (part ${index + 1}/${chunks.length})` : "";

    const text =
      `${chunk.map((event) => formatEventBlock(event, meta)).join("\n\n")}\n\n` +
      `---\nLuma London: https://lu.ma/london`;

    const info = await transporter.sendMail({
      from: `"Luma Monitor" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject: batchEmailSubject(chunk) + batchLabel,
      text,
    });

    // Addresses are repo secrets, so log counts and the SMTP reply only — never
    // the recipient itself. Actions logs on a public repo are public.
    const { accepted, rejected, response } = describeSmtp(info);
    if (accepted === 0) {
      console.error(
        `❌ Email NOT accepted${batchLabel} — ${rejected} recipient(s) rejected. ` +
          `SMTP said: ${response}. Leaving ${count} event(s) ` +
          "unmarked so the next run retries them."
      );
      break;
    }

    const alertedAt = new Date().toISOString();
    chunk.forEach((event) => {
      seen.add(event.api_id);
      if (meta[event.api_id]) meta[event.api_id].first_alerted_at = alertedAt;
    });
    saveSeen(seen);
    saveMeta(meta);
    totalSent += count;
    emails++;
    console.log(
      `✅ Email sent — ${count} new event(s) in one message${batchLabel} ` +
        `[SMTP accepted ${accepted}, rejected ${rejected}: ${response}]`
    );
    chunk.forEach((event) => console.log(`   • ${event.name}`));
  }

  return { sent: totalSent, emails };
}

/**
 * Once a week, email newly discovered calendars that aren't in your follows.
 * Follow them on Lu.ma; the cookie sync writes them into tracked_calendars.json
 * on the next run. Nothing is added to the tracked list from here.
 */
async function maybeSendCalendarDigest(knownRegistry) {
  const digest = loadCalendarDigest();
  const trackedIds = new Set(loadTrackedCalendars().map((cal) => cal.api_id));
  const pending = selectPendingCalendars({
    registry: knownRegistry,
    trackedIds,
    lastSentAt: digest.last_sent_at || null,
  });
  const send = shouldSendDigest({
    lastSentAt: digest.last_sent_at || null,
    pendingCount: pending.length,
    intervalDays: CALENDAR_DIGEST_DAYS,
  });

  if (!send) {
    if (CALENDAR_DIGEST_DAYS <= 0) return;
    if (pending.length > 0) {
      console.log(
        `Calendar digest: ${pending.length} new untracked calendar(s) waiting ` +
          `(sends every ${CALENDAR_DIGEST_DAYS} day(s)).`
      );
    } else {
      console.log("Calendar digest: nothing new to follow this week.");
    }
    return;
  }

  console.log(`Calendar digest: ${pending.length} new untracked calendar(s).`);
  pending.forEach((cal) => {
    const url = cal.slug ? `https://lu.ma/${cal.slug}` : "(no slug)";
    console.log(`   • ${cal.name || cal.api_id} — ${cal.london_event_count ?? "?"} London event(s) — ${url}`);
  });

  if (!emailConfigured()) {
    console.warn(
      "⚠️  Email not configured — calendar digest not sent. " +
        "It will retry on the next run that still has pending calendars."
    );
    return;
  }

  const { subject, text } = formatDigestEmail(pending);
  const info = await createMailer().sendMail({
    from: `"Luma Monitor" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject,
    text,
  });
  const { accepted, rejected, response } = describeSmtp(info);
  if (accepted === 0) {
    console.error(
      `❌ Calendar digest NOT accepted — ${rejected} recipient(s) rejected. ` +
        `SMTP said: ${response}. Will retry next run.`
    );
    return;
  }

  saveCalendarDigest({
    last_sent_at: new Date().toISOString(),
    last_count: pending.length,
  });
  console.log(
    `✅ Calendar digest sent — ${pending.length} calendar(s) ` +
      `[SMTP accepted ${accepted}, rejected ${rejected}: ${response}]`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Starting Luma monitor...`);

  const seen = loadSeen();
  const meta = loadMeta();
  const placeId = await resolvePlaceId(LONDON_SLUG);
  const { entries, knownRegistry } = await fetchAllSources(placeId);

  const normalised = entries.map(normalise);
  const includeAllCalendars = loadIncludeAllCalendarIds();
  const inPerson = normalised.filter((e) => e.api_id && isInPerson(e));
  const upcoming = inPerson.filter(isUpcoming);
  const relevant = upcoming.filter((e) => matchesCategory(e, includeAllCalendars));

  if (includeAllCalendars.size > 0) {
    console.log(`Include-all calendars: ${includeAllCalendars.size}`);
  }

  console.log(`In-person: ${inPerson.length}`);
  console.log(`Upcoming (not started): ${upcoming.length}`);
  console.log(`Relevant after category filter: ${relevant.length}`);

  const newEvents = relevant.filter((e) => !seen.has(e.api_id));
  console.log(`New events: ${newEvents.length}`);

  if (newEvents.length > 0) {
    // Two passes: collapse series inside this batch, then drop series that an
    // earlier run already emailed. Each Lu.ma date is its own api_id, so a
    // weekly series otherwise mails you again every time a new date appears.
    const { toAlert: nearest, skipped } = dedupeRecurringSeries(newEvents);
    if (skipped.length > 0) {
      console.log(
        `Recurring series dedupe: ${skipped.length} later date(s) skipped ` +
          "(same series — keeping nearest upcoming only)."
      );
      skipped.forEach((event) =>
        console.log(`   ↳ skip: ${event.name} — ${event.start_at || "TBC"} (${event.api_id})`)
      );
    }

    const { toAlert, suppressed } = suppressAlertedSeries(nearest, buildSeriesHistory(meta), {
      windowDays: SERIES_REALERT_DAYS,
    });
    if (suppressed.length > 0) {
      console.log(
        `Series cooldown: ${suppressed.length} event(s) held back — already alerted ` +
          `within ${SERIES_REALERT_DAYS} day(s).`
      );
      suppressed.forEach(({ event, lastAlertedAt }) =>
        console.log(`   ↳ hold: ${event.name} (${event.api_id}) — last alerted ${lastAlertedAt}`)
      );
    }

    const quiet = [...skipped, ...suppressed.map((s) => s.event)];
    const detectedAt = new Date().toISOString();
    [...toAlert, ...quiet].forEach((event) => noteFirstSeen(meta, event, detectedAt));

    if (emailConfigured()) {
      // Marked seen without an alert, so they don't queue up for the next run.
      quiet.forEach((event) => seen.add(event.api_id));

      if (toAlert.length > 0) {
        const { sent, emails } = await alertNewEvents(toAlert, seen, meta);
        console.log(`Sent ${sent} event(s) across ${emails} email(s).`);
      } else {
        console.log("Nothing to email — every new event belonged to a series already alerted.");
      }
    } else {
      console.warn(
        "⚠️  Email not configured (set GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL secrets). " +
          `Found ${newEvents.length} new event(s); not recording them so they alert once email is set up.`
      );
      const sorted = [...toAlert].sort((a, b) => registrationPriority(a) - registrationPriority(b));
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
  await maybeSendCalendarDigest(knownRegistry);
  console.log(`Done. Seen pool: ${seen.size}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
