"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatCompactDay,
  formatCompactTime,
  formatPlace,
  formatCardPrice,
  formatEventCard,
  batchEmailSubject,
  formatAlertEmailBody,
} = require("./email-format");

// 2026-09-25T17:00:00Z = 18:00 in London (BST)
const START = "2026-09-25T17:00:00.000Z";

function sample(overrides = {}) {
  return {
    name: "OpenAI Builder Lounge London",
    start_at: START,
    venue: "London",
    is_free: true,
    price_label: "FREE",
    url: "https://lu.ma/openai-builder-lounge",
    ...overrides,
  };
}

test("compact day and time match the one-liner card", () => {
  assert.equal(formatCompactDay(START), "Fri 25 Sep");
  assert.equal(formatCompactTime(START), "18:00");
});

test("missing start_at falls back to TBC", () => {
  assert.equal(formatCompactDay(""), "TBC");
  assert.equal(formatCompactTime(null), "TBC");
});

test("place keeps a short venue name and collapses long addresses", () => {
  assert.equal(formatPlace(""), "London");
  assert.equal(formatPlace("Newspeak House"), "Newspeak House");
  assert.equal(
    formatPlace("Newspeak House, 133 Bethnal Green Rd, London"),
    "Newspeak House"
  );
  assert.equal(
    formatPlace("A".repeat(40) + ", London"),
    "London"
  );
});

test("card price prefers Free over FREE", () => {
  assert.equal(formatCardPrice({ is_free: true, price_label: "FREE" }), "Free");
  assert.equal(formatCardPrice({ price_label: "£10" }), "£10");
  assert.equal(formatCardPrice({}), null);
});

test("event card is three plain lines", () => {
  const card = formatEventCard(sample());
  assert.equal(
    card,
    [
      "OpenAI Builder Lounge London",
      "Fri 25 Sep · 18:00 · London · Free",
      "https://lu.ma/openai-builder-lounge",
    ].join("\n")
  );
});

test("paid events keep the price label and omit Free", () => {
  const card = formatEventCard(
    sample({ is_free: false, price_label: "£15", venue: "Shoreditch" })
  );
  assert.match(card, /Fri 25 Sep · 18:00 · Shoreditch · £15/);
});

test("unknown price drops the price segment", () => {
  const card = formatEventCard(sample({ is_free: false, price_label: null }));
  assert.equal(
    card.split("\n")[1],
    "Fri 25 Sep · 18:00 · London"
  );
});

test("subject is the event name, or a plain count for batches", () => {
  assert.equal(batchEmailSubject([sample()]), "OpenAI Builder Lounge London");
  assert.equal(
    batchEmailSubject([sample(), sample({ name: "Other" })]),
    "2 new London events"
  );
});

test("batch body separates cards with a blank line", () => {
  const body = formatAlertEmailBody([
    sample(),
    sample({ name: "Claude Cyber Meetup", url: "https://lu.ma/claude" }),
  ]);
  assert.equal(
    body,
    [
      "OpenAI Builder Lounge London",
      "Fri 25 Sep · 18:00 · London · Free",
      "https://lu.ma/openai-builder-lounge",
      "",
      "Claude Cyber Meetup",
      "Fri 25 Sep · 18:00 · London · Free",
      "https://lu.ma/claude",
    ].join("\n")
  );
});
