"use strict";

/**
 * Weekly digest of London calendars the sitemap/discover feed found that you
 * don't follow yet. Follow the ones you want on Lu.ma — the existing cookie
 * sync then writes them into tracked_calendars.json on the next run.
 *
 * Kept out of monitor.js so the selection rules can be unit-tested. See
 * calendar-digest.test.js.
 */

const DEFAULT_DIGEST_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SOURCE_LABELS = {
  sitemap: "sitemap crawl",
  discover: "London discover feed",
  featured: "featured on lu.ma/london",
  subscription: "your Lu.ma follows",
  manual: "tracked list",
  known: "calendar registry",
};

function calendarUrl(cal) {
  if (!cal?.slug) return null;
  return `https://lu.ma/${encodeURIComponent(cal.slug)}`;
}

/**
 * Untracked calendars first seen after the last digest. Calendars that were
 * already in known_calendars.json before this feature shipped have no
 * first_seen_at and are skipped, so week one isn't a dump of the whole registry.
 */
function selectPendingCalendars({ registry, trackedIds, lastSentAt }) {
  const tracked = trackedIds instanceof Set ? trackedIds : new Set(trackedIds || []);
  const cutoff = lastSentAt ? Date.parse(lastSentAt) : NaN;
  const pending = [];

  for (const cal of Object.values(registry || {})) {
    if (!cal?.api_id) continue;
    if (tracked.has(cal.api_id)) continue;
    if (cal.source === "manual" || cal.source === "subscription") continue;
    if (!cal.first_seen_at) continue;
    const seenAt = Date.parse(cal.first_seen_at);
    if (!Number.isFinite(seenAt)) continue;
    if (Number.isFinite(cutoff) && seenAt <= cutoff) continue;
    pending.push(cal);
  }

  return pending.sort((a, b) => {
    const byCount = (b.london_event_count || 0) - (a.london_event_count || 0);
    if (byCount !== 0) return byCount;
    return (a.name || a.api_id).localeCompare(b.name || b.api_id);
  });
}

/**
 * Send when there is something to report and either this is the first digest
 * or the interval has elapsed. intervalDays <= 0 disables the digest.
 */
function shouldSendDigest({ lastSentAt, pendingCount, now = new Date(), intervalDays = DEFAULT_DIGEST_DAYS }) {
  if (!(intervalDays > 0)) return false;
  if (!(pendingCount > 0)) return false;
  if (!lastSentAt) return true;
  const elapsed = now.getTime() - Date.parse(lastSentAt);
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= intervalDays * MS_PER_DAY;
}

function formatDigestEmail(calendars) {
  const count = calendars.length;
  const subject =
    count === 1
      ? `📅 New London calendar to follow: ${calendars[0].name || calendars[0].api_id}`
      : `📅 ${count} new London calendars to follow`;

  const blocks = calendars.map((cal, i) => {
    const url = calendarUrl(cal);
    const events =
      cal.london_event_count != null
        ? `${cal.london_event_count} upcoming London event(s)`
        : "London events (count unknown)";
    const via = SOURCE_LABELS[cal.source] || cal.source || "unknown source";
    const lines = [`${i + 1}. ${cal.name || cal.api_id}`, `   ${events}  ·  found via ${via}`];
    if (url) lines.push(`   Follow: ${url}`);
    else lines.push(`   (no public slug — search Lu.ma for “${cal.name || cal.api_id}”)`);
    return lines.join("\n");
  });

  const text = [
    "New London calendars showed up that you don't follow yet.",
    "Follow the ones you want on Lu.ma — the next monitor run adds them to",
    "tracked_calendars.json automatically. You don't need to edit the repo.",
    "",
    ...blocks,
    "",
    "---",
    "Already-followed calendars are omitted. Unfollowed ones stay in the",
    "polling registry either way, so their events can still match on keywords.",
  ].join("\n");

  return { subject, text };
}

module.exports = {
  DEFAULT_DIGEST_DAYS,
  SOURCE_LABELS,
  calendarUrl,
  formatDigestEmail,
  selectPendingCalendars,
  shouldSendDigest,
};
