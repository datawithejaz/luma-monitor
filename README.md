# Luma London Monitor

Polls [Lu.ma London](https://lu.ma/london) on a schedule via GitHub Actions and
emails you when **new in-person Tech / AI / Marketing / Entrepreneurship events**
appear. Runs free on a public GitHub repo.

## How it works

1. Resolves the London discover page to its internal place id (from the page's
   `__NEXT_DATA__`), then pages through the public discover API:
   `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=<id>`
2. Filters each event: **in-person** (`location_type = offline`) **and** a
   category-keyword match (name / host / venue).
3. Diffs against `src/seen_events.json` to find genuinely new events.
4. New events → an email with name, date, venue, price and a direct link.
5. Commits the updated `src/seen_events.json` back to the repo (only when it
   changes), so the same event never alerts twice.

If the Gmail secrets aren't set yet, the monitor still runs, logs the new events,
and updates the seen list — it just skips sending. Email turns on the moment you
add the secrets, with no code change.

## Repository layout

```
luma-monitor/
├── src/
│   ├── monitor.js          # the monitor (fetch → filter → diff → email → save)
│   ├── package.json
│   ├── package-lock.json
│   └── seen_events.json    # state: ids already alerted on (tracked in git)
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
| `GMAIL_USER` | `ejazahmed.workemail@gmail.com` |
| `GMAIL_APP_PASSWORD` | a 16-character Gmail **App Password** (no spaces) |
| `NOTIFY_EMAIL` | `ejazahmed.workemail@gmail.com` |

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
- `LONDON_SLUG` — swap `london` for another city slug (`sf`, `nyc`, `paris`, …).
- `PAGINATION_LIMIT` / `MAX_PAGES` — how many events to scan per run.

## Notes

- Reads only public Lu.ma listing data via the same endpoints the website uses.
- The discover payload doesn't include ticket price, so price shows "Check page".

---

Author: Ejaz Ahmed
