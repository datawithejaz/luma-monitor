/**
 * Capability probe for LUMA_AUTH_COOKIE.
 *
 * Answers one question: what extra data does a signed-in session unlock that the
 * anonymous monitor can't already see? Every endpoint is called twice — once
 * anonymously, once with the cookie — and the two results are compared.
 *
 * Privacy: this prints counts, status codes and field names only. No names,
 * emails, bios or social handles are ever written to the log, because Actions
 * logs on a public repo are public.
 *
 * Run: LUMA_AUTH_COOKIE='...' node src/probe_auth.js
 */

const https = require("https");

const LONDON_PLACE_ID = "discplace-QCcNk3HXowOR97j";
const EVENTS_TO_SAMPLE = 8;
const BASE_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
  "x-luma-client-type": "web",
};

const cookie = process.env.LUMA_AUTH_COOKIE;

// ── HTTP ──────────────────────────────────────────────────────────────────────
/** Never rejects — a probe wants the failure status, not an exception. */
function request(url, { auth = false } = {}) {
  const headers = { ...BASE_HEADERS };
  if (auth) headers.Cookie = cookie;

  return new Promise((resolve) => {
    https
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* non-JSON responses are reported by status alone */
          }
          resolve({ status: res.statusCode, json });
        });
      })
      .on("error", (err) => resolve({ status: 0, json: null, error: err.message }));
  });
}

// ── Reporting helpers ─────────────────────────────────────────────────────────
const findings = [];

