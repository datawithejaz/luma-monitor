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

Newly found calendars that you don't already follow land in a **weekly digest
email** with a follow link. Follow them on Lu.ma and the next run's cookie sync
adds them to `tracked_calendars.json` — you don't edit the repo. See
[Weekly calendar digest](#weekly-calendar-digest).

Tuning:

| Variable | Effect |
|---|---|
| `SITEMAP_BATCH_SIZE` | Slugs resolved per run (default 250) |
| `SKIP_SITEMAP_DISCOVERY=1` | Disable the crawl entirely |
| `CALENDAR_DIGEST_DAYS` | Days between unfollowed-calendar emails (default 7; `0` disables) |

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

## One alert per series

Lu.ma gives every date of a recurring event its own id, so a weekly meetup looks
like a stream of unrelated new events. `src/alerting.js` collapses them in two
passes:

1. **Within a run** — new events are grouped by organiser plus a normalised
   title, and only the nearest upcoming date is emailed. Normalising strips the
   things that differ between instalments: `#21`, `Class 2.0`, `4th`,
   `September 2026`, a `Brand:` prefix, and singular/plural drift. So *Open Code
   #20*, *#21* and *#22* are one alert, not three, and *TRD: London Startups
   Operator RunClub* matches *London Startup Operators RunClub*.
2. **Across runs** — a series that already emailed within the last 30 days is
   held back, because the later dates arrive in separate runs that never see
   each other. Held events are recorded in `seen_events.json` so they don't
   queue up.

Set `SERIES_REALERT_DAYS` to change the window, or `0` to alert on every date.
Both passes log what they held back, prefixed `↳ skip:` and `↳ hold:`.

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

The sync refuses to write when Lu.ma reports zero follows, or when the list
would more than halve. A 200 response with a renamed field looks exactly like
"you follow nothing", and that is how `calendars` → `infos` once emptied this
file and quietly sent every followed calendar back through keyword filtering.
The step fails loudly instead; use `ALLOW_TRACKED_SHRINK=1` if you really did
unfollow that many.

## Weekly calendar digest

Once a week the monitor emails London calendars it discovered that you don't
follow yet — name, upcoming London event count, how they were found (sitemap /
discover / featured), and a `https://lu.ma/<slug>` follow link.

Follow the ones you want on Lu.ma. The next run's `LUMA_AUTH_COOKIE` sync writes
them into `tracked_calendars.json` and they start alerting on every in-person
London event. Nothing is added to the tracked list from the digest itself.

Already-followed calendars and the pre-existing registry are omitted, so the
first email isn't a dump of everything already in `known_calendars.json`. The
first digest goes out as soon as something new is found; after that it waits
7 days. Set `CALENDAR_DIGEST_DAYS=0` to disable, or a different number to
change the interval.

If the Gmail secrets aren't set yet, the monitor still runs, logs the new events,
and updates the seen list — it just skips sending. Email turns on the moment you
add the secrets, with no code change.

## Repository layout

```
luma-monitor/
├── src/
│   ├── monitor.js                 # the monitor (fetch → filter → diff → email → save)
│   ├── alerting.js                # series dedupe + email batching (unit-tested)
│   ├── alerting.test.js           # node --test suite
│   ├── calendar-digest.js         # weekly unfollowed-calendar email (unit-tested)
│   ├── calendar-digest.test.js
│   ├── sync-tracked-calendars.js  # rewrite tracked list from your Lu.ma follows
│   ├── my-events.js               # fetch events you're registered for / hosting
│   ├── ics.js                     # build a RFC 5545 .ics from those events
│   ├── export-calendar.js         # write/email a personal .ics (never committed)
│   ├── tracked_calendars.json     # config: calendars you follow
│   ├── known_calendars.json       # state: every calendar ever seen (auto)
│   ├── calendar_digest.json       # state: last weekly calendar digest (auto)
│   ├── seen_events.json           # state: ids already alerted on (auto)
│   ├── event_meta.json            # state: per-event first-seen metadata (auto)
│   └── sitemap_crawl.json         # state: sitemap crawl cursor (auto)
├── .github/workflows/luma-monitor.yml
├── .github/workflows/luma-auth-probe.yml
├── .github/workflows/export-calendar.yml
├── .github/workflows/test.yml
├── README.md
└── .gitignore
```

## Your events on a work (Teams / Outlook) calendar

**Best option — live sync (recommended).** Lu.ma already publishes a personal
iCal feed of every event you're hosting or registered for (approved, waitlisted,
or pending). Wire it straight into Outlook; Teams uses the same calendar:

