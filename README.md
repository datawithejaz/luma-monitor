# Luma London Monitor

Polls [Lu.ma London](https://lu.ma/london) on a schedule via GitHub Actions and
emails you when **new in-person Tech / AI / Marketing / Entrepreneurship events**
appear. Runs free on a public GitHub repo.

## How it works

1. Resolves the London discover page to its internal place id (from the page's
   `__NEXT_DATA__`), then pages through the public discover API:
   `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=<id>`
2. Also polls host calendars (featured, followed, tracked, and previously seen)
   and scans Lu.ma's public event sitemap for London listings that never appear
   on [lu.ma/london](https://lu.ma/london) — city discover is only a small
   featured set.
3. Filters each event: **in-person** (`location_type = offline`) **and** a
   category match (title/host keywords **or** Lu.ma's own `cat-ai` / `cat-tech`
   / `cat-crypto` tags).
4. Diffs against `src/seen_events.json` to find genuinely new events.
5. New events → an email with name, date, venue, price and a direct link.
6. Commits updated state (`seen_events.json`, `sitemap_checked.json`, …) back to
   the repo so the same event never alerts twice.

If the Gmail secrets aren't set yet, the monitor still runs, logs the new events,
and updates the seen list — it just skips sending. Email turns on the moment you
add the secrets, with no code change.

## Repository layout

```
luma-monitor/
├── src/
│   ├── monitor.js          # the monitor (fetch → filter → diff → email → save)
│   ├── sitemap.js          # Lu.ma sitemap parse (events missing from city discover)
│   ├── package.json
│   ├── package-lock.json
│   ├── seen_events.json    # state: ids already alerted on (tracked in git)
│   └── sitemap_checked.json # sitemap slugs already resolved (tracked in git)
├── .github/workflows/luma-monitor.yml
├── README.md
└── .gitignore
```

## Setup

### 1. Enable Actions
Repo → **Actions** tab → enable workflows (public repos run scheduled workflows
automatically once enabled).

### 2. Add the Gmail secrets (required for email)
Repo → **Settings → Secrets and variables → Actions → New repository secret**:


Create an App Password at <https://myaccount.google.com/apppasswords> (requires
2-Step Verification). Gmail rejects your normal account password from scripts.

### 3. Test it
Actions → **Luma London Monitor → Run workflow**. Each run writes a summary to the
Actions log; new events are committed to `src/seen_events.json`.

## Run locally

```bash
cd src
npm install
# without email — just prints what it would alert on and updates seen_events.json
node monitor.js
# with email
GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx NOTIFY_EMAIL=you@gmail.com node monitor.js
```

## Schedule & cost

- Polls every **10 minutes** (`*/10 * * * *`). Edit the `cron` in
  `.github/workflows/luma-monitor.yml` to change it (e.g. `*/5 * * * *`).
- GitHub's cron is **best-effort** — runs are often delayed and can be skipped
  under load. Treat the interval as a target, not a guarantee.
- **Public repo → unlimited free Action minutes.** (On a private repo a 5–10 min
  cron would exceed the 2,000 free minutes/month; widen the interval if you make
  it private.)

## Customise

Edit `src/monitor.js`:
- `CATEGORY_KEYWORDS` — topics to match (currently broad: tech, ai, marketing,
  entrepreneurship, business, networking, startup, data, product, design, …).
- Lu.ma `cat-ai` / `cat-tech` / `cat-crypto` tags also count, even when the
  title doesn't contain those words (e.g. Prompt Club, CapCut).
- `LONDON_SLUG` — swap `london` for another city slug (`sf`, `nyc`, `paris`, …).
- `PAGINATION_LIMIT` / `MAX_PAGES` — how many events to scan per run.
- `SITEMAP_BATCH` env — sitemap slugs resolved per run (default 200, or 400
  while the checked list is still catching up).

## Notes

- Reads only public Lu.ma listing data via the same endpoints the website uses.
- The discover payload doesn't include ticket price, so price shows "Check page".

---

Author: Ejaz Ahmed
