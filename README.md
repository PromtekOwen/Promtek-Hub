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
  elo.js           The ELO engine: rating finished jobs, weekly freeze, history
  disputes.js      Open jobs, difficulty disputes, estimate alerts
  modifiers.js     Supervisor-approved modifiers
  quotes.js        Quote builder: estimates, reference jobs, learned estimate, hand-off to orders
  devtime.js       Condor Dev: Bitbucket activity turned into draft worklogs
  mes.js           Condor Dev: MES estimating by comparison, triage, Condor rating
  mes-plan.js      Condor Dev: release planning, suggestions, Jira timeline
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
schema-007.sql     8x8 call mapping and handled calls
schema-008.sql     Obsolescence library and surveys
schema-009 to 012  Employee details for the company chart
schema-013.sql     The ELO engine and its history
schema-014.sql     Disputes, estimate alerts and modifiers
schema-015.sql     Quote builder, and estimates read from Original Estimate
schema-016.sql     Condor Dev: Bitbucket activity and logged days
schema-017.sql     Condor Dev: MES tickets, estimates, triage and Condor ratings
schema-018.sql     Condor Dev: capacity, accepted plans and plan decisions
mail-relay.gs      Optional Apps Script that emails alerts
wrangler.jsonc     Cloudflare configuration
```

## How XP is tracked

Each Tempo worklog becomes one row in `xp_ledger`, keyed by its Tempo worklog ID.

- **XP per worklog:** round(rate × minutes). The rate is `override × max(0.5, 1 + (jobELO − yourELO) / 800)`, or `override × baseline / 60` when the job has no ELO rating.
- **Stable ELO snapshot:** the XP rate uses your ELO as it stood on Monday morning, recorded against each worklog when it is first logged, so later ELO changes don't rewrite XP you've already earned.
- **Edits and deletions:** edited worklogs update their row. Deleted worklogs are removed by a rolling check of the last 14 days.
- **Total XP:** opening balance carried over from Jira + the sum of the ledger.
- **Derived values:** level, title and rank are calculated from the totals and never stored.

## How ELO is worked out

Each finished category is a match between the job and the people who logged time on it.

- **Job ELO** starts at 750 + 250 × the weighted difficulty score (technical 40%, scope 30%, risk 20%, dependencies 10%).
- **The result** compares actual time with the estimate on a log scale: 0.5 on estimate, 1 at half the time, 0 at double.
- **The change** for each person is K × their share of the hours × (result − expected), where expected comes from the gap between their ELO and the job's. K is 48 for someone's first 10 rated jobs, then 32.
- **Zero-sum:** whatever the people gain, the job's learned ELO loses, so ratings don't drift upwards over time.
- **Rank** shows the best reached in the last three months.
- **History** is kept for every change, and admins can undo one.
- **Disputes:** an engineer can say a job is harder than quoted. Once a team lead agrees, the agreed difficulty and estimate replace the quoted ones for XP and ELO, XP already earned on it is recalculated, and the quoted values are kept for quoting.
- **Modifiers:** while one agreed by the person's supervisor applies, time logged counts for less in both directions (Unwell 25%, Covering for absence, Learning on the job and Personal circumstances 50%, Supporting apprentices and Training someone 60%, Heavy workload 75%).
- **New quotes** set job ELO from difficulty alone: 750 + 250 × (technical 55%, risk 30%, dependencies 15%). Size goes into the hours estimate instead. Jobs quoted before the quote builder keep the older formula.
