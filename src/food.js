/**
 * Structured food extraction from Lu.ma event details.
 *
 * Forkcast stores organiser food text as a claim (not a keyword snippet),
 * with meal-type chips and a provided vs pay-at-venue distinction. This
 * module does the same with rules — no LLM — so alert emails can show
 * CLAIM / PAY AT VENUE / NO MENTION instead of a 60-character window.
 */

const MEAL_TYPES = [
  { type: "breakfast", re: /\b(breakfast|brunch)\b/i },
  { type: "lunch", re: /\blunch(?:es)?\b/i },
  { type: "dinner", re: /\b(dinner|dinners|supper)\b/i },
  { type: "snacks", re: /\b(snacks?|nibbles?|canap[eé]s?|bites?|pizza|pizzas|buffet|refreshments?|catering|finger foods?)\b/i },
  { type: "drinks", re: /\b(drinks?|beer|beers|wine|prosecco|cocktails?|beverages?)\b/i },
];

const FOOD_SIGNAL_RE =
  /\b(food|foods|pizza|pizzas|dinner|dinners|lunch|lunches|breakfast|brunch|snack|snacks|nibble|nibbles|refreshment|refreshments|drink|drinks|catering|buffet|bbq|sushi|taco|tacos|sandwich|sandwiches|beer|beers|wine|canape|canapes|canapé|canapés|meal|meals|prosecco|cocktails?|nibbles?|bites?)\b/i;

const PAY_OWN_RE =
  /\b(pay for (your|you) (own )?food|you'll pay|you will pay|bring your own|byo|not provided|food \+ drinks at location|own food and drinks)\b/i;

const PROVIDED_RE =
  /\b(provided|served|included|complimentary|catering|free (pizza|food|drinks?|lunch|dinner|breakfast|brunch))\b/i;

const PROSE_MIRROR_TYPES = new Set([
  "doc",
  "paragraph",
  "text",
  "hard_break",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "content",
]);

function flattenText(value, depth = 0) {
  if (value == null || depth > 12) return "";
  if (typeof value === "string") {
    return PROSE_MIRROR_TYPES.has(value) ? "" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item, depth + 1)).join("");
  }
  if (typeof value === "object") {
    if (value.type === "hard_break") return "\n";
    if (value.type === "paragraph" || value.type === "heading" || value.type === "listItem") {
      const inner = flattenText(value.content, depth + 1).trim();
      return inner ? `${inner}\n` : "";
    }
    if (typeof value.text === "string") return value.text;
    if (value.content) return flattenText(value.content, depth + 1);
    return Object.entries(value)
      .filter(([key]) => key !== "type" && key !== "attrs")
      .map(([, item]) => flattenText(item, depth + 1))
      .join("");
  }
  return "";
}

function listingText(detail) {
  if (!detail || typeof detail !== "object") return "";
  const mirror = detail.description_mirror || detail.event?.description_mirror;
  const agenda = detail.agenda || detail.event?.agenda;
  const description = detail.description || detail.event?.description;
  const parts = [];
  if (mirror) parts.push(flattenText(mirror));
  else if (description) parts.push(flattenText(description));
  if (agenda) parts.push(flattenText(agenda));
  return parts
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\s*[·•]\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mealTypesFrom(text) {
  return MEAL_TYPES.filter(({ re }) => re.test(text)).map(({ type }) => type);
}

function bestDetails(text) {
  const sentences = splitSentences(text);
  const hits = sentences.filter((sentence) => FOOD_SIGNAL_RE.test(sentence));
  if (hits.length === 0) return "";

  // Prefer short, food-forward sentences over venue marketing copy.
  hits.sort((a, b) => {
    const aProvided = PROVIDED_RE.test(a) || PAY_OWN_RE.test(a) ? 1 : 0;
    const bProvided = PROVIDED_RE.test(b) || PAY_OWN_RE.test(b) ? 1 : 0;
    if (bProvided !== aProvided) return bProvided - aProvided;
    return a.length - b.length;
  });

  const chosen = [];
  const seenTypes = new Set();
  for (const sentence of hits) {
    const types = mealTypesFrom(sentence);
    const addsType = types.some((type) => !seenTypes.has(type));
    if (chosen.length === 0) {
      chosen.push(sentence);
      types.forEach((type) => seenTypes.add(type));
      continue;
    }
    if (!addsType || sentence.length > 140) continue;
    chosen.push(sentence);
    types.forEach((type) => seenTypes.add(type));
    if (chosen.length >= 2) break;
  }
  return chosen
    .map((sentence) => (sentence.length > 220 ? `${sentence.slice(0, 217).trim()}…` : sentence))
    .join(" ");
}

/**
 * @returns {{
 *   status: "Unknown" | "No mention" | "Pay at venue" | "Organiser claim",
 *   badge: "UNKNOWN" | "LISTING" | "PAY" | "CLAIM",
 *   meal_types: string[],
 *   details: string,
 *   provided: boolean | null
 * }}
 */
function extractFoodInfo(detail) {
  if (!detail || typeof detail !== "object") {
    return {
      status: "Unknown",
      badge: "UNKNOWN",
      meal_types: [],
      details: "No event details available.",
      provided: null,
    };
  }

  const text = listingText(detail);
  if (!text) {
    return {
      status: "Unknown",
      badge: "UNKNOWN",
      meal_types: [],
      details: "Food info is not published in details.",
      provided: null,
    };
  }

  if (!FOOD_SIGNAL_RE.test(text)) {
    return {
      status: "No mention",
      badge: "LISTING",
      meal_types: [],
      details: "No explicit food/drinks mention found.",
      provided: null,
    };
  }

  const details = bestDetails(text);
  const meal_types = mealTypesFrom(`${details} ${text}`);
  const payOwn = PAY_OWN_RE.test(text);
  const provided = payOwn ? false : PROVIDED_RE.test(text) ? true : null;

  if (payOwn) {
    return {
      status: "Pay at venue",
      badge: "PAY",
      meal_types,
      details: details || "You'll pay for food/drinks at the venue.",
      provided: false,
    };
  }

  return {
    status: "Organiser claim",
    badge: "CLAIM",
    meal_types,
    details: details || "Food/drinks mentioned in the listing.",
    provided,
  };
}

function formatFoodLines(food) {
  const types =
    food.meal_types.length > 0
      ? food.meal_types.map((type) => type.charAt(0).toUpperCase() + type.slice(1)).join(", ")
      : "—";
  const provided =
    food.provided === true ? "Listed as provided" : food.provided === false ? "Not provided" : "Unclear";
  return [
    `• Source: ${food.badge} — ${food.status}`,
    `• Types: ${types}`,
    `• Provided: ${provided}`,
    `• Details: ${food.details}`,
  ];
}

module.exports = {
  extractFoodInfo,
  formatFoodLines,
  listingText,
  mealTypesFrom,
};
