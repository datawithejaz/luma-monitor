const fs = require("fs");
const path = require("path");
const https = require("https");

const TRACKED_CALENDARS_PATH = path.join(__dirname, "tracked_calendars.json");

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { ...HEADERS, ...extraHeaders } }, (res) => {
        const { statusCode } = res;
        if (statusCode && statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
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

function loadTracked() {
  try {
    const data = JSON.parse(fs.readFileSync(TRACKED_CALENDARS_PATH, "utf8"));
    return data.calendars || [];
  } catch {
    return [];
  }
}

function saveTracked(calendars) {
  const sorted = [...calendars].sort((a, b) =>
    (a.name || a.api_id).localeCompare(b.name || b.api_id)
  );
  fs.writeFileSync(
    TRACKED_CALENDARS_PATH,
    JSON.stringify({ calendars: sorted }, null, 2) + "\n"
  );
}

function isPinnedManual(cal) {
  if (cal.include_all_events) return true;
  if ((cal.reason || "").includes("Not in your follows")) return true;
  return false;
}

function isHardPinned(cal) {
  return cal.include_all_events === true;
}

async function fetchFollowingCalendars() {
  const cookie = process.env.LUMA_AUTH_COOKIE;
  if (!cookie) {
    throw new Error(
      "LUMA_AUTH_COOKIE is not set. Add it as a GitHub Actions secret or export it locally."
    );
  }

  const data = await fetchJSON("https://api.lu.ma/home/get-following-calendars", {
    Cookie: cookie,
  });
  const raw = data.infos || data.calendars || data.entries || data.items || [];
  return raw
    .map((item) => {
      const cal = item.calendar || item;
      return {
        api_id: cal.api_id,
        name: cal.name || "",
        slug: cal.slug || "",
        reason: "User subscription",
      };
    })
    .filter((cal) => cal.api_id);
}

function mergeTracked(existing, subscriptions) {
  const hardPinned = existing.filter(isHardPinned);
  const softPinned = existing.filter((cal) => isPinnedManual(cal) && !isHardPinned(cal));
  const hardPinnedIds = new Set(hardPinned.map((cal) => cal.api_id));
  const subscriptionIds = new Set(subscriptions.map((cal) => cal.api_id));

  const merged = [...hardPinned];
  const mergedIds = new Set(hardPinnedIds);

  for (const cal of subscriptions) {
    if (mergedIds.has(cal.api_id)) continue;
    const prior = existing.find((entry) => entry.api_id === cal.api_id);
    merged.push({
      api_id: cal.api_id,
      slug: cal.slug || prior?.slug || "",
      name: cal.name || prior?.name || "",
      reason: "User subscription",
      ...(prior?.include_all_events ? { include_all_events: true } : {}),
      ...(prior?.user_api_id ? { user_api_id: prior.user_api_id } : {}),
      ...(prior?.sample_event_url ? { sample_event_url: prior.sample_event_url } : {}),
    });
    mergedIds.add(cal.api_id);
  }

  // Keep soft-pinned entries only if they still aren't followed on Lu.ma.
  for (const cal of softPinned) {
    if (subscriptionIds.has(cal.api_id) || mergedIds.has(cal.api_id)) continue;
    merged.push(cal);
    mergedIds.add(cal.api_id);
  }

  const removed = existing.filter(
    (cal) =>
      !isHardPinned(cal) &&
      (cal.reason || "").includes("User subscription") &&
      !subscriptionIds.has(cal.api_id)
  );

  const added = subscriptions.filter((cal) => !hardPinnedIds.has(cal.api_id));

  return { merged, removed, added };
}

/**
 * A 200 response with an unfamiliar payload shape is indistinguishable from
 * "you follow nothing" — that is exactly how Lu.ma renaming `calendars` to
 * `infos` silently emptied this list and sent every followed calendar back
 * through keyword filtering. Refuse to rewrite the file instead of trusting it.
 */
function assertPlausibleSync(existing, subscriptions, merged) {
  if (subscriptions.length === 0) {
    throw new Error(
      "Lu.ma returned 0 followed calendars. That normally means an expired session or a " +
        "changed payload shape, not that you unfollowed everything. Left " +
        "tracked_calendars.json untouched — set ALLOW_TRACKED_SHRINK=1 to override."
    );
  }

  if (process.env.ALLOW_TRACKED_SHRINK === "1" || existing.length === 0) return;

  if (merged.length * 2 < existing.length) {
    throw new Error(
      `Sync would cut tracked calendars from ${existing.length} to ${merged.length}. ` +
        "Refusing as a likely API change — set ALLOW_TRACKED_SHRINK=1 if intended."
    );
  }
}

async function main() {
  const existing = loadTracked();
  const subscriptions = await fetchFollowingCalendars();
  const { merged, removed, added } = mergeTracked(existing, subscriptions);
  assertPlausibleSync(existing, subscriptions, merged);

  console.log(`Lu.ma subscriptions: ${subscriptions.length}`);
  console.log(`Pinned manual entries kept: ${existing.filter(isHardPinned).length}`);
  console.log(`Tracked total: ${existing.length} -> ${merged.length}`);

  if (added.length > 0) {
    console.log("\nAdded:");
    added.forEach((cal) => console.log(`  + ${cal.name} (${cal.api_id})`));
  }
  if (removed.length > 0) {
    console.log("\nRemoved (unfollowed):");
    removed.forEach((cal) => console.log(`  - ${cal.name} (${cal.api_id})`));
  }
  if (added.length === 0 && removed.length === 0) {
    console.log("\nNo changes — tracked_calendars.json already matches your Lu.ma follows.");
  }

  saveTracked(merged);
  console.log(`\nWrote ${TRACKED_CALENDARS_PATH}`);
}

// Guarded so the merge logic can be required from tests without syncing.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { assertPlausibleSync, mergeTracked };
