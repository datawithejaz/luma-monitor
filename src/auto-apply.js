"use strict";

/**
 * Auto-apply to free events on calendars flagged `auto_apply: true`.
 *
 * Profile answers come from the AUTO_APPLY_PROFILE_JSON secret (never committed).
 * Dry-run is ON unless AUTO_APPLY_DRY_RUN=0 — logs / emails what would happen
 * without POSTing to Lu.ma.
 */

const https = require("https");

const API_HOST = "api.luma.com";
const DEFAULT_COUNTRY = "United Kingdom";

function isDryRun() {
  // Default ON — live applies require an explicit AUTO_APPLY_DRY_RUN=0.
  return process.env.AUTO_APPLY_DRY_RUN !== "0";
}

function loadProfile() {
  const raw = process.env.AUTO_APPLY_PROFILE_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const profile = JSON.parse(raw);
    if (!profile || typeof profile !== "object") return null;
    return normalizeProfile(profile);
  } catch (err) {
    throw new Error(`AUTO_APPLY_PROFILE_JSON is not valid JSON: ${err.message}`);
  }
}

function normalizeProfile(profile) {
  const linkedin = String(profile.linkedin || profile.linkedin_url || "").trim();
  const handleFromUrl = linkedin.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return {
    linkedin,
    linkedin_handle: String(
      profile.linkedin_handle || (handleFromUrl ? handleFromUrl[1] : "") || ""
    ).trim(),
    company: String(profile.company || "").trim(),
    role: String(profile.role || profile.job_title || "").trim(),
    why_attend: String(profile.why_attend || profile.why || "").trim(),
    phone: normalizePhone(profile.phone),
    country: String(profile.country || DEFAULT_COUNTRY).trim(),
    agree_terms: profile.agree_terms !== false,
    marketing_opt_in: profile.marketing_opt_in === true,
    dropdown_defaults: profile.dropdown_defaults || {},
    text_defaults: profile.text_defaults || {},
  };
}

