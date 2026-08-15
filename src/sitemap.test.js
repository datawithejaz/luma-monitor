const { test } = require("node:test");
const assert = require("node:assert/strict");
const { slugFromLoc, parseSitemapXml, pickUncheckedBatch } = require("./sitemap");

test("slugFromLoc accepts luma event URLs and skips discover paths", () => {
  assert.equal(slugFromLoc("https://luma.com/ao6vmoqp"), "ao6vmoqp");
  assert.equal(slugFromLoc("https://lu.ma/buildersclub02"), "buildersclub02");
  assert.equal(slugFromLoc("https://luma.com/discover/london/ai"), null);
  assert.equal(slugFromLoc("https://luma.com/home"), null);
});

test("parseSitemapXml keeps newest lastmod per slug", () => {
  const xml = `<?xml version="1.0"?>
  <urlset>
    <url><loc>https://luma.com/ao6vmoqp</loc><lastmod>2026-08-10T17:06:38.963Z</lastmod></url>
    <url><loc>https://luma.com/ao6vmoqp</loc><lastmod>2026-08-14T17:43:03.447Z</lastmod></url>
    <url><loc>https://luma.com/discover/london/ai</loc><lastmod>2026-08-15T00:00:00Z</lastmod></url>
    <url><loc>https://example.com/nope</loc><lastmod>2026-08-15T00:00:00Z</lastmod></url>
  </urlset>`;
  const entries = parseSitemapXml(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slug, "ao6vmoqp");
  assert.equal(entries[0].lastmod, "2026-08-14T17:43:03.447Z");
});

test("pickUncheckedBatch returns newest unchecked slugs first", () => {
  const entries = [
    { slug: "old", lastmod: "2026-07-01T00:00:00Z" },
    { slug: "mid", lastmod: "2026-08-10T00:00:00Z" },
    { slug: "new", lastmod: "2026-08-14T00:00:00Z" },
  ];
  const checked = new Set(["mid"]);
  const batch = pickUncheckedBatch(entries, checked, 2);
  assert.deepEqual(batch.map((e) => e.slug), ["new", "old"]);
});
