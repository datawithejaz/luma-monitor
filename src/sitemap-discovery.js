/**
 * Discover London calendars from Lu.ma's public sitemap.
 *
 * The city discover page (lu.ma/london) is capped at ~55 events, and calendar
 * polling only reaches calendars we already know about. That leaves a blind
 * spot: a London event on a calendar we've never seen is invisible, even
 * though Lu.ma lists it publicly.
 *
 * Lu.ma publishes every public calendar in sitemap-1.xml (~20k entries). This
 * module walks that list a batch at a time, newest-first, resolves each slug,
 * and reports the ones running London events so they can be added to the
 * polling registry permanently. A persisted cursor makes the crawl resumable
 * across runs, so a full pass completes over many runs instead of one long one.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SITEMAP_INDEX = "https://sitemap.luma.com/sitemap.xml";
const CRAWL_STATE_PATH = path.join(__dirname, "sitemap_crawl.json");

// Lu.ma rate-limits bursts, so keep concurrency low and pace each request.
// 250 slugs at these settings takes roughly 35s, well inside the job timeout.
const CONCURRENCY = 3;
const REQUEST_SPACING_MS = 250;
const DEFAULT_BATCH_SIZE = 250;

const HEADERS = {
  Accept: "application/json, application/xml, text/xml",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: HEADERS }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          return resolve(fetchText(new URL(headers.location, url).toString(), redirectsLeft - 1));
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

/** Pull `{ slug, lastmod }` pairs out of a sitemap urlset. */
function parseSitemapEntries(xml) {
  const entries = [];
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];

  for (const block of blocks) {
    const loc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    if (!loc) continue;
    let slug;
    try {
      const parts = new URL(loc[1]).pathname.split("/").filter(Boolean);
      if (parts.length !== 1) continue;
      slug = parts[0];
    } catch {
      continue;
    }
    if (!slug) continue;
    const lastmod = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i);
    entries.push({ slug, lastmod: lastmod ? lastmod[1] : "" });
  }

  return entries;
}

/** Sub-sitemap URLs listed in the sitemap index. */
function parseSitemapIndex(xml) {
  return [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/g)].map(
    (m) => m[1]
  );
}

function isLondonAddress(geo) {
  const parts = [geo?.city, geo?.city_state, geo?.full_address, geo?.short_address]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return parts.includes("london");
}

function loadCrawlState() {
  try {
    return JSON.parse(fs.readFileSync(CRAWL_STATE_PATH, "utf8"));
  } catch {
    return { cursor: 0, pass: 0, checked_at: null, london_calendars_found: 0 };
  }
}

function saveCrawlState(state) {
  fs.writeFileSync(CRAWL_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Resolve one slug to whatever Lu.ma has behind it (event or calendar).
 * Retries once after a pause: under burst load Lu.ma rejects a slice of
 * requests, and without a retry those slugs wait a whole pass to be seen again.
 */
async function resolveSlug(slug, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = await fetchText(`https://api.lu.ma/url?url=${encodeURIComponent(slug)}`);
      return JSON.parse(body);
    } catch {
      if (attempt < attempts) await sleep(REQUEST_SPACING_MS * 4);
    }
  }
  return null;
}

/**
 * Fetch the calendar sitemap, ordered newest-first so freshly updated
 * calendars are checked before stale ones.
 */
async function fetchCalendarSitemap() {
  const index = await fetchText(SITEMAP_INDEX);
  const subs = parseSitemapIndex(index);

  const entries = [];
  for (const sub of subs) {
    try {
      entries.push(...parseSitemapEntries(await fetchText(sub)));
    } catch (err) {
      console.warn(`  sitemap ${sub} failed (${err.message})`);
    }
  }

  const bySlug = new Map();
  for (const entry of entries) {
    const existing = bySlug.get(entry.slug);
    if (!existing || entry.lastmod > existing.lastmod) bySlug.set(entry.slug, entry);
  }

  return [...bySlug.values()].sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""));
}

/**
 * Check a batch of sitemap slugs for calendars running London events.
 *
 * @param {object} options
 * @param {Set<string>} options.knownCalendarIds calendars already polled
 * @param {number} options.batchSize slugs to resolve this run
 * @returns {Promise<{calendars: object[], stats: object}>}
 */
async function discoverLondonCalendars({ knownCalendarIds = new Set(), batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const state = loadCrawlState();
  const all = await fetchCalendarSitemap();

  if (all.length === 0) {
    console.warn("Sitemap returned no entries — skipping discovery crawl.");
    return { calendars: [], stats: { resolved: 0, batch: 0 } };
  }

  // Wrap around and start a fresh pass once the whole sitemap has been walked.
  let cursor = state.cursor || 0;
  if (cursor >= all.length) {
    cursor = 0;
    state.pass = (state.pass || 0) + 1;
    console.log(`Sitemap crawl completed pass ${state.pass} — restarting from newest.`);
  }

  const batch = all.slice(cursor, cursor + batchSize);
  const found = [];
  const seenThisRun = new Set();
  const stats = {
    resolved: 0,
    failed: 0,
    calendars: 0,
    events: 0,
    londonCalendars: 0,
    batch: batch.length,
  };

  const queue = [...batch];
  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      const resolved = await resolveSlug(entry.slug);
      await sleep(REQUEST_SPACING_MS);

      if (!resolved) {
        stats.failed++;
        continue;
      }
      stats.resolved++;

      // The sitemap mixes event and calendar slugs. Both are useful: a calendar
      // page shows whether it runs London events, and a London event page names
      // the calendar hosting it.
      const calendar = resolved.data?.calendar;
      if (!calendar?.api_id) continue;

      let hasLondonEvent = false;
      if (resolved.kind === "calendar") {
        stats.calendars++;
        const items = resolved.data?.upcoming?.entries || [];
        hasLondonEvent = items.some((item) => {
          const event = item.event || item;
          return event.location_type === "offline" && isLondonAddress(event.geo_address_info);
        });
      } else if (resolved.kind === "event") {
        stats.events++;
        const event = resolved.data || {};
        hasLondonEvent =
          event.location_type === "offline" && isLondonAddress(event.geo_address_info);
      }

      const isLondonCalendar = (calendar.geo_city || "").toLowerCase().includes("london");
      if (!hasLondonEvent && !isLondonCalendar) continue;
      stats.londonCalendars++;

      if (knownCalendarIds.has(calendar.api_id) || seenThisRun.has(calendar.api_id)) continue;
      seenThisRun.add(calendar.api_id);
      found.push({
        api_id: calendar.api_id,
        name: calendar.name || "",
        slug: calendar.slug || "",
        source: "sitemap",
        reason: "Sitemap discovery — runs London events",
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  saveCrawlState({
    ...state,
    cursor: cursor + batch.length,
    total_slugs: all.length,
    checked_at: new Date().toISOString(),
    london_calendars_found: (state.london_calendars_found || 0) + found.length,
  });

  const progress = `${cursor + batch.length}/${all.length}`;
  console.log(
    `Sitemap crawl ${progress}: resolved ${stats.resolved}, ` +
      `${stats.londonCalendars} London calendar(s), ${found.length} new`
  );
  found.forEach((cal) => console.log(`  + discovered ${cal.name || cal.api_id} (${cal.slug})`));

  return { calendars: found, stats };
}

module.exports = {
  discoverLondonCalendars,
  fetchCalendarSitemap,
  parseSitemapEntries,
  parseSitemapIndex,
  isLondonAddress,
  loadCrawlState,
};