1. Open [lu.ma/settings](https://lu.ma/settings) → **Calendar Syncing**
2. **Add iCal Subscription** → choose **Outlook**
3. The feed refreshes on Outlook's schedule (~3–12h). New RSVPs appear
   automatically — no `.ics` email needed.

Docs: [iCal Syncing](https://help.luma.com/p/ical-syncing).

**Fallback — emailed `.ics`.** If work IT blocks external calendar
subscriptions, this repo can build a one-shot `.ics` of your registrations and
email it to `NOTIFY_EMAIL`. The file is **never committed** (the repo is public).

```bash
cd src
LUMA_AUTH_COOKIE='...' npm run export-calendar -- --email
```

Or Actions → **Export My Luma Calendar → Run workflow** (also runs weekly on
Sundays). Then in Outlook / Teams: **Calendar → Add calendar → Upload from
file**, or open the attachment and tap Add.

When `LUMA_AUTH_COOKIE` is set, the monitor also **skips alerting** on events
you're already registered for or hosting.

## Tests

```bash
cd src
npm test        # node --test — no network, no secrets
```

Covers series dedupe, email batching, the calendar-sync guards, and the weekly
calendar digest. CI runs it on every pull request and on pushes to `main`. The
fetch/filter path is not covered — it needs the live Lu.ma API — so exercise it
with a real run:

```bash
cd src
SKIP_SITEMAP_DISCOVERY=1 node monitor.js   # prints what it would send
```

Without the Gmail secrets this reports new events without sending or recording
them, which makes it safe to run against the committed state.

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

### Getting the real 5-minute cadence

Only an external trigger fixes the throttling. The workflow already accepts
`workflow_dispatch`, so any scheduler that can make one HTTPS request will do —
cron-job.org, a Cloudflare Worker cron, or a box you already own:

```bash
curl -fsS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_PAT" \
  https://api.github.com/repos/datawithejaz/luma-monitor/actions/workflows/luma-monitor.yml/dispatches \
  -d '{"ref":"main"}'
```

`GITHUB_PAT` needs a fine-grained token scoped to this repo with **Actions:
read and write**. Keep it in the scheduler — never as a repo secret, since a
token that can dispatch workflows shouldn't live in a public repo's settings.
The workflow's `concurrency` group already stops overlapping runs, so an
over-eager scheduler queues rather than doubles up.

## Customise

Edit `src/monitor.js`:
- `CATEGORY_KEYWORDS` — topics to match for calendars you don't follow.
- `AI_PATTERNS` — regexes catching AI spellings a word-boundary match misses
  (`OpenAI`, `GenAI`, `A.I.`, `AI/ML`).
- `LONDON_SLUG` — swap `london` for another city slug (`sf`, `nyc`, `paris`, …).
- `PAGINATION_LIMIT` / `MAX_PAGES` — how many events to scan per run.
- `MAX_CALENDARS_TO_POLL` — timeout guard on the final poll list (default 400,
  currently ~199 in use). Calendars are dropped lowest-priority first, so
  registry stragglers go before anything you follow.
- `SITEMAP_BATCH_SIZE` — sitemap slugs resolved per run.
- `MAX_EVENTS_PER_EMAIL` — events per message before it splits into parts.
- `SERIES_REALERT_DAYS` — cooldown before a recurring series can alert again.
- `CALENDAR_DIGEST_DAYS` — how often to email newly discovered unfollowed
  calendars (default 7; `0` disables).

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
