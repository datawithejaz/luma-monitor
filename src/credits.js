"use strict";

/**
 * Cursor credit claim helper for SpaceXAI / Grok Bot Luma events.
 *
 * The public claim app (e.g. grok-bot-coloop-cowork-09-26.teamdeel.workers.dev)
 * exposes check-in and redeemed status by Luma guest id + name. It does not
 * return emails. Claiming still needs the email the guest used on Luma.
 *
 * Default: list people who are checked in and have not claimed a code.
 * --claim: POST the same /api/redeem the webpage uses (one person at a time).
 * --guests: join emails from a Luma host CSV export (not committed).
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const DEFAULT_BASE = "https://grok-bot-coloop-cowork-09-26.teamdeel.workers.dev";
const DEFAULT_SLUG = "grok-bot-coloop-cowork-09-26";
const CLAIM_PAGE_PATH = "/cloudflare";

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
};

function fetchText(url, { method = "GET", body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      parsed,
      {
        method,
        headers: { ...HEADERS, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: data, headers: res.headers })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJSON(url, options = {}) {
  const res = await fetchText(url, options);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`JSON parse failed (${res.status}): ${res.body.slice(0, 200)}`);
  }
  return { ...res, json };
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isCheckedIn(attendee) {
  if (typeof attendee.checkedIn === "boolean") return attendee.checkedIn;
  const status = String(attendee.status || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  return status === "checked_in";
}

function hasRedeemed(attendee) {
  return Boolean(attendee.hasRedeemed || attendee.hasRedeemedCode);
}

function classify(attendee) {
  const checkedIn = isCheckedIn(attendee);
  const redeemed = hasRedeemed(attendee);
  return {
    id: String(attendee.id || ""),
    name: String(attendee.name || "").trim(),
    email: attendee.email ? String(attendee.email).trim() : null,
    checkedIn,
    hasRedeemed: redeemed,
    status: checkedIn ? "checked_in" : "going",
    bucket:
      checkedIn && !redeemed
        ? "checked_in_unclaimed"
        : checkedIn && redeemed
          ? "checked_in_claimed"
          : !checkedIn && redeemed
            ? "claimed_not_checked_in"
            : "not_checked_in",
  };
}

function partition(attendees) {
  const groups = {
    checked_in_unclaimed: [],
    checked_in_claimed: [],
    claimed_not_checked_in: [],
    not_checked_in: [],
  };
  for (const raw of attendees || []) {
    const row = classify(raw);
    if (!row.name && !row.id) continue;
    groups[row.bucket].push(row);
  }
  return groups;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text || "").replace(/^\uFEFF/, "");

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      pushCell();
      continue;
    }
    if (ch === "\n") {
      pushCell();
      pushRow();
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  pushCell();
  pushRow();
  return rows;
}

function headerKey(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function pickColumn(keys, candidates) {
  for (const candidate of candidates) {
    const match = keys.find((key) => key === candidate || key.includes(candidate));
    if (match) return match;
  }
  return null;
}

function parseGuestsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const keys = rows[0].map(headerKey);
  const nameKey = pickColumn(keys, ["name", "full_name", "guest_name"]);
  const emailKey = pickColumn(keys, ["email", "email_address"]);
  const idKey = pickColumn(keys, ["guest_id", "api_id", "id", "guestid"]);
  if (!nameKey && !idKey) {
    throw new Error("Guests CSV needs a Name or Guest ID column");
  }

  const guests = [];
  for (const cells of rows.slice(1)) {
    const record = {};
    keys.forEach((key, index) => {
      record[key] = (cells[index] || "").trim();
    });
    const guest = {
      id: idKey ? record[idKey] : "",
      name: nameKey ? record[nameKey] : "",
      email: emailKey ? record[emailKey] : "",
    };
    if (guest.email || guest.id || guest.name) guests.push(guest);
  }
  return guests;
}

function joinEmails(attendees, guests) {
  const byId = new Map();
  const byName = new Map();
  for (const guest of guests || []) {
    if (guest.id) byId.set(guest.id, guest.email || "");
    const key = normalizeName(guest.name);
    if (key && guest.email && !byName.has(key)) byName.set(key, guest.email);
  }

  return attendees.map((attendee) => {
    const email =
      attendee.email ||
      (attendee.id && byId.get(attendee.id)) ||
      byName.get(normalizeName(attendee.name)) ||
      null;
    return { ...attendee, email: email || null };
  });
}

function counts(groups) {
  return {
    checked_in_unclaimed: groups.checked_in_unclaimed.length,
    checked_in_claimed: groups.checked_in_claimed.length,
    claimed_not_checked_in: groups.claimed_not_checked_in.length,
    not_checked_in: groups.not_checked_in.length,
    total:
      groups.checked_in_unclaimed.length +
      groups.checked_in_claimed.length +
      groups.claimed_not_checked_in.length +
      groups.not_checked_in.length,
  };
}

function formatPerson(person, { showEmail = false } = {}) {
  const email =
    showEmail && person.email ? `  ${person.email}` : showEmail ? "  (no email in CSV)" : "";
  return `  • ${person.name}${email}`;
}

function formatStatusReport(groups, { showEmail = false, all = false } = {}) {
  const tally = counts(groups);
  const lines = [
    `Checked in, not claimed: ${tally.checked_in_unclaimed}`,
    `Checked in, claimed:     ${tally.checked_in_claimed}`,
    `Not checked in:          ${tally.not_checked_in}`,
    `Total on list:           ${tally.total}`,
    "",
    "Checked in — not claimed (eligible to request a code)",
  ];
  if (groups.checked_in_unclaimed.length === 0) {
    lines.push("  (none)");
  } else {
    groups.checked_in_unclaimed.forEach((person) =>
      lines.push(formatPerson(person, { showEmail }))
    );
  }

  if (all) {
    lines.push("", "Checked in — already claimed");
    if (groups.checked_in_claimed.length === 0) lines.push("  (none)");
    else {
      groups.checked_in_claimed.forEach((person) =>
        lines.push(formatPerson(person, { showEmail }))
      );
    }
    lines.push("", "Registered — not checked in");
    if (groups.not_checked_in.length === 0) lines.push("  (none)");
    else {
      groups.not_checked_in.forEach((person) =>
        lines.push(formatPerson(person, { showEmail }))
      );
    }
  }

  return lines.join("\n");
}

function unclaimedEmails(groups) {
  return groups.checked_in_unclaimed
    .map((person) => person.email)
    .filter(Boolean);
}

async function fetchProject(base, slug) {
  const url = `${base.replace(/\/$/, "")}/api/public/projects/${encodeURIComponent(slug)}`;
  const res = await fetchJSON(url);
  if (res.status === 404 || !res.json?.success || !res.json.data) {
    throw new Error(res.json?.error || `Project not found: ${slug}`);
  }
  return res.json.data;
}

async function fetchAttendees(base, projectId) {
  const url =
    `${base.replace(/\/$/, "")}/api/attendees?projectId=` +
    encodeURIComponent(projectId);
  const res = await fetchJSON(url);
  if (!res.json?.success) {
    throw new Error(res.json?.error || `Attendee list failed (${res.status})`);
  }
  return res.json.attendees || [];
}

function extractCode(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["code", "promoCode", "cursorCode", "redeemCode", "coupon"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
  }
  for (const key of ["cursorUrl", "redeemUrl", "url", "existingCursorUrl"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
  }
  return null;
}

async function redeemCredits(base, { name, email, projectId, recoveryOnly = false }) {
  const payload = JSON.stringify({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    projectId,
    includeSupabase: false,
    includePaypal: false,
    ...(recoveryOnly ? { recoveryOnly: true } : {}),
  });
  const url = `${base.replace(/\/$/, "")}/api/redeem`;
  const res = await fetchJSON(url, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.json?.success || !res.json.data) {
    throw new Error(res.json?.error || `Redeem failed (${res.status})`);
  }
  return {
    data: res.json.data,
    code: extractCode(res.json.data),
  };
}

function parseArgs(argv) {
  const args = {
    all: false,
    json: false,
    claim: false,
    recover: false,
    emailsOnly: false,
    name: "",
    email: "",
    guests: "",
    slug: process.env.CREDIT_PROJECT_SLUG || DEFAULT_SLUG,
    base: process.env.CREDIT_BASE_URL || DEFAULT_BASE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    if (arg === "--all") args.all = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--claim") args.claim = true;
    else if (arg === "--recover") args.recover = true;
    else if (arg === "--emails-only") args.emailsOnly = true;
    else if (arg === "--name") args.name = next();
    else if (arg === "--email") args.email = next();
    else if (arg === "--guests") args.guests = next();
    else if (arg === "--slug") args.slug = next();
    else if (arg === "--base") args.base = next();
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node credits.js [options]",
    "",
    "List who is checked in and has not claimed Cursor credits, then optionally",
    "request a code with the same API as:",
    `  ${DEFAULT_BASE}${CLAIM_PAGE_PATH}`,
    "",
    "Options:",
    "  --all              also print claimed / not-checked-in names",
    "  --json             machine-readable groups",
    "  --guests FILE      join emails from a Luma guests CSV export",
    "  --emails-only      print emails of checked-in unclaimed guests (needs --guests)",
    "  --claim            request/retrieve a code (needs --name and --email)",
    "  --recover          retrieve an already-claimed code instead of minting",
    "  --name NAME        Luma display name",
    "  --email EMAIL      email used on Luma",
    "  --slug SLUG        claim-app project slug",
    "  --base URL         claim-app origin",
    "",
    "The attendees API does not include emails. Export guests from Luma (host",
    "dashboard) and pass --guests, or type --email when claiming one person.",
    "Do not commit guest CSVs; this repo is public.",
  ].join("\n");
}

async function run(args, io = { readFile: fs.readFileSync, log: console.log, error: console.error }) {
  if (args.help) {
    io.log(usage());
    return 0;
  }

  const project = await fetchProject(args.base, args.slug);
  const projectId = project.id || args.slug;
  const raw = await fetchAttendees(args.base, args.slug);
  let groups = partition(raw);

  if (args.guests) {
    const csv = io.readFile(path.resolve(args.guests), "utf8");
    const guests = parseGuestsCsv(csv);
    for (const key of Object.keys(groups)) {
      groups[key] = joinEmails(groups[key], guests);
    }
  }

  if (args.claim || args.recover) {
    if (!args.name || !args.email) {
      throw new Error("--claim/--recover requires --name and --email");
    }
    const match = [...groups.checked_in_unclaimed, ...groups.checked_in_claimed, ...groups.not_checked_in]
      .find((person) => normalizeName(person.name) === normalizeName(args.name));
    if (!match) {
      throw new Error(`No Luma guest named "${args.name}" on this claim list`);
    }
    if (!match.checkedIn && !args.recover) {
      throw new Error(
        `${match.name} is not checked in yet — the claim page will refuse a code until check-in`
      );
    }
    const result = await redeemCredits(args.base, {
      name: args.name,
      email: args.email,
      projectId,
      recoveryOnly: args.recover || false,
    });
    if (args.json) {
      io.log(JSON.stringify({ project, result }, null, 2));
    } else {
      io.log(`Event: ${project.name} (${args.slug})`);
      if (result.code) io.log(`Code / URL: ${result.code}`);
      else io.log(JSON.stringify(result.data, null, 2));
    }
    return 0;
  }

  if (args.emailsOnly) {
    const emails = unclaimedEmails(groups);
    if (!args.guests && emails.length === 0) {
      throw new Error("--emails-only needs --guests FILE (the claim API has no emails)");
    }
    io.log(emails.join("\n"));
    return 0;
  }

  if (args.json) {
    io.log(
      JSON.stringify(
        {
          project,
          claimPage: `${args.base.replace(/\/$/, "")}${CLAIM_PAGE_PATH}`,
          counts: counts(groups),
          groups: args.all
            ? groups
            : { checked_in_unclaimed: groups.checked_in_unclaimed },
        },
        null,
        2
      )
    );
    return 0;
  }

  io.log(`Event: ${project.name}`);
  io.log(`Claim page: ${args.base.replace(/\/$/, "")}${CLAIM_PAGE_PATH}`);
  io.log("");
  io.log(formatStatusReport(groups, { showEmail: Boolean(args.guests), all: args.all }));
  return 0;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exitCode = await run(args);
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BASE,
  DEFAULT_SLUG,
  CLAIM_PAGE_PATH,
  classify,
  partition,
  parseCsv,
  parseGuestsCsv,
  joinEmails,
  counts,
  formatStatusReport,
  unclaimedEmails,
  parseArgs,
  extractCode,
  fetchProject,
  fetchAttendees,
  redeemCredits,
  run,
};

if (require.main === module) {
  main();
}
