# Promtek Hub

The Promtek company app: engineer profiles with XP, levels, titles and ELO ranks, plus a home for tools such as obsolescence reports.

It runs entirely on Cloudflare's free tier:

- **Cloudflare Workers** serves the app and API.
- **D1** is the database.
- **Access** provides Google sign-in.

Setup instructions are in [SETUP.md](SETUP.md).

## Project layout

```
public/            The web app (plain HTML, CSS and JavaScript, no build step)
  app.js           Pages: dashboard, XP & rank, My time, Admin, account panel
  modules.js       The dashboard tiles
  sw.js            Service worker (installable app, offline shell)
  manifest.webmanifest, *.png   App name, icons and Promtek logo
  apps/<name>/     Each tool lives in its own folder
src/               The Worker (API and background sync)
  index.js         API routes
  auth.js          Google sign-in check (Cloudflare Access)
  sync.js          Tempo polling, XP ledger, profile refresh
  progression.js   XP rate, level, title and rank rules
  reports.js       Team and engineer reports, leaderboard, CSV export
  jobs.js          Finished job tracking and quoting data
  logging.js       Finding a job and writing worklogs to Tempo
  pow.js           Point of work assessments, Jira attachment, Drive upload
  pow-data.js      The questions, PPE and hazard lists
  pow-pdf.js       The assessment PDF layout
  pdf.js           A small dependency-free PDF writer
  jira.js          Jira REST client
  tempo.js         Tempo REST client
schema.sql         Database tables
schema-002.sql     Roles, weekly snapshots and alerts
schema-003.sql     Completed job tracking
schema-004.sql     Stage names and shares
schema-005.sql     Point of work assessments and the RA library
schema-006.sql     Vehicles, IT request mapping and tile layouts
mail-relay.gs      Optional Apps Script that emails alerts
wrangler.jsonc     Cloudflare configuration
```

## How XP is tracked

Each Tempo worklog becomes one row in `xp_ledger`, keyed by its Tempo worklog ID.

- **XP per worklog:** round(rate × minutes). The rate is `override × max(0.5, 1 + (jobELO − yourELO) / 800)`, or `override × baseline / 60` when the job has no ELO rating.
- **Stable ELO snapshot:** your ELO is recorded when the time is first logged, so later ELO changes don't rewrite XP you've already earned.
- **Edits and deletions:** edited worklogs update their row. Deleted worklogs are removed by a rolling check of the last 14 days.
- **Total XP:** opening balance carried over from Jira + the sum of the ledger.
- **Derived values:** level, title and rank are calculated from the totals and never stored.