/** UK mobiles like 07… → +447…; leave already-international numbers alone. */
function normalizePhone(raw) {
  if (raw == null || raw === "") return "";
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("44")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+44${digits.slice(1)}`;
  return digits;
}

function loadAutoApplyCalendarIds(trackedCalendars) {
  return new Set(
    (trackedCalendars || [])
      .filter((cal) => cal && cal.auto_apply === true && cal.api_id)
      .map((cal) => cal.api_id)
  );
}

function requestJson(method, path, { cookie, body } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; luma-monitor/1.0)",
    "x-luma-client-type": "luma-web",
    Origin: "https://luma.com",
    Referer: "https://luma.com/",
  };
  if (cookie) headers.Cookie = cookie.includes("=") ? cookie : `luma.auth-session-key=${cookie}`;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: API_HOST, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchSessionUser(cookie) {
  const res = await requestJson("GET", "/user", { cookie });
  if (res.status !== 200 || !res.json) {
    throw new Error(`GET /user failed (${res.status})`);
  }
  return res.json;
}

async function fetchEventDetail(eventApiId, cookie) {
  const res = await requestJson(
    "GET",
    `/event/get?event_api_id=${encodeURIComponent(eventApiId)}`,
    { cookie }
  );
  if (res.status !== 200 || !res.json) {
    throw new Error(`GET /event/get failed (${res.status}) for ${eventApiId}`);
  }
  return res.json;
}

function pickFreeTicket(ticketTypes) {
  const list = ticketTypes || [];
  const free = list.filter(
    (t) =>
      t &&
      !t.is_hidden &&
      !t.is_disabled &&
      (t.type === "free" || t.cents == null || t.cents === 0)
  );
  if (free.length === 0) return null;
  // Prefer a type that doesn't need approval only if both exist; otherwise any free.
  return free.find((t) => !t.require_approval) || free[0];
}

function alreadyRegistered(detail) {
  const guest = detail.guest_data;
  if (!guest) return false;
  // Any guest_data means the session already has a registration row.
  return Boolean(guest.api_id || guest.approval_status || guest.proxy_key);
}

function labelKey(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lookupDropdownDefault(profile, question) {
  const defaults = profile.dropdown_defaults || {};
  const key = labelKey(question.label);
  for (const [pattern, value] of Object.entries(defaults)) {
    if (key.includes(labelKey(pattern))) return value;
  }
  // Built-in heuristics for common host questions.
  if (/\bcountry\b/.test(key) && profile.country) return profile.country;
  if (/number of employees|company size|employees at your company/.test(key)) {
    return defaults.company_size || null;
  }
  return null;
}

function lookupTextDefault(profile, question) {
  const defaults = profile.text_defaults || {};
  const key = labelKey(question.label);
  for (const [pattern, value] of Object.entries(defaults)) {
    if (key.includes(labelKey(pattern))) return value;
  }
  if (/linkedin/.test(key)) return profile.linkedin || profile.linkedin_handle;
  if (/company|where do you work|work or study|organisation|organization/.test(key)) {
    return profile.company;
  }
  if (/\brole\b|job title|what do you do/.test(key)) return profile.role;
  if (
    /why (are you|do you want)|what brings you|what would you like|interested in|burning question|what are you building/.test(
      key
    )
  ) {
    return profile.why_attend;
  }
  if (/how did you find/.test(key)) return "Lu.ma";
  if (/accessible|allergen|accessib/.test(key)) return "N/A";
  if (/org id|organization settings/.test(key)) return "";
  return defaults[question.id] || null;
}

/**
 * Map Lu.ma registration_questions → answer objects the /event/register body expects.
 * Required questions we can't fill → listed in `missing` (caller should skip apply).
 */
function buildRegistrationAnswers(questions, profile) {
  const answers = [];
  const missing = [];

  for (const question of questions || []) {
    const type = question.question_type;
    let value = null;

    switch (type) {
      case "linkedin":
        value = profile.linkedin_handle || profile.linkedin || "";
        break;
      case "url":
        value =
          /linkedin/i.test(question.label || "")
            ? profile.linkedin || profile.linkedin_handle
            : lookupTextDefault(profile, question);
        break;
      case "company":
        value = {
          company: profile.company || null,
          job_title: question.collect_job_title ? profile.role || null : null,
        };
        break;
      case "phone-number":
        value = profile.phone || null;
        break;
      case "terms":
        value = profile.agree_terms ? true : null;
        break;
      case "agree-check":
        value = /marketing|sponsor|sharing|consent/i.test(question.label || "")
          ? Boolean(profile.marketing_opt_in)
          : Boolean(profile.agree_terms);
        break;
      case "dropdown":
      case "select": {
        const picked = lookupDropdownDefault(profile, question);
        if (picked && Array.isArray(question.options) && question.options.includes(picked)) {
          value = question.multiple ? [picked] : picked;
        } else if (picked && Array.isArray(question.options)) {
          // Case-insensitive match
          const hit = question.options.find(
            (opt) => String(opt).toLowerCase() === String(picked).toLowerCase()
          );
          value = hit ? (question.multiple ? [hit] : hit) : null;
        } else {
          value = null;
        }
        break;
      }
      case "multi-select": {
        const picked = lookupDropdownDefault(profile, question);
        value = picked ? [picked] : [];
        break;
      }
      case "text":
      case "long-text":
        value = lookupTextDefault(profile, question);
        break;
      default:
        value = lookupTextDefault(profile, question);
        break;
    }

    const blank =
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((v) => v == null || v === ""));

    if (blank) {
      if (question.required) missing.push(question.label || question.id);
      continue;
    }

    const answer = {
      label: question.label,
      question_id: question.id,
      question_type: type,
      value,
    };
    if (type === "select" && question.multiple) answer.multiple = true;
    if (type === "text" && question.multiline) answer.multiline = true;
    answers.push(answer);
  }

  return { answers, missing };
}

function buildRegisterPayload({ eventApiId, user, ticket, answers, forWaitlist }) {
  return {
    name: user.name || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    email: user.email,
    event_api_id: eventApiId,
    for_waitlist: Boolean(forWaitlist),
    payment_method: null,
    payment_currency: null,
    registration_answers: answers,
    coupon_code: null,
    token_gate_info: null,
    eth_address_info: null,
    phone_number: null,
    solana_address_info: null,
    expected_amount_cents: 0,
    expected_amount_tax: 0,
    currency: null,
    event_invite_api_id: null,
    ticket_type_to_selection: {
      [ticket.api_id]: { count: 1, amount: 0 },
    },
    solana_address: null,
    solana_wallet_type: null,
    opened_from: null,
  };
}

/**
 * Decide + optionally execute an apply for one event detail payload.
 * Returns a result object; never throws for expected skip reasons.
 */
async function applyToEventDetail({ detail, profile, user, cookie, dryRun }) {
  const event = detail.event || {};
  const eventApiId = event.api_id || detail.api_id;
  const name = event.name || eventApiId;

  if (alreadyRegistered(detail)) {
    return { status: "already_registered", eventApiId, name };
  }

  const ticket = pickFreeTicket(detail.ticket_types);
  if (!ticket) {
    return { status: "skipped_paid_or_no_ticket", eventApiId, name };
  }

  const soldOut = detail.sold_out === true || detail.ticket_info?.is_sold_out === true;
  const waitlistActive = detail.waitlist_status === "enabled" || detail.waitlistActive === true;
  // event page uses waitlist from ticket_info / waitlist_status
  const waitlist =
    detail.event?.waitlist_status === "enabled" ||
    detail.waitlist_status === "enabled" ||
    waitlistActive;

  let forWaitlist = false;
  if (soldOut) {
    if (!waitlist) {
      return { status: "skipped_sold_out", eventApiId, name };
    }
    forWaitlist = true;
  }

  const { answers, missing } = buildRegistrationAnswers(
    detail.registration_questions || [],
    profile
  );
  if (missing.length > 0) {
    return {
      status: "skipped_missing_answers",
      eventApiId,
      name,
      missing,
      url: event.url ? `https://luma.com/${event.url}` : null,
    };
  }

  const payload = buildRegisterPayload({
    eventApiId,
    user,
    ticket,
    answers,
    forWaitlist,
  });

  if (dryRun) {
    return {
      status: "dry_run",
      eventApiId,
      name,
      forWaitlist,
      requireApproval: ticket.require_approval === true,
      answerCount: answers.length,
      url: event.url ? `https://luma.com/${event.url}` : null,
    };
  }

  const res = await requestJson("POST", "/event/register", { cookie, body: payload });
  if (res.status >= 200 && res.status < 300 && res.json?.status === "success") {
    return {
      status: forWaitlist ? "waitlisted" : "applied",
      eventApiId,
      name,
      approval: res.json?.guest_data?.approval_status || null,
      url: event.url ? `https://luma.com/${event.url}` : null,
    };
  }

  // Event full → waitlist available is a known Lu.ma error path.
  const code = res.json?.code || res.json?.error_code;
  if (code === "event_full_waitlist_available" || /waitlist/i.test(res.json?.message || "")) {
    if (!forWaitlist) {
      const retry = await requestJson("POST", "/event/register", {
        cookie,
        body: { ...payload, for_waitlist: true },
      });
      if (retry.status >= 200 && retry.status < 300 && retry.json?.status === "success") {
        return {
          status: "waitlisted",
          eventApiId,
          name,
          url: event.url ? `https://luma.com/${event.url}` : null,
        };
      }
    }
  }

  return {
    status: "failed",
    eventApiId,
    name,
    httpStatus: res.status,
    message: res.json?.message || res.raw?.slice(0, 200) || "unknown error",
    url: event.url ? `https://luma.com/${event.url}` : null,
  };
}

