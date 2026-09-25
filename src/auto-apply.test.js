"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRegistrationAnswers,
  formatAutoApplyEmail,
  isDryRun,
  loadAutoApplyCalendarIds,
  normalizePhone,
  normalizeProfile,
  pickFreeTicket,
  alreadyRegistered,
} = require("./auto-apply");

const profile = normalizeProfile({
  linkedin: "https://www.linkedin.com/in/ejazamir/",
  company: "Cytiva",
  role: "B2B Marketing Analyst",
  why_attend: "Meet people, learn about AI/tech and londonmaxx.",
  phone: "07470807682",
  country: "United Kingdom",
  agree_terms: true,
  marketing_opt_in: false,
});

test("phone normalises UK local to E.164", () => {
  assert.equal(normalizePhone("07470807682"), "+447470807682");
  assert.equal(normalizePhone("+447470807682"), "+447470807682");
});

test("linkedin handle is derived from profile URL", () => {
  assert.equal(profile.linkedin_handle, "ejazamir");
});

test("dry-run defaults on unless AUTO_APPLY_DRY_RUN=0", () => {
  const prev = process.env.AUTO_APPLY_DRY_RUN;
  delete process.env.AUTO_APPLY_DRY_RUN;
  assert.equal(isDryRun(), true);
  process.env.AUTO_APPLY_DRY_RUN = "0";
  assert.equal(isDryRun(), false);
  process.env.AUTO_APPLY_DRY_RUN = "1";
  assert.equal(isDryRun(), true);
  if (prev === undefined) delete process.env.AUTO_APPLY_DRY_RUN;
  else process.env.AUTO_APPLY_DRY_RUN = prev;
});

test("auto-apply calendar ids come from the flag only", () => {
  const ids = loadAutoApplyCalendarIds([
    { api_id: "cal-a", auto_apply: true },
    { api_id: "cal-b", auto_apply: false },
    { api_id: "cal-c" },
  ]);
  assert.deepEqual([...ids], ["cal-a"]);
});

test("pickFreeTicket prefers free types and skips hidden", () => {
  const ticket = pickFreeTicket([
    { api_id: "paid", type: "paid", cents: 1000 },
    { api_id: "hidden", type: "free", is_hidden: true },
    { api_id: "free", type: "free", cents: null, require_approval: true },
  ]);
  assert.equal(ticket.api_id, "free");
});

test("alreadyRegistered detects guest_data", () => {
  assert.equal(alreadyRegistered({ guest_data: null }), false);
  assert.equal(
    alreadyRegistered({ guest_data: { approval_status: "approved", api_id: "gst-1" } }),
    true
  );
});

test("builds answers for company, linkedin, terms, and why-attend text", () => {
  const questions = [
    {
      id: "company",
      label: "Company",
      required: true,
      question_type: "company",
      collect_job_title: true,
    },
    {
      id: "li",
      label: "What is your LinkedIn profile?",
      required: true,
      question_type: "linkedin",
    },
    {
      id: "why",
      label: "What brings you to this event?",
      required: true,
      question_type: "text",
    },
    {
      id: "terms",
      label: "Event Terms",
      required: true,
      question_type: "terms",
    },
    {
      id: "mkt",
      label: "I agree to receive marketing communications",
      required: false,
      question_type: "agree-check",
    },
  ];

  const { answers, missing } = buildRegistrationAnswers(questions, profile);
  assert.deepEqual(missing, []);
  assert.equal(answers.length, 5);

  const byId = Object.fromEntries(answers.map((a) => [a.question_id, a]));
  assert.deepEqual(byId.company.value, {
    company: "Cytiva",
    job_title: "B2B Marketing Analyst",
  });
  assert.equal(byId.li.value, "ejazamir");
  assert.equal(byId.why.value, profile.why_attend);
  assert.equal(byId.terms.value, true);
  assert.equal(byId.mkt.value, false);
});

test("required dropdown without a default is reported missing", () => {
  const { answers, missing } = buildRegistrationAnswers(
    [
      {
        id: "exp",
        label: "What is your experience level with Claude Code?",
        required: true,
        question_type: "dropdown",
        options: ["Daily user", "New but highly interested"],
      },
    ],
    profile
  );
  assert.equal(answers.length, 0);
  assert.deepEqual(missing, ["What is your experience level with Claude Code?"]);
});

