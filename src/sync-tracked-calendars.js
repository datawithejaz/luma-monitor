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
  const raw = data.calendars || data.entries || data.items || [];
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
  const pinned = existing.filter(isPinnedManual);
  const pinnedIds = new Set(pinned.map((cal) => cal.api_id));
  const subscriptionIds = new Set(subscriptions.map((cal) => cal.api_id));

  const merged = [...pinned];
  const mergedIds = new Set(pinnedIds);

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

  const removed = existing.filter(
    (cal) =>
      !isPinnedManual(cal) &&
      (cal.reason || "").includes("User subscription") &&
      !subscriptionIds.has(cal.api_id)
  );

  return { merged, removed, added: subscriptions.filter((cal) => !pinnedIds.has(cal.api_id)) };
}

async function main() {
  const existing = loadTracked();
  const subscriptions = await fetchFollowingCalendars();
  const { merged, removed, added } = mergeTracked(existing, subscriptions);

  console.log(`Lu.ma subscriptions: ${subscriptions.length}`);
  console.log(`Pinned manual entries kept: ${existing.filter(isPinnedManual).length}`);
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

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