/**
 * For each new event on an auto-apply calendar, fetch detail and try to register.
 */
async function autoApplyToEvents(events, { calendarIds, cookie, profile }) {
  if (!cookie) {
    return { results: [], skippedReason: "no_cookie" };
  }
  if (!profile) {
    return { results: [], skippedReason: "no_profile" };
  }
  if (!calendarIds || calendarIds.size === 0) {
    return { results: [], skippedReason: "no_calendars" };
  }

  const candidates = (events || []).filter(
    (event) => event.calendar_api_id && calendarIds.has(event.calendar_api_id)
  );
  if (candidates.length === 0) {
    return { results: [], skippedReason: "no_matching_events" };
  }

  const dryRun = isDryRun();
  const user = await fetchSessionUser(cookie);
  const results = [];

  for (const event of candidates) {
    try {
      const detail = await fetchEventDetail(event.api_id, cookie);
      const result = await applyToEventDetail({
        detail,
        profile,
        user,
        cookie,
        dryRun,
      });
      results.push(result);
      const mark =
        result.status === "applied" || result.status === "waitlisted"
          ? "✅"
          : result.status === "dry_run"
            ? "🧪"
            : "↳";
      console.log(
        `${mark} auto-apply ${result.status}: ${result.name}` +
          (result.missing ? ` — missing: ${result.missing.join("; ")}` : "") +
          (result.message ? ` — ${result.message}` : "")
      );
    } catch (err) {
      const failed = {
        status: "failed",
        eventApiId: event.api_id,
        name: event.name,
        message: err.message,
        url: event.url || null,
      };
      results.push(failed);
      console.warn(`❌ auto-apply failed: ${event.name} — ${err.message}`);
    }
  }

  return { results, dryRun, skippedReason: null };
}

function formatAutoApplyEmail(results, { dryRun }) {
  if (!results || results.length === 0) return null;
  const title = dryRun ? "Auto-apply dry-run" : "Auto-apply results";
  const lines = results.map((r) => {
    const bits = [`• ${r.name}`, r.status];
    if (r.forWaitlist || r.status === "waitlisted") bits.push("waitlist");
    if (r.requireApproval) bits.push("needs approval");
    if (r.missing?.length) bits.push(`missing: ${r.missing.join(", ")}`);
    if (r.message) bits.push(r.message);
    if (r.url) bits.push(r.url);
    return bits.join(" — ");
  });
  return {
    subject: `${title}: ${results.length} event(s)`,
    text: [title, "", ...lines].join("\n"),
  };
}

module.exports = {
  API_HOST,
  alreadyRegistered,
  applyToEventDetail,
  autoApplyToEvents,
  buildRegisterPayload,
  buildRegistrationAnswers,
  formatAutoApplyEmail,
  isDryRun,
  loadAutoApplyCalendarIds,
  loadProfile,
  normalizePhone,
  normalizeProfile,
  pickFreeTicket,
};
