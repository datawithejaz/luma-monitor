const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractFoodInfo, formatFoodLines, mealTypesFrom } = require("./food");

function mirror(...paragraphs) {
  return {
    description_mirror: {
      type: "doc",
      content: paragraphs.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    },
  };
}

test("hard-break agenda lines stay as one breakfast sentence", () => {
  const food = extractFoodInfo({
    description_mirror: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "We'll be discussing:" },
            { type: "hard_break" },
            { type: "text", text: "• What makes an AI-pilled FDE" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Agenda:" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Breakfast and arrivals: 08:30–09:00" },
            { type: "hard_break" },
            { type: "text", text: "Roundtable discussion: 09:00–10:00" },
          ],
        },
      ],
    },
  });
  assert.equal(food.details, "Breakfast and arrivals: 08:30–09:00");
  assert.deepEqual(food.meal_types, ["breakfast"]);
});

test("breakfast agenda becomes an organiser claim with breakfast chip", () => {
  const food = extractFoodInfo(
    mirror(
      "Forward Deployed is a series of roundtables on applied AI.",
      "Breakfast and arrivals: 08:30–09:00",
      "Roundtable discussion: 09:00–10:00"
    )
  );
  assert.equal(food.badge, "CLAIM");
  assert.equal(food.status, "Organiser claim");
  assert.deepEqual(food.meal_types, ["breakfast"]);
  assert.match(food.details, /Breakfast and arrivals/);
  assert.equal(food.provided, null);
});

test("pay-at-venue copy is not treated as free food", () => {
  const food = extractFoodInfo(
    mirror("You'll pay for you food + drinks at location!")
  );
  assert.equal(food.badge, "PAY");
  assert.equal(food.status, "Pay at venue");
  assert.equal(food.provided, false);
  assert.ok(food.meal_types.includes("drinks"));
});

test("pizza and prosecco classifies as snacks + drinks and provided", () => {
  const food = extractFoodInfo(mirror("Pizza and prosecco from 7:20 PM"));
  assert.equal(food.badge, "CLAIM");
  assert.deepEqual(food.meal_types, ["snacks", "drinks"]);
  assert.equal(food.provided, null);
  assert.match(food.details, /Pizza and prosecco/);
});

test("served breakfast is marked provided", () => {
  const food = extractFoodInfo(mirror("Breakfast served from 08:30"));
  assert.equal(food.provided, true);
  assert.deepEqual(food.meal_types, ["breakfast"]);
});

test("no food language is a listing, not a claim", () => {
  const food = extractFoodInfo(
    mirror("A panel on AI safety grantmaking. No agenda published yet.")
  );
  assert.equal(food.badge, "LISTING");
  assert.equal(food.status, "No mention");
  assert.deepEqual(food.meal_types, []);
});

test("empty details stay unknown", () => {
  const food = extractFoodInfo({});
  assert.equal(food.badge, "UNKNOWN");
  assert.equal(food.status, "Unknown");
});

test("prose-mirror schema tokens are not mistaken for food", () => {
  const food = extractFoodInfo({
    description_mirror: { type: "doc", content: [{ type: "paragraph" }] },
  });
  assert.equal(food.status, "Unknown");
});

test("venue marketing is not preferred over a short food sentence", () => {
  const food = extractFoodInfo(
    mirror(
      "Venue: An exclusive rooftop venue featuring elegant lounges, panoramic skyline views, and a sophisticated atmosphere perfect for networking, after-work drinks, and meaningful business connections.",
      "Drinks from 6:30pm."
    )
  );
  assert.equal(food.badge, "CLAIM");
  assert.match(food.details, /Drinks from 6:30pm/i);
  assert.ok(!food.details.toLowerCase().includes("panoramic"));
});

test("mealTypesFrom keeps Forkcast chip order", () => {
  assert.deepEqual(mealTypesFrom("dinner drinks lunch pizza breakfast"), [
    "breakfast",
    "lunch",
    "dinner",
    "snacks",
    "drinks",
  ]);
});

test("formatFoodLines is email-ready", () => {
  const lines = formatFoodLines({
    badge: "CLAIM",
    status: "Organiser claim",
    meal_types: ["lunch", "dinner"],
    details: "Lunch at 12:30 and dinner at 19:00.",
    provided: true,
  });
  assert.deepEqual(lines, [
    "• Source: CLAIM — Organiser claim",
    "• Types: Lunch, Dinner",
    "• Provided: Listed as provided",
    "• Details: Lunch at 12:30 and dinner at 19:00.",
  ]);
});
