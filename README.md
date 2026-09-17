# The Scorecard

A standalone, non-partisan static website that rates the Australian Government's performance against published benchmarks using official data, with every figure linked to its source and re-verified daily. It carries no party branding — the goal is a site anyone, of any political persuasion, can use to check the numbers.

## Pages

| Page | What it does |
|---|---|
| `index.html` | Hero tally, report card, and 30 metric cards in 8 sections. Each card has a status, benchmark, chart, context, (i) explainer and sources. |
| `budget.html` | Revenue and expense pie charts side by side (2026–27 Budget / 2024–25 actual), with full line-item tables. |
| `categories.html` | Interactive 3D model of the Scorecard's own 8 measurement categories, drawn as planets orbiting an Australian-flag sun: coloured and glowing by how many measures are off track, with each measure as a small orbiting "moon". No external content — every label and number comes straight from `data/metrics.js`. Uses a locally vendored three.js r128 (`assets/three.min.js`). A text version and no-WebGL fallback are built in. |
| `sources.html` | How verification works, the report-an-error form (`#report-error`; each card links to it with the measure pre-selected), the FAQ, the latest automated check log, and every source grouped by publisher. |
| `subscribe.html` | Email-update signup with per-measure alerts, "customise your view" preferences (pinned categories, default filter — applied by `index.html`), a suggest-a-measure form, and a "your saved data" card (unsubscribe / delete everything, both behind a confirmation dialog). Submissions go to Formspree; preferences are kept in the visitor's browser (`localStorage`). |
| `404.html` | Served by GitHub Pages for any missing URL. Sets a `<base>` so it works at any depth, offers search and links to every page. |

## Site-wide features (`assets/site.js`)

Loaded last on every page. Light/dark theme toggle (follows the system setting until the visitor chooses; chart colours are CSS variables so they switch instantly), mobile menu (≤900px), full-site search (header button, <kbd>⌘/Ctrl K</kbd> or <kbd>/</kbd>; searches measures, categories, pages and FAQ), scroll progress bar, back-to-top and feedback buttons, a plain cookie notice (the site sets no cookies), footer email signup, reusable confirmation dialogs (`window.Site.confirm`), UTM tags on outbound links (`utm_source=the-scorecard`; data files and API hosts are skipped because they can reject unknown parameters), and opening source lists before printing. Every page also has a skip-to-content link and a print stylesheet. Each metric card shows when it was last checked and has "Copy link" / "Copy citation" buttons.

Local CSS/JS references carry a `?v=` stamp: bump it in all six HTML files when those files change, so returning visitors don't mix new pages with cached old assets.

## How the data stays correct

`pipeline/update.py` uses only the Python standard library and runs once a day via `.github/workflows/daily-update.yml`. Each run:

1. Downloads RBA statistical tables (G1, H1–H5, F1.1, F6, A2) and ABS Data API series (CPI, WPI, Labour Force, Labour Account, Building Activity, Total Value of Dwellings, population).
2. Recomputes every headline, benchmark, rating and context sentence from the raw data. Nothing numeric is typed into the automated metrics.
3. Runs checks:
   - **Cross-source:** RBA vs ABS inflation, unemployment and wages; the Labour Account's public + private jobs must equal total jobs; the RBA's latest rate decision must match its cash rate series; every actual year of gross debt (2005–06 onward) must match the AOFM register of securities on issue. AOFM's server often times out for GitHub's runners, so each successful read is saved to `data/aofm_eofy_snapshot.json` and reused (with its real retrieval date, logged as a warning) when only the download fails.
   - **Range:** every value must be plausible.
   - **Freshness:** each source must still be updating.
   - **Revisions:** changes to already-published figures are logged.
   - **Budget totals:** pie categories must add to the published totals.
   - **Links:** every cited source link must resolve.
   - **Re-check dates:** hand-verified figures past their `recheck_by` date are flagged.
4. If a critical check fails, keeps the last verified value, flags it "under review" on the site, and fails the GitHub Action so you get an email.
5. Writes `data/metrics.json` / `metrics.js` (site data) and `data/verification.json` / `verification.js` (public audit log, last 90 runs).

`categories.html` reads the same `data/metrics.js` output directly — there's nothing separate to keep in sync.

Run it locally:

```bash
python3 pipeline/update.py
```

## Hand-verified figures (`data/manual.json`)

Some figures aren't published as data feeds: Budget papers, AER/ESC default offers, APSC headcount, ASIC insolvencies, NDIS, bulk billing, emissions, defence and legislation counts. For these:

1. Update the values from the source document. Never from media reports if an official source exists.
2. Set `verified_on` to today and `recheck_by` to the source's next release.
3. Run the pipeline. It validates totals, checks links and publishes.

Upcoming re-checks:
- **2025–26 Final Budget Outcome** (due by 30 Sep 2026): update `gross_debt`, `budget_balance`, `interest_costs`, `spending_gdp` and the `budget` block. For `gross_debt`, replace the 2025–26 estimate ($982.0bn) with the actual, move `estimateFrom` to `2026-07-01`, and confirm it matches the AOFM 30 June 2026 figure the pipeline reports ($971.4bn as of 14 Sep 2026).
- **APSC 30 June 2026 data:** update `aps_headcount`.

## Before going live: checklist

- [x] **Forms connected to Formspree** (`formEndpoint` in `assets/config.js`): sign-ups, unsubscribes, suggestions and error reports are emailed to the Formspree account owner, labelled by `form_type`. Digests and alerts themselves are not automated: send them from your email tool using the sign-ups you receive.
- [ ] **Human spot-check of every hand-verified figure** in `data/manual.json` against its source. These were researched and cross-checked but should get a second pair of eyes before launch.
- [ ] Review the status rules and commentary wording for tone before publishing widely.
- [x] Deploy: push this folder to a GitHub repo and enable **Pages** (Settings → Pages → deploy from branch `main`, root). Or connect the repo to Netlify or Cloudflare Pages; there's no build step. Then run the workflow once manually (Actions → Daily data verification → Run workflow).
- [ ] Point a custom domain at it.

## Data licensing

ABS and RBA data are CC BY 4.0: attribution is on every card and in the footer. The Westpac–Melbourne Institute consumer sentiment index is used as republished by the RBA.
