"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classify,
  partition,
  parseGuestsCsv,
  joinEmails,
  counts,
  formatStatusReport,
  unclaimedEmails,
  parseArgs,
  extractCode,
} = require("./credits");

const guest = (over = {}) => ({
  id: "gst-aaa",
  name: "Ada Lovelace",
  hasRedeemed: false,
  checkedIn: false,
  status: "going",
  ...over,
});

test("checked-in unclaimed is the request list", () => {
  const groups = partition([
    guest({ id: "gst-1", name: "Ada", checkedIn: true, hasRedeemed: false, status: "checked_in" }),
    guest({ id: "gst-2", name: "Grace", checkedIn: true, hasRedeemed: true, status: "checked_in" }),
    guest({ id: "gst-3", name: "Alan", checkedIn: false, hasRedeemed: false, status: "going" }),
  ]);
  assert.deepEqual(
    groups.checked_in_unclaimed.map((p) => p.name),
    ["Ada"]
  );
  assert.deepEqual(
    groups.checked_in_claimed.map((p) => p.name),
    ["Grace"]
  );
  assert.deepEqual(
    groups.not_checked_in.map((p) => p.name),
    ["Alan"]
  );
  assert.equal(counts(groups).total, 3);
});

test("status string checked_in counts even if checkedIn is missing", () => {
  const row = classify({ id: "gst-1", name: "Ada", status: "checked_in" });
  assert.equal(row.checkedIn, true);
  assert.equal(row.bucket, "checked_in_unclaimed");
});

test("Luma guests CSV joins email by guest id then name", () => {
  const csv = [
    "Name,Email,Guest ID",
    "Ada Lovelace,ada@example.com,gst-1",
    "Grace Hopper,grace@example.com,gst-2",
  ].join("\n");
  const guests = parseGuestsCsv(csv);
  const joined = joinEmails(
    [
      { id: "gst-1", name: "Ada Lovelace", email: null },
      { id: "gst-9", name: "grace hopper", email: null },
      { id: "gst-8", name: "Unknown", email: null },
    ],
    guests
  );
  assert.equal(joined[0].email, "ada@example.com");
  assert.equal(joined[1].email, "grace@example.com");
  assert.equal(joined[2].email, null);
});

test("quoted CSV fields with commas still parse", () => {
  const csv = 'Name,Email\n"Wald, Adrien",adrien@example.com\n';
  const guests = parseGuestsCsv(csv);
  assert.equal(guests[0].name, "Wald, Adrien");
  assert.equal(guests[0].email, "adrien@example.com");
});

test("unclaimed emails only includes checked-in people with an email", () => {
  const groups = partition([
    guest({
      id: "gst-1",
      name: "Ada",
      checkedIn: true,
      hasRedeemed: false,
      status: "checked_in",
      email: "ada@example.com",
    }),
    guest({
      id: "gst-2",
      name: "Grace",
      checkedIn: true,
      hasRedeemed: false,
      status: "checked_in",
    }),
  ]);
  groups.checked_in_unclaimed = joinEmails(groups.checked_in_unclaimed, [
    { id: "gst-1", name: "Ada", email: "ada@example.com" },
  ]);
  assert.deepEqual(unclaimedEmails(groups), ["ada@example.com"]);
});

test("status report names the unclaimed bucket first", () => {
  const groups = partition([
    guest({ id: "gst-1", name: "Ada", checkedIn: true, status: "checked_in" }),
  ]);
  const text = formatStatusReport(groups);
  assert.match(text, /Checked in, not claimed: 1/);
  assert.match(text, /Ada/);
  assert.doesNotMatch(text, /Registered — not checked in/);
});

test("parseArgs reads claim flags", () => {
  const args = parseArgs([
    "--claim",
    "--name",
    "Ada Lovelace",
    "--email",
    "ada@example.com",
    "--guests",
    "guests.csv",
  ]);
  assert.equal(args.claim, true);
  assert.equal(args.name, "Ada Lovelace");
  assert.equal(args.email, "ada@example.com");
  assert.equal(args.guests, "guests.csv");
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--scrape"]), /Unknown argument/);
});

test("extractCode prefers a promo code then a redeem URL", () => {
  assert.equal(extractCode({ promoCode: "CURSORxxx" }), "CURSORxxx");
  assert.equal(extractCode({ cursorUrl: "https://cursor.com/redeem/abc" }), "https://cursor.com/redeem/abc");
  assert.equal(extractCode({}), null);
});