test("dropdown_defaults fill required selects when the option exists", () => {
  const withDefaults = normalizeProfile({
    ...profile,
    dropdown_defaults: {
      "experience level with Claude": "New but highly interested",
    },
  });
  const { answers, missing } = buildRegistrationAnswers(
    [
      {
        id: "exp",
        label: "What is your experience level with Claude Code?",
        required: true,
        question_type: "dropdown",
        options: ["Daily user", "New but highly interested"],
      },
    ],
    withDefaults
  );
  assert.deepEqual(missing, []);
  assert.equal(answers[0].value, "New but highly interested");
});

test("country dropdown uses profile.country", () => {
  const { answers, missing } = buildRegistrationAnswers(
    [
      {
        id: "country",
        label: "Country",
        required: true,
        question_type: "dropdown",
        options: ["France", "United Kingdom", "United States"],
      },
    ],
    profile
  );
  assert.deepEqual(missing, []);
  assert.equal(answers[0].value, "United Kingdom");
});

test("novabook-style questions get safe defaults", () => {
  const { answers, missing } = buildRegistrationAnswers(
    [
      {
        id: "deck",
        label: "Please link to your pitch deck here (put N/A if not interested in pitching)",
        required: true,
        question_type: "text",
      },
      {
        id: "web",
        label: "Company website",
        required: true,
        question_type: "url",
      },
      {
        id: "stage",
        label: "Company stage",
        required: true,
        question_type: "dropdown",
        options: ["Ideation", "Other"],
      },
      {
        id: "vert",
        label: "Vertical",
        required: true,
        question_type: "multi-select",
        options: ["AI", "Life Sciences", "FinTech"],
      },
      {
        id: "call",
        label: "Would you like a free introductory call with Novabook?",
        required: true,
        question_type: "dropdown",
        options: ["Yes please", "No thanks", "I'm already a client"],
      },
    ],
    profile
  );
  assert.deepEqual(missing, []);
  const byId = Object.fromEntries(answers.map((a) => [a.question_id, a]));
  assert.equal(byId.deck.value, "N/A");
  assert.equal(byId.web.value, "https://www.cytiva.com");
  assert.equal(byId.stage.value, "Other");
  assert.deepEqual(byId.vert.value.sort(), ["AI", "Life Sciences"].sort());
  assert.equal(byId.call.value, "No thanks");
});

test("AI and SaaS vertical aliases match event options", () => {
  const withAlias = normalizeProfile({
    ...profile,
    verticals: ["AI and SaaS"],
  });
  const { answers, missing } = buildRegistrationAnswers(
    [
      {
        id: "v1",
        label: "Vertical",
        required: true,
        question_type: "multi-select",
        options: ["AI", "SaaS", "DeepTech"],
      },
      {
        id: "v2",
        label: "Vertical",
        required: true,
        question_type: "multi-select",
        options: ["DeepTech", "AI & SaaS", "Other"],
      },
    ],
    withAlias
  );
  assert.deepEqual(missing, []);
  const byId = Object.fromEntries(answers.map((a) => [a.question_id, a]));
  assert.deepEqual(byId.v1.value.sort(), ["AI", "SaaS"]);
  assert.deepEqual(byId.v2.value, ["AI & SaaS"]);
});

test("waitlistAvailable recognises active waitlist fields", () => {
  const { waitlistAvailable } = require("./auto-apply");
  assert.equal(
    waitlistAvailable({
      sold_out: true,
      waitlist_active: true,
      event: { waitlist_status: "active", waitlist_enabled: true },
    }),
    true
  );
  assert.equal(waitlistAvailable({ sold_out: true, event: {} }), false);
});

test("formatAutoApplyEmail summarises dry-run results", () => {
  const mail = formatAutoApplyEmail(
    [
      {
        name: "OpenAI Lounge",
        status: "dry_run",
        requireApproval: true,
        url: "https://luma.com/x",
      },
    ],
    { dryRun: true }
  );
  assert.match(mail.subject, /dry-run/i);
  assert.match(mail.text, /OpenAI Lounge/);
  assert.match(mail.text, /needs approval/);
});
