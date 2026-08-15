/**
 * Parse Lu.ma's public event sitemap and pick a newest-first batch of
 * unchecked slugs. City discover (lu.ma/london) only lists a small featured
 * set; Forkcast and similar catalogues pick up the rest from this sitemap.
 */

const SITEMAP_HOSTS = new Set(["lu.ma", "www.lu.ma", "luma.com", "www.luma.com"]);
const SKIP_SLUGS = new Set([
  "discover", "home", "signin", "login", "create", "explore", "pricing",
  "about", "blog", "help", "calendar", "event",
]);

function slugFromLoc(loc) {
  try {
    const url = new URL(loc);
    if (!SITEMAP_HOSTS.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    const slug = parts[0];
    if (!slug || SKIP_SLUGS.has(slug.toLowerCase())) return null;
    return slug;
  } catch {
    return null;
  }
}

function parseSitemapXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  const bySlug = new Map();

  for (const block of blocks) {
    const loc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    if (!loc) continue;
    const slug = slugFromLoc(loc[1]);
    if (!slug) continue;
    const lastmodMatch = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i);
    const lastmod = lastmodMatch ? lastmodMatch[1] : "";
    const existing = bySlug.get(slug);
    if (!existing || lastmod > existing.lastmod) {
      bySlug.set(slug, { slug, lastmod, loc: loc[1] });
    }
  }

  return [...bySlug.values()];
}

/**
 * Newest lastmod first among slugs we have not resolved yet.
 * @param {{slug: string, lastmod: string}[]} entries
 * @param {Set<string>} checked
 * @param {number} limit
 */
function pickUncheckedBatch(entries, checked, limit) {
  return [...entries]
    .filter((entry) => entry.slug && !checked.has(entry.slug))
    .sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""))
    .slice(0, limit);
}

module.exports = {
  slugFromLoc,
  parseSitemapXml,
  pickUncheckedBatch,
};
