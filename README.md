# Luma London Monitor

Polls [Lu.ma London](https://lu.ma/london) on a schedule via GitHub Actions and
emails you when **new in-person Tech / AI / Marketing / Entrepreneurship events**
appear. Runs free on a public GitHub repo.

## How it works

1. **Collects calendars** from five sources, merged by priority:
   - `src/tracked_calendars.json` — your Lu.ma follows (synced automatically)
   - Your live Lu.ma subscriptions (needs `LUMA_AUTH_COOKIE`)
   - Calendars featured on the London discover page
   - Calendars extracted from the London discover feed
   - `src/known_calendars.json` — every calendar ever seen, polled forever
   - **Sitemap discovery** — see [Coverage](#coverage) below
2. **Fetches events** from the London discover feed *and* every known calendar
   (`https://api.lu.ma/calendar/get-items`), then dedupes by event id.
3. **Filters** to in-person (`location_type = offline`) London events that are
   still upcoming. Relevance depends on the calendar:
   - Calendars you follow are **trusted** — every London event alerts.
   - Everything else must match `CATEGORY_KEYWORDS` on name / host / description.
4. Diffs against `src/seen_events.json` to find genuinely new events.
5. New events → an email with name, date, venue, price and a direct link.
6. Commits updated state back to the repo (only when it changes), so the same
   event never alerts twice.

## Coverage

`lu.ma/london` is **capped at ~55 events** (Lu.ma's own `event_count`), so the
city page alone misses most of what's happening. Two mechanisms close that gap.

**Calendar polling.** Most events arrive here — roughly 210 of 265 per run come
from polling calendars directly rather than the city feed.

**Sitemap discovery** (`src/sitemap-discovery.js`). Calendar polling can only
reach calendars we already know, so a London event on an unknown calendar stays
invisible. Lu.ma publishes every public event and calendar in
`https://sitemap.luma.com/sitemap.xml` (~60k URLs). Each run resolves a batch of
slugs (default 250, ~40s), and any calendar running London events is added to
`known_calendars.json` permanently. A cursor in `src/sitemap_crawl.json` makes
the crawl resumable, so a full pass completes over many runs and then restarts
from the newest entries.

Tuning:

| Variable | Effect |
|---|---|
| `SITEMAP_BATCH_SIZE` | Slugs resolved per run (default 250) |
| `SKIP_SITEMAP_DISCOVERY=1` | Disable the crawl entirely |

## Which events alert

Following a calendar on Lu.ma is already a relevance signal, so events from
`tracked_calendars.json` skip keyword filtering — that's what previously dropped
things like *OpenAI Builder Lounge London* and *Claude Cyber Meetup*, whose
titles contain no matching keyword.

If a followed calendar is too noisy, opt it back into keyword filtering:

```json
{
  "api_id": "cal-xxxx",
  "slug": "some-calendar",
  "name": "Some Calendar",
  "reason": "User subscription",
  "keyword_filter": true
}
```

## Syncing your Lu.ma follows

**Required for new follows.** Without `LUMA_AUTH_COOKIE`, the workflow never
refreshes `tracked_calendars.json` — calendars you follow on Lu.ma after the
last manual sync stay invisible to the include-all filter (and may never be
polled). Every Actions run currently logs a warning when this secret is missing.

`src/sync-tracked-calendars.js` rewrites `tracked_calendars.json` from your live
Lu.ma Following list. It runs automatically before each monitor pass when
`LUMA_AUTH_COOKIE` is set, and can be run by hand:

```bash
cd src
LUMA_AUTH_COOKIE='...' npm run sync-calendars
```

Get the cookie from a signed-in browser: DevTools → Network → any `api.lu.ma`
request → copy the whole `Cookie` request header. Store it as the
`LUMA_AUTH_COOKIE` repository secret. Calendars with `include_all_events` are
pinned and survive the sync even if you unfollow them.

If the Gmail secrets aren't set yet, the monitor still runs, logs the new events,
and updates the seen list — it just skips sending. Email turns on the moment you
add the secrets, with no code change.

## Repository layout

```
luma-monitor/
├── src/
│   ├── monitor.js                 # the monitor (fetch → filter → diff → email → save)
│   ├── sync-tracked-calendars.js  # rewrite tracked list from your Lu.ma follows
│   ├── sitemap-discovery.js       # find London calendars via Lu.ma's sitemap
│   ├── package.json
│   ├── package-lock.json
│   ├── tracked_calendars.json     # config: calendars you follow
│   ├── known_calendars.json       # state: every calendar ever seen (auto)
│   ├── seen_events.json           # state: ids already alerted on (auto)
│   ├── event_meta.json            # state: per-event first-seen metadata (auto)
│   └── sitemap_crawl.json         # state: sitemap crawl cursor (auto)
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

| Secret | Value |
|---|---|
| `GMAIL_USER` | your Gmail address |
| `GMAIL_APP_PASSWORD` | [App Password](https://myaccount.google.com/apppasswords) |
| `NOTIFY_EMAIL` | where alerts should go |

Create an App Password at <https://myaccount.google.com/apppasswords> (requires
2-Step Verification). Gmail rejects your normal account password from scripts.

### 3. Add `LUMA_AUTH_COOKIE` (required to track new follows)
Without this secret, newly followed Lu.ma calendars never enter
`tracked_calendars.json`. Copy the full `Cookie` header from any signed-in
`api.lu.ma` request and store it as `LUMA_AUTH_COOKIE`.

### 4. Test it
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

- The cron asks for every **5 minutes** (`*/5 * * * *`). Edit it in
  `.github/workflows/luma-monitor.yml`.
- **In practice it runs ~7 times a day.** GitHub's scheduled-workflow cron is
  best-effort and heavily throttled: measured over 8 days, the gap between runs
  averaged 3.6 hours (median 2.9h, worst 11.2h) against the 5 minutes requested.
  Tightening the cron does not help — closing this gap needs an external trigger
  (a scheduler calling `workflow_dispatch`) or a runner outside GitHub cron.
- **Public repo → unlimited free Action minutes.** (On a private repo a 5–10 min
  cron would exceed the 2,000 free minutes/month; widen the interval if you make
  it private.)

## Customise

Edit `src/monitor.js`:
- `CATEGORY_KEYWORDS` — topics to match for calendars you don't follow.
- `AI_PATTERNS` — regexes catching AI spellings a word-boundary match misses
  (`OpenAI`, `GenAI`, `A.I.`, `AI/ML`).
- `LONDON_SLUG` — swap `london` for another city slug (`sf`, `nyc`, `paris`, …).
- `PAGINATION_LIMIT` / `MAX_PAGES` — how many events to scan per run.
- `MAX_CALENDARS_TO_POLL` — priority cap; registry calendars are always polled.
- `SITEMAP_BATCH_SIZE` — sitemap slugs resolved per run.

## Auth capability probe

`src/probe_auth.js` is a read-only diagnostic that reports what a signed-in
session (`LUMA_AUTH_COOKIE`) can see that the anonymous monitor can't. It calls
each endpoint twice — once anonymously, once with the cookie — and compares.

Run it from Actions → **Luma Auth Capability Probe → Run workflow**, or locally:

```bash
LUMA_AUTH_COOKIE='...' node src/probe_auth.js
```

It prints status codes, counts and field names only — never names, emails, bios
or social handles, because Actions logs on a public repo are public.

## Notes

- Reads only public Lu.ma listing data via the same endpoints the website uses.
- The discover payload doesn't include ticket price, so price shows "Check page".

---

Author: Ejaz Ahmed