function record(capability, unlocked, detail) {
  findings.push({ capability, unlocked, detail });
  const mark = unlocked === true ? "✅" : unlocked === false ? "❌" : "➖";
  console.log(`${mark} ${capability}`);
  if (detail) console.log(`     ${detail}`);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

/** Social-link coverage, aggregated. Deliberately returns no identifying values. */
function profileStats(records) {
  const list = records.filter(Boolean);
  return {
    total: list.length,
    linkedin: list.filter((p) => p.linkedin_handle).length,
    personalLinkedin: list.filter((p) => /^\/in\//.test(p.linkedin_handle || "")).length,
    twitter: list.filter((p) => p.twitter_handle).length,
    website: list.filter((p) => p.website).length,
    bio: list.filter((p) => p.bio_short).length,
  };
}

function describeStats(label, s) {
  return (
    `${label}: ${s.total} profile(s) — LinkedIn ${s.linkedin} ` +
    `(${s.personalLinkedin} personal /in/), X ${s.twitter}, site ${s.website}, bio ${s.bio}`
  );
}

// ── Probes ────────────────────────────────────────────────────────────────────
async function probeSession() {
  section("Session");
  const res = await request("https://api.lu.ma/home/get-following-calendars", { auth: true });
  const ok = res.status === 200;
  const count = (res.json?.calendars || res.json?.entries || res.json?.items || []).length;
  record(
    "Cookie is a valid signed-in session",
    ok,
    ok ? `home/get-following-calendars → 200, ${count} calendar(s)` : `status ${res.status} — cookie is missing, expired or malformed`
  );
  return ok;
}

/** Events you are registered for. Endpoint name is known; parameters are not. */
async function probeMyEvents() {
  section("Your own registrations");
  const variants = [
    "https://api.lu.ma/home/get-events?period=future",
    "https://api.lu.ma/home/get-events?period=upcoming",
    "https://api.lu.ma/home/get-events",
  ];

  for (const url of variants) {
    const res = await request(url, { auth: true });
    if (res.status !== 200) continue;
    const entries = res.json?.entries || res.json?.events || [];
    record(
      "Read the events you have registered for",
      true,
      `${url.split("?")[1] || "(no params)"} → 200, ${entries.length} entr(ies). ` +
        "Lets the monitor skip alerting on events you already signed up for."
    );
    return entries;
  }

  record("Read the events you have registered for", false, "no parameter variant of home/get-events returned 200");
  return [];
}

/** The main question: full attendee lists on events you are NOT registered to. */
async function probeGuestLists() {
  section("Guest lists");

  const discover = await request(
    `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${LONDON_PLACE_ID}&pagination_limit=50`
  );
  const entries = discover.json?.entries || [];
  if (entries.length === 0) {
    record("Read full guest lists", null, "discover feed returned nothing — cannot sample");
    return;
  }

  let publicList = 0;
  let hiddenList = 0;
  let anonUnlocked = 0;
  let authUnlocked = 0;
  let authForbidden = 0;
  let featuredTotal = 0;
  let fullTotal = 0;
  let guestCountTotal = 0;
  const fullProfiles = [];
  let sampleShape = null;

  for (const entry of entries.slice(0, EVENTS_TO_SAMPLE)) {
    const eventId = entry.event?.api_id;
    if (!eventId) continue;

    const detail = await request(`https://api.lu.ma/event/get?event_api_id=${eventId}`);
    const showsList = detail.json?.event?.show_guest_list === true;
    if (showsList) publicList++;
    else hiddenList++;

    featuredTotal += (detail.json?.featured_guests || []).length;
    guestCountTotal += detail.json?.guest_count || 0;

    const url = `https://api.lu.ma/event/get-guest-list?event_api_id=${eventId}&pagination_limit=100`;
    const anon = await request(url);
    if (anon.status === 200) anonUnlocked++;

    const auth = await request(url, { auth: true });
    if (auth.status === 200) {
      authUnlocked++;
      const guests = auth.json?.entries || auth.json?.guests || [];
      fullTotal += guests.length;
      for (const g of guests) fullProfiles.push(g.user || g);
      if (!sampleShape && guests.length > 0) {
        sampleShape = Object.keys(guests[0].user || guests[0]).sort();
      }
    } else if (auth.status === 401 || auth.status === 403) {
      authForbidden++;
    }
  }

  record(
    "Guest list is host-controlled, not registration-gated",
    null,
    `sampled ${EVENTS_TO_SAMPLE} events — ${publicList} show their guest list publicly, ${hiddenList} hide it`
  );

  record(
    "Read full guest lists while signed in",
    authUnlocked > 0,
    `event/get-guest-list → 200 on ${authUnlocked}/${EVENTS_TO_SAMPLE} with cookie, ` +
      `${anonUnlocked}/${EVENTS_TO_SAMPLE} without (${authForbidden} refused even signed in)`
  );

  if (authUnlocked > 0) {
    record(
      "Volume gained over the public featured-guest preview",
      true,
      `${fullTotal} full guest record(s) vs ${featuredTotal} featured; ` +
        `hosts report ${guestCountTotal} total guest(s) across the sample`
    );
    record("Profile fields on a guest record", null, `keys: ${(sampleShape || []).join(", ") || "n/a"}`);
    record("Contactability of those guests", null, describeStats("full guest lists", profileStats(fullProfiles)));
  }
}

/** Does event/get return your own registration state when signed in? */
async function probeRegistrationState(myEvents) {
  section("Your registration state per event");

  const eventId = myEvents[0]?.event?.api_id || myEvents[0]?.api_id;
  if (!eventId) {
    record("Read your approval / waitlist status", null, "no registered event available to test against");
    return;
  }

  const res = await request(`https://api.lu.ma/event/get?event_api_id=${eventId}`, { auth: true });
  const guestData = res.json?.guest_data;
  record(
    "Read your approval / waitlist status",
    Boolean(guestData),
    guestData
      ? `guest_data populated — approval_status: ${guestData.approval_status}. ` +
          "Lets the monitor tell you when a pending registration is approved."
      : "guest_data stayed null even with the cookie"
  );
}

/** Public profile pages expose an overlap counter that only fills in when signed in. */
async function probeSharedHistory() {
  section("Shared history with hosts");

  const discover = await request(
    `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${LONDON_PLACE_ID}&pagination_limit=30`
  );
  const usernames = [];
  for (const entry of discover.json?.entries || []) {
    for (const host of entry.hosts || []) {
      if (host.username && !usernames.includes(host.username)) usernames.push(host.username);
    }
  }

  if (usernames.length === 0) {
    record("Read how many events you attended alongside a host", null, "no host usernames in the sample");
    return;
  }

  let checked = 0;
  let withOverlap = 0;
  for (const username of usernames.slice(0, 5)) {
    const page = await fetchProfilePage(username);
    if (!page) continue;
    checked++;
    if ((page.event_together_count || 0) > 0) withOverlap++;
  }

  record(
    "Read how many events you attended alongside a host",
    checked > 0,
    `checked ${checked} host profile(s); ${withOverlap} share at least one event with you. ` +
      "Profiles also expose event_hosted_count and event_attended_count anonymously."
  );
}

function fetchProfilePage(username) {
  return new Promise((resolve) => {
    const headers = { "User-Agent": BASE_HEADERS["User-Agent"], Cookie: cookie };
    https
      .get(`https://luma.com/user/${encodeURIComponent(username)}`, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          const match = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (!match) return resolve(null);
          try {
            resolve(JSON.parse(match[1])?.props?.pageProps?.initialData || null);
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Luma auth capability probe — reports counts and field names only.\n");

  if (!cookie) {
    console.error("LUMA_AUTH_COOKIE is not set. Nothing to probe.");
    process.exit(1);
  }

  const authenticated = await probeSession();
  if (!authenticated) {
    console.error("\nStopping: the cookie did not authenticate, so every other result would be a false negative.");
    process.exit(1);
  }

  const myEvents = await probeMyEvents();
  await probeGuestLists();
  await probeRegistrationState(myEvents);
  await probeSharedHistory();

  section("Summary");
  const unlocked = findings.filter((f) => f.unlocked === true);
  const blocked = findings.filter((f) => f.unlocked === false);
  console.log(`${unlocked.length} capability(ies) unlocked, ${blocked.length} blocked.`);
  blocked.forEach((f) => console.log(`   blocked: ${f.capability}`));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
