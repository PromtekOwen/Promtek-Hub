# Promtek Hub: setup guide

This guide takes you from nothing to a working hub at a web address your team can open, signed in with their Promtek Google accounts. Nothing here costs money.

Allow about an hour and a half the first time. Do the steps in order: some later steps need values from earlier ones.

What you'll end up with:

- A web app that runs on Cloudflare. Everyone at Promtek, in the UK and Promtek Africa, signs in with Google and sees their level, title, ELO rank and a breakdown of which time logs earned which XP.
- A database (Cloudflare D1) holding an XP ledger with one row per Tempo worklog.
- A background job every 2 minutes that picks up new and edited Tempo worklogs and removes XP for deleted ones. On the hour it also records finished jobs, and the ELO engine rates them once their time has settled.

Cloudflare's dashboard moves things around occasionally. If a menu name below doesn't match exactly, look for the nearest equivalent; the steps themselves don't change.

---

## Part 1: Cloudflare account and Zero Trust

1. Go to https://dash.cloudflare.com/sign-up and create an account with a Promtek email address (for example an IT or admin mailbox you control), so it isn't tied to a personal account.
2. In the dashboard, open **Workers & Pages** once. This creates your free `workers.dev` subdomain. If it asks you to choose one, pick something like `promtek`. Your hub's address will then be `https://promtek-hub.promtek.workers.dev`.
3. Open **Zero Trust** from the left-hand menu. Choose a **team name** such as `promtek`; this becomes `promtek.cloudflareaccess.com`. Write it down, because you'll need it in Parts 2 and 6.
4. Choose the **Free** plan (up to 50 users). Cloudflare may ask for a payment card even on the free plan; you won't be charged while you stay within it.

## Part 2: Google sign-in

This lets people log in with the same Google account they use for Atlassian and Google Workspace. Do it signed into Google with your Workspace admin account.

5. Go to https://console.cloud.google.com and create a new project called `Promtek Hub Login`.
6. Open **APIs & Services → OAuth consent screen**. In newer versions of the console this is called **Google Auth Platform**, with **Branding** and **Audience** pages.
   - Set the user type (audience) to **Internal**. This means only accounts in your Promtek Google Workspace can use it.
   - App name: `Promtek Hub`. Add your email as the support and developer contact. Save.
7. Open **Credentials** (or **Clients**) → **Create credentials → OAuth client ID**.
   - Application type: **Web application**. Name: `Cloudflare Access`.
   - **Authorised JavaScript origins**: `https://YOUR-TEAM-NAME.cloudflareaccess.com`
   - **Authorised redirect URIs**: `https://YOUR-TEAM-NAME.cloudflareaccess.com/cdn-cgi/access/callback`
   - Replace `YOUR-TEAM-NAME` with the team name from step 3. Create it, then copy the **Client ID** and **Client secret**.
8. Back in Cloudflare **Zero Trust**, go to **Settings → Authentication → Login methods**. In newer dashboards this is **Integrations → Identity providers**. Choose **Add new → Google**, paste the Client ID and Client secret, and save.
9. Select **Test** next to the Google login method. You should see a Google sign-in, then a success page.

## Part 3: Put the code on GitHub

10. On GitHub, create a new **private** repository called `promtek-hub`. It's safe for the code to be private or public, since no tokens are stored in it, but private is the sensible default for a company tool.
11. Upload everything in this folder to the repository. The GitHub website lets you drag and drop files: **Add file → Upload files**. Keep the folder structure (`src/`, `public/` and so on) and include the hidden `.gitignore` file.

## Part 4: Create the database

12. In the Cloudflare dashboard, go to **Storage & databases → D1 SQL database → Create database**. Name it `promtek-hub` and create it.
13. On the database's page, copy the **Database ID** (a long string of letters and numbers).
14. In your GitHub repository, open `wrangler.jsonc`, select the pencil icon to edit, and replace `PASTE_YOUR_D1_DATABASE_ID_HERE` with the Database ID. Commit the change.
15. Back in the D1 database page, open the **Console** tab. Paste the whole of `schema.sql` in and select **Execute**. Then do the same with each of `schema-002.sql` (roles, snapshots and alerts), `schema-003.sql` (completed job tracking), `schema-004.sql` (stage-level data), `schema-005.sql` (point of work assessments) `schema-006.sql` (vehicles, IT support and tile layouts) and `schema-007.sql` (8x8 calls). Afterwards, the **Tables** tab should list `employees`, `jobs`, `xp_ledger`, `unmatched_worklogs`, `sync_state`, `weekly_snapshots`, `alerts`, `completed_jobs`, `pow_forms`, `ra_library`, `vehicles`, `vehicle_bookings`, `vehicle_checks`, `vehicle_defects`, `it_request_types`, `user_prefs`, `call_customers` and `call_actions`.

    If the console rejects the file because of the comment lines, delete the lines starting with `--` and run it again, or run one statement at a time.

    **Already set the database up before?** Run just the newer files; they only add the new pieces and leave your data alone.

## Part 5: Deploy the hub

16. Go to **Workers & Pages → Create → Workers → Import a repository**. Connect your GitHub account when asked (you can limit access to just the `promtek-hub` repo) and choose the repository.
17. On the build settings screen:
    - **Project name** must be `promtek-hub`, matching the `name` in `wrangler.jsonc`.
    - Leave the build command empty.
    - The deploy command should be `npx wrangler deploy` (the default).
    - Select **Deploy**.

    From now on, every commit to the repository deploys automatically.
18. When the deploy finishes, open the Worker, go to **Settings → Variables and secrets**, and add two variables of type **Secret**:
    - `JIRA_API_TOKEN`: the Jira API token from your existing Apps Scripts.
    - `TEMPO_API_TOKEN`: the Tempo API token from your existing Apps Scripts.

    Secrets stay in Cloudflare and survive every future deploy. The other settings (Jira URL, admin email, field IDs) are plain values in `wrangler.jsonc`.

## Part 6: Put the hub behind Google sign-in

19. In the Worker, open the **Access** tab and select **Protect this Worker behind Access**.
    - Choose **All traffic**.
    - For the authentication policy, choose **Email domain** and enter `promtek.com`. Add a second **Email domain** rule (an "Include" of the same policy) for `promtek.co.za`, so Promtek Africa can sign in too.
    - Select **Apply Access**.
20. Go to **Zero Trust → Access → Applications** and open the application that was just created for `promtek-hub`.
    - Under **Login methods**, tick only **Google**, and turn on **Instant Auth** (sometimes worded "skip identity provider selection"). People then go straight to Google instead of seeing a choice screen.
    - Set the **session duration** to something like **1 month**, so engineers aren't asked to sign in every day.
    - Copy the **Application Audience (AUD) Tag**, shown on the application's overview or basic information page.
21. In GitHub, edit `wrangler.jsonc` again:
    - `ACCESS_TEAM_DOMAIN` → `https://YOUR-TEAM-NAME.cloudflareaccess.com`
    - `ACCESS_AUD` → the AUD tag you just copied
    - Check `ADMIN_EMAILS` has your email. To add another admin, separate emails with commas.
    - `ALLOWED_EMAIL_DOMAIN` lists the email domains that can use the hub, separated by commas: `promtek.com,promtek.co.za`.

    Commit the change and wait a minute for the automatic deploy.

## Part 7: First sign-in

22. Open `https://promtek-hub.YOUR-SUBDOMAIN.workers.dev`. You should be sent to Google, then land on the hub.
23. Add everyone under **Admin, Employees**: name, work email, Jira account ID, department, who they report to, access and teams, and contracted hours. Your own record links to your sign-in by its email.

## Part 8: Invite the team

26. Send everyone the link. The first time each person signs in, the hub matches their Google email to their Atlassian account and links them.
    - If someone's account doesn't match (for example, they use a different email in Jira), link them by hand under **Admin → Link a Google account**.
27. Promtek Hub installs as an app on phones and computers, with its own icon and window:
    - **iPhone:** open the link in **Safari**, tap **Share**, then **Add to Home Screen**.
    - **Android:** open it in **Chrome** and tap **Install** when prompted. You can also use the **⋮** menu → **Install app**, or the account menu (tap your initials) → **Install the app**.
    - **Windows or Mac:** open it in **Chrome** or **Edge** and click the install icon at the right-hand end of the address bar, or use the account menu → **Install the app**. It then opens in its own window and can be pinned to the taskbar or dock.

## Part 10: Roles, reports and alerts

Everything below is already in the app; this explains how to set it up.

### Where the settings are

The **Admin** tile holds the things that span the whole hub: sync and the XP ledger, roles, the engineer list, alerts and account linking. Everything that belongs to one app lives behind a **cog** in that app's header, visible to admins only: the RA and SSOW list in Point of work, the fleet in Vehicles, the 8x8 connection and extensions in 8x8 calls, the request type mapping in IT support, the equipment library in Obsolescence, and job tracking and snapshots in Reports.

### Employees

Employees are managed in the hub, under **Admin, Employees**. Each person has one page covering everything the apps use: name, email, pronouns, job title, team, who they report to, their order on the chart, their role in the hub, XP rate, ELO, Jira account ID, 8x8 extension, chart badges and notes.

**XP Rate on Jira items.** An item's XP Rate field in Jira (0 for no XP, 0.5 for half, and so on) scales the XP its time earns. If `FIELD_XP_OVERRIDE` or `FIELD_ELO` isn't set for the Worker, Promtek's own fields are used (`customfield_16566` and `customfield_15378`). Time earns the XP Rate its item had on the day the time was logged. The hub reads each item's XP Rate history from Jira (its changelog) as well as the changes made in the hub. Every morning the items with time logged in the last 90 days are checked against it, and any time that earned at the wrong rate is worked out again; **Check XP rates** in Admin does the same straight away and names the items it corrected. **Correct all past XP** checks every item ever logged to, about 100 items every couple of minutes in the background; press it again to see how far it has got. If `FIELD_XP_OVERRIDE` points at a different field from the one Log time shows (`customfield_16566`), Check XP rates says so.

**Setting XP Rates from the hub.** Run `schema-058.sql` in the D1 console first. Under **Admin, XP rates**, search for any Jira item, choose **Change** and set its XP Rate as a percentage of the usual (0% to 500%; 100% is the usual and clears the field). It's saved to the item's XP Rate field in Jira, with who changed it and why in the audit log under XP rates. A change starts today, so time already logged keeps the XP it earned, unless **Also apply to time already logged on it** is ticked, in which case everyone's time on it is worked out again. The section lists every open item not at 100% and the recent changes. Items above 100% show to everyone at the top of **Log time** under **Bonus XP**, and with a green ★ badge wherever they appear in the picker, so a job nobody picks up (the dishes, housekeeping) can be made worth doing.

**XP rate** is the base XP per hour. Engineers are on 60, and their rate rises and falls with the difficulty of the job against their own ELO. Admin staff are on 75, since they get no ELO adjustment.

**Pictures** are added on the same page and appear on the company chart. They are squared off and shrunk in the browser before saving, so a phone photo is fine.

**Badges** mark the people to go to in an emergency: first aider, mental health first aider, fire marshal, evacuation warden, defibrillator trained, and health and safety trained. They show as white discs on the nameplate.

**Adding someone** before their Atlassian account exists is fine: leave the Jira account ID blank and they are marked as pending. Filling it in later moves their history across with them.

**Removing someone** offers two things: hide them and keep their XP history, or remove them and it entirely.

**Viewing as someone, and helping them.** Developers can view the hub as someone else (account menu, View as someone else). It's read-only: you see what they see, and nothing can be changed. Owen alone (set `REMOTE_HELP_EMAILS` to change who) also sees **Make changes for them** on the bar at the top.
- **What it does:** with it on, the bar turns red and anything done goes through as that person. That includes logging or fixing their time, filling in their forms, changing items, and acknowledging on their behalf.
- **The record:** each change is in the audit log under their name, with "Made by Owen Hume while viewing the hub as them". Jira changes are made as Owen, not as them.
- **Turning it off:** it turns itself off after an hour, when you view as someone else, or when you stop viewing as them. **Turn changes off** stops it straight away.
- **What still needs their own sign-in:** setting their tablet PIN and connecting their Jira account.

**Who's using the hub** (Admin, admins only) lists each tile with how many times it was opened and by how many people over the last 7, 30 or 90 days, including tiles nobody has opened, and each person with when they last opened the hub, how many days they've used it, and the tile they use most. A page counts once every few minutes per person, so moving around inside it doesn't add up, and a developer viewing as someone isn't counted. Counts are kept for 400 days.

### The company chart

The **Company chart** tile draws the org chart from the employee list, so it follows along as people join, change role or leave. Job titles, teams, reporting lines, pictures and badges are all set on each person under **Admin, Employees**.

**Layout.** Departments run across as columns: Operations, Marketing, Sales, Service, Projects, Condor, IT and Rhapsodi. Levels run down as rows: Directors, General managers, Managers and leads, and Team. Each person has one full card, at their department and level. Under **On the company chart** on their employee record:
- **Level** sets their row. Left as "Worked out", someone with no manager is a director, someone reporting to a director or with people reporting to them is a manager, and everyone else is in the team.
- **Seniority within the team** (Senior, Standard, Apprentice) groups a team, most senior first, with a gap between groups.
- **Covers** (shown once Level is Director) makes a director's card stretch across those departments. Columns are arranged so each director's departments sit together, in the order the directors are on the chart.
- **Ceremonial director** (also only for directors) puts them in a column of their own at the right, lighter, with no lines.
- **Promtek Africa** adds an SA badge.
- **Other roles** (up to four) each show as a dashed card in that role's department, level and seniority, reporting to the person chosen for that role. Their full card says "Also: …".

Directors, general managers and managers who share a column sit side by side, and each has their own height in the gap below their row, so their lines never run together.

**Lines.** Each team has one line, to the manager it reports to: within its column, straight down from a director's card, or from the row just above along the gap between rows. A team whose manager is anywhere else is labelled "Reports to …" instead, so no line crosses the chart. A dashed line or card is a second role. Tapping someone shows who they report to and who reports to them, and fades everyone else. Tap again to clear.

**Order.** Within a team, people read left to right then down. Admins and developers set the order with **Arrange the order** on the chart itself; saving someone's employee record leaves it as arranged.

**Download as an image** saves a PNG of the chart exactly as drawn, at twice screen resolution, for pasting into documents or the ISMS.

**Back.** The arrow at the top left goes back a page: from something opened within a tile (an item, a ticket, a sub-task, an assessment) to what was open before it, and from one of a tile's tabs to the tab before, then to the tile's first view and home. The phone's or browser's own back does the same.

**Downloads.** Everything the hub saves (the chart image, the WIP workbook, CSVs, certificates, release notes) says "Downloading" and then "Downloaded" with the file's name, which matters in the installed app, where there's no download bar. Files from the server are fetched first, so "Downloaded" only shows once the file has arrived. In the installed app on an iPhone or iPad, the share sheet opens instead, for Save to Files.

Someone new with no manager and no level appears on the Directors row, which makes them easy to spot until they're set up.

### Roles

Access is set with **groups** (roles) and **teams**. A person can be in any number of each. What each role and team can open starts from the defaults below, and admins can change it under **Admin → Who can use what** (see below).

- **Everyone:** their own XP, time and profile, the leaderboard (with everyone's level and level title), and the tiles for their teams.
- **Admin:** everything, including Admin, every settings cog, the audit log, employees, vehicles and issuing the company chart.
- **Management:** sees and acts on every team: reports, approvals, disputes, modifiers, count checks, Condor triage and planning, quotes and the XP shop preview.
- **Team lead:** the same as Management, but their own lists ("Waiting for you", approvals, the Reports team picker) and their team's alerts are for the teams they lead. They can still act on another team's item when needed.
- **Sales:** starts and edits quotes.
- **Developer:** the hub's technical side of Admin, meaning sync status, Bitbucket and connection tests, and nothing else there.

Teams are Projecting, Service, Condor, Sales and Marketing. They decide which tiles someone sees by default (for example Condor Dev for the Condor team) and whose alerts reach them. A Team lead also has the teams they lead ticked under **Leads**; they can only lead teams they're in. Modifiers can be seen and decided only by the person, their supervisor, a lead of one of their teams, Management and admins.

Set all of this on each person under **Admin → Employees**. Changes to anyone's groups or teams are recorded in the audit log.  Your own email stays in `ADMIN_EMAILS` in `wrangler.jsonc` as a fallback, so you can't lock yourself out.

### Who can use what

**Admin → Who can use what** lists every tile, then the parts inside tiles that are only for some people. For each one, choose **Everyone** (tiles only) or any mix of roles, teams and **Leads of** a team; the count and names of who that comes to update as you tick, before saving. Each change is in the audit log, takes effect within about half a minute, and **Back to how it started** returns it to the default. A tile's own settings cog shows the same for that tile.

- A tile someone can't open is hidden from their home screen, and the hub refuses its requests: Condor Dev, Jobs, Obsolescence, Point of work, PSC, Service contracts, Capacity, WIP, Invoicing, IT support, Requests, Feedback, Vehicles, Employee of the Quarter, the XP shop and Reports. XP & rank, My time, Quotes, 8x8 calls and the Company chart are only hidden, because other parts of the hub (logging time, the home screen) use them.
- Inside the tiles: Team oversight, Build quotes, Condor planning, Employee of the Quarter results, Change the WIP (including payment terms), Contract insights, Feedback moderation and Developer tools.
- Admins always have everything, and the Admin tile and Admin permission can't be changed, so nobody can lock themselves out.
- **Tile admins**, at the bottom, name people for one tile at a time, whatever their role. A tile admin can open that tile, has everything inside it (every permission that belongs to the tile), and sees both the UK and South Africa there. It's also under each tile's settings cog. Use it for someone who needs, say, both countries' service contracts without being a manager.

### UK and South Africa

The hub is split between Promtek UK and Promtek Africa. Someone's country is the **Promtek Africa** tick on their employee record.

- **Split tiles:** Jobs, Quotes, Service contracts, PSC, Capacity, Invoicing, Vehicles, 8x8 calls and Customers. People see their own country's customers and items, and nothing of the other country's. Everything else (the company chart, leaderboards, training, IMS and so on) is for the whole company. The WIP keeps its own UK/SA switch.
- **Who sees both:** admins, Management and developers everywhere, and tile admins in their tile.
- **How an item's country is known:** its customer project's Jira category (Promtek UK Customers or Promtek SA Customers). PSC items on the PSC board go by the customer their Organization matches; until one is matched, both countries see them. A quote for a new potential customer goes by who started it. Capacity and the 8x8 everyone view go by the person. Each vehicle has a **Country** on Admin → Vehicles (UK until set).
- **Involve user from SA / UK:** every PSC item and every job has this button. It lists the other country's people who can open that tile; whoever is picked sees that one item in their lists and works on it like their own (commenting, logging time, changing it). The names involved show on the item, with a × to stop involving someone. Each change is in the audit log.
- **Alert emails** for PSCs and service contracts go to the Service team of the customer's country (falling back to everyone in the usual list if that country has nobody in Service). The home screen's PSC, order and contract alerts follow the same split.
- **Theme:** Promtek Africa's people have the hub in green instead of blue, in light and dark.

**Setting it up:** run `schema-075.sql` in the D1 console, tick **Promtek Africa** for each South African employee, and set each South African vehicle's country under Admin → Vehicles.

### Reports

Team leads, Management and admins get a **Reports** tile showing hours, XP, worklogs and days logged per person per week, with columns for however many weeks you pick. Hours under 20 in a week are highlighted, and the last column shows how long after doing the work people record it, which is the number to watch if the goal is better logging. Reports and the XP page's leaderboard can be filtered by team; a lead's reports open on the team they lead.

Selecting a name opens that engineer: weekly hours, level and ELO history, what they spent the most time on, and their recent logs. Three CSV exports cover the raw time logs, the weekly summary and the snapshots.

Every Monday morning the hub records a snapshot of everyone's XP, level, ELO and effort for the week just gone, so the history survives even as the numbers move. There's a button on the Admin page if you ever need to record one by hand.

### Quoting data

The **Quoting** tab on the Reports page compares finished customer work with what it was estimated to take:

- **How long jobs of each size really take**, per discipline, grouped by their estimate: up to a day, three days, a week, two weeks, a month, and longer. Where the median actual and the median estimate differ consistently, estimates of that size are running light or heavy.
- **By customer** and **by team**, showing where work routinely runs over or under.
- The recently finished list, and a CSV of everything recorded.

Every hour the hub records customer orders that have reached a Done status, along with their Category items and stages. A category's estimate is its Original Estimate, with base sprints used only for older categories that have no Original Estimate. Category items are also recorded as soon as they are done themselves, without waiting for the order to close, and the latest move into Done counts as the finish date. Stage time rolls up into its category, since that's the level each is estimated at. Legacy epics with no Category items are still recorded but marked, so they don't distort the bands.

Items are rated **good** when they have an estimate and believable hours; anything else is excluded from the medians unless you tick "Include patchy data". None of this changes XP or ELO.

To build a starting set, open **Admin → Completed job tracking**, choose how far back to go and select **Start backfill**. It works backwards a batch at a time in the background, so it takes a while on a few years of history, and the Admin page shows how far it has reached.

### Stage-level estimating

Stages almost never carry an estimate of their own, so the **Stages** tab builds one from what actually happened. Stages are grouped by issue type, using the types quotes use. Older orders used the same stages without "New" in front and with no category layer, and they count too:

| Older order | Quote stage |
|---|---|
| Design, Purchase Order, Build, Configuration & Test, Dispatch | New Design, New Purchase Order, New Build, New Configuration & Testing, New Dispatch (Hardware) |
| Storaweigh Software Development, Kestrel Software Development | New Software Development (Software) |
| Commissioning Site Visit | New Order Site Visit (Site visit) |
| Condor Development | New Condor Development (Condor) |
| Download Phase | New Download Phase: Condor on an order with Condor Development, otherwise Software |

Any other issue type isn't a quoted stage and is left out. Stages are listed in the order the work happens, and can be filtered by customer and team, or grouped by customer or team to compare them. The CSV download matches what's on screen. The tab shows how long each stage usually takes and what share of its category it used; on older orders, the share is of that category type's time on the order. The same figures feed the shares used to split quoted hours across subtasks. Stages recorded before issue types were kept have theirs looked up in the background.

That gives two ways to quote a job:

- Estimate the category as now, then split it across stages using the share column.
- Or add up the typical hours of the stages the job needs, and use that as the category estimate.

The same tab answers whether the difficulty scores are earning their place. The weighted score should produce steadily rising hours, and the "tracks hours" column shows which of the four scores actually moves with real time. A score sitting near zero isn't telling you much, and its 40/30/20/10 weighting is worth revisiting once there's a year of data behind it.

If you recorded jobs before this was added, select **Rebuild stage names** on the Admin page to fill in the names and shares without re-reading Jira.

### Alert emails (optional but recommended)

The hub raises an alert when someone logs time in Tempo but isn't in the employee list, since they'd be earning no XP. Alerts always appear on the Admin page. To have them emailed too:

1. Go to https://script.google.com and create a project called `Promtek Hub mail relay`.
2. Paste in the contents of `mail-relay.gs` from this folder.
3. Change `SHARED_SECRET` to a long random string of your own.
4. Select **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**. Authorise it when Google asks. Copy the web app URL.
5. In the Worker's **Settings → Variables and secrets**, add three **Secrets**:
    - `ALERT_WEBHOOK_URL`: the web app URL
    - `ALERT_WEBHOOK_SECRET`: the same random string
    - `ALERT_EMAIL`: where alerts should go, such as your own address

**When emails go:**
- **After someone does something:** an email that their action raises (a reminder sent by management, a new tool box talk or policy, a request for an estimate and so on) goes straight away, just after the hub answers them.
- **From the background job:** emails it raises (PSC and IMS notifications, say) go at the end of the same run, so within a couple of minutes.
- **Never twice:** each email is claimed before it's sent, so two runs at once never send one twice.
- **When the relay refuses one:** it's kept and tried again on the next run.

The Admin page shows each alert as **Emailed**, **Sending**, **Not emailed yet**, or **Held until …** for someone who has chosen emails only in their working hours.

**What Admin shows about sending:**
- **The last try:** when it was, how many went, and, if any didn't, why. For example: the relay can't be reached; it answered with an error; or it said **Rejected**, which means `ALERT_WEBHOOK_SECRET` doesn't match `SHARED_SECRET` in the relay script.
- **Send the N waiting now:** sends any still waiting straight away and says how it went.
- **Last background run:** if this, at the top of Admin, is old or says Not yet, the Worker's scheduled trigger isn't running (the `triggers` in `wrangler.jsonc`), and nothing waiting goes until it does.

**PSC changes:** tickets changed in Jira are read every couple of minutes, between the hub's fuller PSC runs, so their notifications aren't kept waiting.

## Part 11: Point of work risk assessments

Engineers fill the assessment in on site, one part per screen, and the hub makes the PDF, attaches it to the Jira visit and files it in the shared drive. It replaces the Google Form, the Zapier step and the Apps Script that highlighted the PPE table.

**Picking the visit:** customer, then Service or Projecting, then the open site visits for that team. A visit belongs to Service if its order has Promtek Team set to Service, or if it sits under a service contract; to Projecting if its order is marked Projecting. Anything whose order has no team set, or that has no order at all, appears under both and is flagged, so it can still be used while the gap is visible. If the visit isn't there, "My visit isn't listed" tells the team lead the job hasn't been progressed in Jira, and the assessment carries on as a draft so the job number can be added later.

**Off signal:** everything is kept on the phone as it's filled in. A finished assessment with no connection is queued and sends itself when signal returns.

**The RA and SSOW list** starts as the fourteen from the paper form and is edited under Admin.

### Setting up the Google Drive upload

The hub uploads as a service account, so nobody signs in and queued assessments still file themselves hours later.

1. In https://console.cloud.google.com, with the `Promtek Hub Login` project selected, go to **APIs & Services → Library**, find **Google Drive API** and select **Enable**.
2. Go to **IAM & Admin → Service Accounts → Create service account**. Name it `promtek-hub-drive`. Skip the optional role steps and create it.
3. Copy its email address, which looks like `promtek-hub-drive@your-project.iam.gserviceaccount.com`.
4. Open the account, go to **Keys → Add key → Create new key → JSON**, and keep the file that downloads. It's the only copy, so treat it as a password.
5. In Google Drive, share the assessments folder with that email address as **Content manager**. If the shared drive won't allow sharing a folder outside the drive, add the service account as a member of the shared drive instead.
6. In the Worker's **Settings → Variables and secrets**, add two **Secrets**:
    - `GOOGLE_SERVICE_ACCOUNT`: the entire contents of the JSON file
    - `DRIVE_FOLDER_ID`: `14T2Tk1YjLt0yEiO9m_Q-zWkP__n3X578`
7. Delete the downloaded JSON file from your computer.

If step 4 is refused, your Workspace policy blocks service account keys. That's a setting you can change as Workspace admin under service account key creation.

**If either delivery fails**, the assessment is still saved and downloadable from the hub, and the team lead is told so it can be filed by hand. Nothing is ever lost because Jira or Drive was unavailable.

## Part 11a: Customers

The **Customers** tile lists every live customer project in Jira (the UK and South Africa customer categories, not the blocked projects or the templates UKST and SAST), to everyone.

- **Each customer shows:** how many open quotes, open PSCs and active jobs (orders the WIP follows that aren't done) they have; a shield, green with a tick when they have a service contract In Contract or Requires Renewal; the date and time anything in their Jira project last changed; and their primary contact's name, phone and email (tap to call or email).
- **Finding one:** search by name, key or contact; show All, UK, Africa or those with open PSCs; sort A to Z or by last update.
- **Where it comes from:** every half hour the hub reads the customer projects (with Jira's own last-updated time for each) and the Site Contact, phone, email and Site Address on every open order and service contract, and any closed in the last year. Quotes, PSCs, jobs and contracts come from what the hub already keeps for those tiles.

**A customer's page** has folding sections; closed, each shows how many are in it.
- **Sites:** each address found on their jobs and contract, once each, with a map link.
- **Contacts:** everyone named on their jobs and contracts, once each (the same email, or the same name with no email, is one person), with the items they're on.
- **The primary contact** is the one an admin chooses, or else the contact on their active service contract, or else on their latest open job. It's the one shown on the list.
- **Service contracts, active jobs, open quotes and open PSCs**, each with its contact and site as put right here.
- **Recent communications:** the emails the mail handler (the **Operations Team** Jira account) has put on their items in the last four months, read when the section is opened. Each shows who sent it and what they said: the email headers, sign-off and signature, disclaimer, earlier messages quoted below and formatting marks are left out. The account is found by its name; set `OPS_ACCOUNT_NAME` if it's ever renamed.

**Putting sites and contacts right** (people with **Manage customers**: admins to begin with; Admin, Who can use what):
- **Sites:** add an address (with an optional label such as Head office), change one, or remove one. A removed address from Jira stays removed; a changed one stays as changed.
- **Contacts:** add someone, change their name, phone or email, give them an optional job title and (with more than one site) a site, or remove them. **Make primary** chooses the primary contact; **Let the hub choose** goes back to the hub choosing.
- These changes stay in the hub, and the next read from Jira leaves them as they are. Jira keeps what it has. Each is in the audit log under Customers.

**Statistics** (a tab on each customer, for people with **Customer statistics**: Management to begin with). Each section folds away; **At a glance** starts open.
- **At a glance:** customer since (their first item in Jira), orders all time with the average order, orders in the last 12 months, still to be paid on open orders, invoiced and awaiting payment (and overdue), active contract value, time logged for them, PSCs (open, average time to first look and to sort) and quotes.
- **Money by month:** orders placed (by acceptance date), service contracts (by start date) and invoices sent, over two years.
- **Time logged for them by month:** hours on their orders and everything under them, PSCs, quotes and contracts.
- **Open work by kind:** everything not done in their project by issue type (except Documentation, which isn't worked once it's made), to do and in progress (hover for the statuses), and each open order's progress and how much is invoiced.
- **How long things take:** average and median days from raised to done, by issue type, for the last two years.
- **Who's working on them** and **who knows them best:** only people in the hub (former staff are left out); everything ever assigned to each in their project (up to the latest 1,500) and the time each has logged for them, the top one starred.
- **PSCs raised by month** and **every service contract** the Service contracts tile has for them (archived ones too), newest start first, with tokens used of those in the contract (Jira's count, which includes overdraft tokens), in red when there are overdraft tokens or more used than the contract has (23/20).
- Worked out when first opened and kept for six hours; **Work it out again** refreshes them.

**Setting it up:** run `schema-073.sql`, then `schema-074.sql`, in the D1 console. The first read runs within the half hour; until then the list shows the customer projects without last updates or contacts.

## Part 11b: COSHH

The **COSHH** tile holds an assessment for each substance Promtek keeps, filled in from the hub and filed as a PDF laid out like the paper form (SP 04/A).

**Filling one in.** **New assessment** asks what the form asks:
- the product, other names, MSDS reference and appearance;
- its containers, with up to four pictures (on the tablet, **Take a picture of it** opens the camera);
- what it's used for and where;
- the hazard pictograms on its label, PPE and first aid;
- precautions and disposal;
- the three questions at the end, and the risk (low, medium or high).

**The safety data sheet.** Under the product name:
- **Search for its safety data sheet** opens a web search for it in a new tab. On a tablet pinned to the hub that may not be allowed; find the sheet on a phone or computer instead and copy its address.
- **Paste link** takes the sheet's address you've copied, puts it in **MSDS ref. number(s)** (unless a reference is already typed there) and shows the sheet beside the form, or above it on a narrow screen. Its words can be selected (hold on them on the tablet) and copied into the form. **−** and **＋** change its size, and **Close the sheet** puts the form back to full width.
- **A product's web page rather than its PDF:** the hub lists the PDFs on that page, the likeliest sheet first, to choose from.
- **Sheets the hub can't fetch:** it shows a few suppliers' sheets only in a browser (behind a login, or refused); **Open the original** opens them in a tab instead. A scanned sheet shows, but has no words to copy.
- **On the form and the PDF:** the link is kept, shown as **Open the sheet** on the item, and printed small on the PDF.
- **How the hub fetches it:** the hub fetches the sheet from the web itself, only from public addresses, and shows it with PDF.js (Mozilla's free PDF viewer, in `public/vendor/pdfjs`, Apache 2.0 licence). Nothing else is needed: no account, key or outside service.

**Saving and completing:**
- **Drafts:** it's saved as a draft as it's filled in (**Your drafts**). **Preview the PDF** shows it as it stands.
- **Who and when:** **Complete and file it** puts in whoever is signed in as the assessor, dates it today, and numbers it. The next number follows the highest in the list, starting at 1001.
- **Filing:** a new product's PDF goes to the COSHH page in Confluence straight away (page 666533895; set `COSHH_CONFLUENCE_PAGE` for another), as **COSHH <No> - <product>.pdf**, and it's in house from that day. This uses the hub's Jira account, which needs to be able to edit that page.
- **One file each:** the name never changes, so every later upload is a new version of the same file (its versions are in the file's history on the page), not another file. A file from before this with **Rev** in its name is renamed the next time it goes. There's no Rev on the form any more.
- **If Confluence can't be reached:** it's kept, an alert says so, and **File it in Confluence again** on the item tries once more.

**The list.**
- **Order:** products **in house** come first, in green, and those no longer in house are greyed out below.
- **In house:** anyone can tick or untick **In house** on a card or the item.
- **Where it's kept:** on the item, tap the places (Office, Workshop, Upstairs, Kitchen, Office Male Toilet, Office Female Toilet, Workshop Washroom & Toilet) or add another.
- **Finding one:** search by product, number or place, or show one place only.

**Reviews.** A product still in house is due its review a year after it was assessed or last reviewed.
- **When it's due:** two weeks before, and until it's done, it's marked on the list. People with **Manage COSHH** (Management to begin with; Admin, Who can use what) get a notification and email once, and an alert on their home screen.
- **Reviewed, no changes:** puts the reviewer and today's date in the next empty column of the form's Next Reviews table (up to six; after that the latest six).
- **Review found changes:** opens the form filled in, to change what the review found; saving it dates the review the same way. The number, assessor and assessment date stay.
- **One brought in from Confluence:** the hub can't write into a document it didn't make, so either button opens the form to fill in once from the current document (its assessor and assessment date too). From then on the hub makes its PDF, filed under the file's existing name (a Word file's name with .pdf), with that review in the first column.
- **Waiting for COSHH review complete:** reviews don't go to Confluence one at a time. They're marked **Waiting for review complete**, and the list shows what's waiting.

**COSHH review complete.** When the review is finished, anyone with the COSHH tile presses **COSHH review complete** on the list. It:
- reads the page first; if it can't, nothing is sent;
- files each waiting PDF as a new version of its file, a dozen at a time (the button carries on until they're all done; if it's left part way, the hub carries on within the hour);
- moves the page's control table on an issue (**Version** Issue 5 to Issue 6) with today as **Last Reviewed**, leaving Ref, Owner, Team and the rest alone;
- adds a row at the top of **Version History**: Ref (IMS1.09.06 and so on), the same Owner and Team as the control table, Released today, and the **Release notes**. The hub writes the notes from what changed (reviewed with no changes, reviewed with changes, added, in or out of house); they can be edited before pressing.

The tables are found by their headings (Version and Last Reviewed; Ref and Released), so they can move about the page. If one can't be found, the rest is done and an alert says what to set by hand. Page changes are saved as minor edits. If reviews wait three days or more, people with Manage COSHH get a notification and email (again every three days) and an alert on their home screen.

**In and out of house dates.** The page's table with **COSHH ID**, **Most Recent Date in House** and **Most Recent Date out of House** has a row for each COSHH number, in order, kept by the hub. Ticking or unticking In house, or a new product, changes it straight away (if Confluence can't be reached, within the hour). Dates are only ever the hub's: products from before it start with their ID and blank dates, and anything already typed in a row is kept until the hub has a date for it.

**What's already on the Confluence page.** People with Manage COSHH see **Bring in from Confluence**.
- **What it brings in:** every PDF, Word or Excel file on the page that didn't come from the hub becomes an item, named from the file, with its COSHH number if the name has one. It's dated from when it was put on the page, and starts not in house.
- **After bringing them in:** tick the ones still in house. Correct the product, number and assessment date on each (they decide when its review is due). Its file opens from the hub.
- **Running it again:** it only adds new files.
- **The same number twice:** where the page has more than one document for a COSHH number, the one reviewed (or put on the page) most recently is kept, with the others' places and in-house state, and the others are taken out of the hub and not brought in again. Their files stay on the page. A number already in use can't be given to another item.

**Removing.** Anyone can throw away their own draft. Only Manage COSHH can remove a completed one from the hub (its file stays on the page); otherwise, untick In house.

**Setting it up:** run `schema-071.sql`, then `schema-072.sql`, in the D1 console.

## Part 12: IT support

IT requests go to your `PROMTEKIT` service desk. Engineers pick what they need in plain words, say how much it's holding them up, optionally attach the asset and photos, and the hub raises the request in their name so replies reach them.

What the hub offers maps to your Jira request types like this, and the mapping is a dropdown on the Admin page rather than anything in the code:

| In the hub | Raises in Jira |
| --- | --- |
| Broken or faulty hardware | Report broken hardware |
| Software or system problem | Report a system problem |
| Account or access request | Request a new account |
| Admin access request | Request admin access |
| New hardware | Request new hardware |
| New software | Request new software |
| Something else | Get IT help |

Urgency sets the priority: blocked becomes Highest, slowed down becomes High, needs sorting becomes Medium, and nice to have becomes Low. If Priority isn't on those request forms the ticket is still raised, with the urgency written into the description.

Two things to set in Jira: make Peter the project lead with the default assignee set to **Project lead**, and under **Project settings → Customer permissions** allow anyone with a Jira account to raise requests.

## Part 13: Vehicles

- **The fleet** is managed on the Admin page: registration, make, model, MOT, insurance, tax and service dates, mileage, who looks after repairs, and the country it's in. People see their own country's vehicles (see UK and South Africa, in Part 10).
- **Booking** is by hour, with clashes refused and off-road vehicles unbookable.
- **The walkaround check** covers the same thirteen items as the paper form. A fail asks what's wrong and goes to admins and the maintenance contact. "Not fit to drive" takes the vehicle off the road until a lead clears the defect.
- **The linked job moves on** when the check is done: New Order and Commissioning Site Visits to Commissioning, Service, Calibration and Service Contract Site Visits to Visit In-Progress. If that transition isn't available, the check still saves and the team lead is told.
- **Expiry dates** are checked every morning, with reminders at 30, 14 and 7 days and again once a date has passed.

## Part 14: Arranging tiles

**Forms.** Admin, Home screen messages, **A form**: a title, what it's about, and questions, each either multiple choice (one answer, or any number) or text (one line or a paragraph), and optionally needing an answer. Run `schema-054.sql` in the D1 console first. A form shows under Alerts for the people chosen, with **Fill in**, until they've answered it or it closes (on its closing date, or with **Close it**). Opening it again before it closes shows their answers to change. **Answers** shows, for each multiple choice question, the share of the people who answered it that chose each answer (so a question allowing any number can add up to more than 100%), then each person's answers, who still hasn't answered, and a CSV download.

**Tile usage** (Admin): how often each tile is opened, by whom and on how many days. Owen Hume's use isn't counted, so testing doesn't skew it; anyone else can be left out by adding their email to an optional `USAGE_IGNORE_EMAILS` variable on the Worker (comma separated). The home screen isn't counted as a tile, as it's passed through between tiles, but opening it still counts towards the days someone used the hub.

**Long messages.** A message too long for its bubble on the home screen has **Read more**, which shows the whole of it.

Everyone can order their own home screen. **Arrange tiles** on the dashboard lets you drag tiles into place with a mouse or a finger, and hide the ones you never use. The order saves as you go. On a phone, hold a tile near the top or bottom of the screen to scroll while dragging. A focused tile can also be moved with the arrow keys. Hidden tiles sit under Hidden and come back with one tap. New tiles appear at the end of whatever order someone has chosen.

**Folders.** While arranging, drag one tile onto the middle of another and hold it there for a moment (it's outlined when it will make a folder), then let go: the two go into a new folder, which opens to be named. Dropping a tile on a folder puts it in that folder. Each tile also has a folder button, to choose a folder (or a new one) without dragging. A folder moves like a tile; its pencil button renames it and takes tiles out, and taking the last one out removes it. Tapping a folder opens it to show its tiles. Folders are saved to each person, like their order, and change nobody else's home screen. Run `schema-056.sql` in the D1 console first (until then, folders only last until the page is reloaded).

## Part 14b: The active time tracker

**Log time** is the button at the bottom of the home screen: centred on a phone, bottom-right on a larger screen. While a timer runs, it shows the job and the running clock. Picking anything with parts under it (an order, a category, or a task with sub-tasks), from a search, the shortcuts or the tree, shows those parts first, to pick the one worked on; **Log to this level instead**, below them, logs to the item itself, with a note of the lower XP it earns (its XP Rate) where it's less. After picking a job, the engineer chooses **Add time already done** (the usual form) or **Start the timer**. Logging an 8x8 call's time goes straight to the form. The timer is kept in the hub, so it carries on across tabs and devices, and a bar at the foot of every other page shows it running.

**Stretches.** Every stretch between starting and pausing is sent to Tempo the moment it ends, as its own worklog with its real start time and length:
- stretches under a minute are dropped;
- a stretch over midnight is split into each day's worklog;
- if Tempo can't be reached, the stretch is kept and sent in the background with its original times.

**Assisting.** "Assisting an apprentice" (logged to PMB-39) and "Assisting the team" (logged to PMB-37) pause the job and time the assist. The person helped and their job, if given, go in the worklog description. Going back to the job starts a new stretch.

**8x8 calls.** While the hub is open, it checks every 20 seconds whether the engineer's extension is on a live call, through 8x8's Active Calls API. All open hubs share one request to 8x8 every 15 seconds. A pop-up offers "Log time to this call", "Assisting the team", "Assisting an apprentice" or "Not this one":
- the job is cut at the moment the call started, so nothing overlaps;
- when the call ends, assisting time goes to Tempo and the engineer is asked whether to carry on with their job;
- a customer call is listed as needing details, and is marked done when it's logged in the 8x8 calls tile.

If live calls aren't available, the call records are checked every few minutes instead, and finished calls inside a running stretch are offered the same way. "Test live calls" under the 8x8 cog shows what 8x8 reports for calls in progress. Engineers' extensions must be set under Admin → Employees.

**Reminders.** At 5pm, anyone with a timer still running is emailed. A timer running more than 10 hours asks when it actually stopped. Engineers can turn on browser notifications so call pop-ups reach them when the hub isn't the window in front.

## Part 14b2: Logging and changing time, overtime and TOIL

Run `schema-057.sql` in the D1 console first (for admin adjustments to overtime balances).

**The day being logged to.** Under the date and start time on the Log time form, a strip shows what's already logged on that day, the gaps between, and the time being logged now as a dashed box, red if it overlaps something. Tapping a gap fills in its start and length; a last chip offers the rest of their day from where their time ends. A new log's start time begins where the day's time so far ends. The day's share is their weekly hours split across the days they work.

**Moving the item on.** When logging to anything outside PMB, the form asks whether to move the item on once the time is in: **No, leave it** (the default), **Yes, to** the next status (the first move Jira offers that doesn't go back a stage), or any other move Jira offers. The move is made after the time is logged, by the hub's Jira account; if Jira refuses it, the time is still logged and the person is told. PMB items are never moved, as they're filed by status.

**Changing time logs.** On My time, each day's bar is made of its time logs; tapping a piece, or **Change** on a log, opens it to change its date, start, length and note, or delete it. Changes go straight to Tempo (anything else on the worklog, such as Tempo work attributes, is kept), and XP and overtime are worked out again. Only the person who logged it can change it from the hub. Each change is in the audit log under My time.

**Overtime balance (TOIL).** At the top of My time, a running balance carried from week to week:
- time logged over their contracted hours adds to it, and time on a day they don't work counts in full;
- a working day with less than their daily share logged takes the difference off;
- time logged to PMB-25 (time off in lieu) isn't counted as worked, so it comes off the balance;
- today only counts once it's past the daily share, though TOIL taken today comes off straight away.

It runs from when they started logging consistently: the first working day with time logged that begins a steady run (time on at least three working days in four over the next four weeks), so odd logs while people were getting used to Tempo, and the time before, never count against them. After that, a working day with nothing logged takes a full day off; a red note above the balance says how many hours that is and lists the days, so logging them (including holiday and sickness, to their PMB items) puts it back. Admin, Overtime and TOIL shows each person's days with nothing logged too.

**Changed or removed time.** Run `schema-064.sql` in the D1 console first.
- Time removed from the hub stays removed, and time shortened from the hub stays shortened, even while Tempo's search still shows the old version for a few minutes. If Tempo saves a change as a new worklog, the old one goes.
- Opening a week on My time checks that person's week against Tempo first: anything Tempo no longer has is taken off, however long ago it was logged, and the overtime balance is worked out from what's left.
- **Check this week against Tempo** (under the week on My time) does the same there and then, including time changed in the last few minutes, and says what it found: Tempo's total for the week, each time log taken off, and any added. It works while viewing the hub as someone else (Developer tools), on their week; that check is the one change allowed while viewing as someone.
- Whenever time is taken off this way, the XP it earned goes with it, the week's 1.5x overtime XP is worked out again, and the person's weekly records (XP to date and hours logged, used for their progress over time) are put right from that week on. The button puts the weekly records right even when there's nothing left to take off.
- Today and yesterday are re-checked against Tempo every 3 minutes, as are older days that have just had time logged or changed on them. Every day in the last two months is re-checked in turn, about every 10 hours.
- Time logged or changed in the last 10 minutes is never taken as deleted, as Tempo's search can take a few minutes to show it.

**Lunch and breaks (PMB-1)** aren't working time: they don't count towards anyone's daily or weekly hours, the overtime balance, the week on My time and the home screen, or 1.5x XP for time over contracted hours. They still show, striped, in the day's bar and the day strip on Log time. On first run after this update, every week since overtime began is worked out again without lunch. "How it's worked out" lists each week's change.

**Admin, Overtime and TOIL** lists everyone's balance. Opening someone adds or takes off hours (a minus number takes off), with a date and what it's for, to bring in a balance kept elsewhere or put one right; adjustments can be removed. An adjustment dated before their balance's start doesn't count. Every adjustment is in the audit log under TOIL.

**Logging what's on the screen.** The Log time button shows on any page with Jira items on it, as well as the home screen (while a timer runs, its bar takes the button's place away from home). Going to Log time from a page lists **Items on your screen** first: the Jira items in view when it was tapped, top to bottom (all of them on the page if none were in view), ready to pick. On Jobs, only sub-tasks and items on older orders are suggested, not orders or categories. Orders (epics) aren't suggested anywhere.

## Part 14b3: Light and dark

Everyone can choose **Light**, **Dark** or **Device** (follow the phone or computer's own setting) under **Appearance**, in Account and settings (the round initials at the top right). It's kept on each device, and until someone chooses, the hub follows the device. `public/theme.js` sets it before the page draws. In `public/styles.css`, the colours at the top have dark versions under `:root[data-theme="dark"]`, and the block at the end gives the dark versions of the fixed colours used elsewhere in the file. The company chart download and the release notes preview keep their light look, as they're made to be printed or sent.

## Part 14c: Requests

The **Requests** tile lets anyone ask for a new tile or a change to one, or report something that isn't working: what kind it is, which part of the hub, a title and the details. People see their own requests with their status and any reply.

Anyone in the **Developer** group, and admins, see every request, filtered by status, and can mark each one New, Working on it, Complete or Not going ahead, with an optional reply. Developers are emailed about each new request, and the person who sent one is emailed when its status changes. Emails go through the alert relay.

## Part 14c2: Anonymous feedback

The **Feedback** tile lets anyone send feedback or a suggestion anonymously: the categories it's about, a description of the problem, and any ideas for a solution. It carries the day it was sent.

**Setting it up.** Add one more secret to the Worker before anyone uses it: in the Worker's **Settings**, **Variables and Secrets**, add `FEEDBACK_SECRET` as a **Secret**, set to a long random string (40 or more characters, from a password generator). Keep it only there. Nothing can be sent until it's set. Don't change it later: posts would no longer be recognised as their writers', so writers would lose their replies. Then run `schema-050.sql` in the D1 console.

**How it stays anonymous.**
- Posts and votes are stored against codes made from the sender's sign-in and `FEEDBACK_SECRET`, a different code for every post. Nobody reading the database, admins included, can see who wrote or voted on what, or match two posts to the same person. While signed in, the writer sees their own posts under **Yours**.
- Posts carry the day, never the time. Admins hear about new feedback and replies in a round-up email at 8am and 2pm rather than as they're sent, and opening the tile isn't counted against anyone in Admin's usage figures.
- Developers viewing the hub as someone else never see that person's posts as theirs.
- Anyone who could read both the Worker's secrets and the database could still work out a writer, by trying everyone's sign-in. Keep the secret to the people who already manage the Worker.

**The filter.** Names (everyone in the employee list, their surnames and usual short forms), swearing and slurs, email addresses, phone numbers and @mentions are refused, with the words shown so they can be taken out. Names that are also everyday words, like Key or Mark, count only when written as a name. Admins can add more words to refuse, or words to always allow, under the tile's cog. Replies from the writer are filtered the same way.

**Admins** read each post under **To review** and post it, or turn it down with an optional reason that only the writer sees. Posted feedback goes on the **Board**, where everyone can agree or disagree once each (and change their mind), sorted by most agreed or newest and filtered by category. Admins can reply to the writer on any post, with their name shown; the writer replies as "the writer". Conversations show what's new on each side, and the tile shows the writer when there's something new for them. Admins can also take a posted item down.

## Part 14c2b: Near misses

The **Near misses** tile is for everyone. Run `schema-055.sql` in the D1 console before it's used.

- **Report a near miss**: who's reporting is filled in from their sign-in. It asks the date it happened (not in the future), where, who was involved (anyone at Promtek from the list, and **Outside of Promtek**, which takes a typed name; any number of people), what happened, whether further action is needed (Yes or No), and recommendations to stop it happening again (optional). What's typed is kept on that device until it's sent. Below the form, each person sees their own reports and whether they've been closed.
- **Reports** (people with *Near miss reports*, admins to begin with; change it under Admin, Who can use what): every report, open, closed or all, with how many are open and how many of those need action. Opening one shows it in full, with a box for what was done about it; **Close it** needs that filled in when further action was needed. **Download as CSV** gives every report.
- The people with *Near miss reports* get an email for each new report, saying in its subject when further action is needed.

## Part 14c3: Invoicing

The **Invoicing** tile replaces the old invoice board. It reads the same orders as the WIP, UK or South Africa, and shows every Invoice item on them. Two dates on each Invoice item matter:
- **Target End:** when the work for the milestone should be finished, so the invoice can go out.
- **Invoice Due Date:** when the customer should pay, set when the item is moved to Invoiced.

Each invoice sits in one of these, in this order:
- **Overdue:** invoiced, and its Invoice Due Date has passed (or Jira says Overdue).
- **Ready to be invoiced:** check the draft invoice, then set the item to Invoiced and fill in its Invoice Due Date.
- **Invoiced, waiting for payment:** sent and not yet due.
- **Milestone estimate exceeded:** still New, and Target End has passed.
- **Not invoiced yet:** still New, with Target End still ahead.
- **Paid.**

**Expected payments** adds up everything not yet paid by the month it's due: the Invoice Due Date once there is one, otherwise the customer's payment terms from Target End (or from today, once Target End has passed). Anything invoiced that fell due before this month is kept at the top. Customers' terms are set by the Jira project key their orders start with, under the tile's cog; the old board's terms are filled in to start with, and customers with no terms are listed.

An Invoice item in **Ready to be Invoiced** doesn't count as invoiced in the WIP either until it's moved to Invoiced.

**Service contract invoices.** Invoicing shows the Invoice items under each service contract in their own section, below the orders; the figures at the top and the expected payments include both. A contract's sub-invoices share its value equally (the value the WIP tile uses, including any override) and are spread evenly over its year from its start date: 12 is one a month, 6 every 2 months, 4 a quarter, 2 twice a year, 1 all upfront. They're placed in the order they were made in Jira. A Target End set on a sub-invoice in Jira is used in place of its date in the spread. Only In Contract and Requires Renewal contracts are shown in full; an ended contract keeps only the invoices still waiting to be paid. The buttons and the move to Overdue work the same as for orders.

**Insights.** The Insights tab on Invoicing covers the last 6, 12 or 24 months, for orders and service contracts together: what's owed and how overdue (aged debt), days sales outstanding, how many invoices were paid by their Invoice Due Date and how late the rest were, time to be paid, milestones drafted or invoiced by their first Target End, how long drafts wait to be sent, expected against paid each month (with the months ahead), what's owed at each month end, and, by customer, how they pay, what they owe month by month, their open orders month by month and their share of what's invoiced. Run `schema-051.sql` in the D1 console first. When each invoice was drafted, sent, went overdue and was paid comes from its Jira history, read in the background a hundred invoices a call (the first read takes a few hours), then only for invoices that change; the buttons on the tile note their own dates straight away. Open orders month by month comes from the monthly snapshots, so months before the hub kept them show a dash. A paid date chosen with the Paid button is now kept when Jira is read again.

**When payment is expected.** Once invoiced: on its Invoice Due Date, or without one, on the customer's terms from the day it was invoiced (from its Jira history). Before that: on the terms from Target End, or from today once Target End has passed. Nothing is expected for an invoice with no Target End, one still in Ready to be Invoiced (it isn't sent, and may not be), or one cancelled.

**Deleted in Jira.** Items deleted from a service contract leave the Service contracts tile once the WIP has read that contract again (every half hour), and a contract or order deleted in Jira is let go rather than tried again on every read.

**Groups on the tile.** Orders and service contracts each list their invoices by group: Overdue, estimate exceeded (invoice date passed, for contracts), No Target End, Ready to be invoiced, Invoiced, Not invoiced yet and Paid. Each group, and each of the two sections, folds away with a click on its heading, and stays as it was left on that browser. Paid starts folded. Clicking a total at the top (Overdue, Ready to be invoiced, Waiting for payment, Late to invoice, Paid this month) opens that group in both sections, folds the rest and scrolls to it; Expected this month opens this month in Expected payments.

**Updating invoices from the tile.** People with *Update invoices* (Management by default; change it under Admin → Who can use what) get buttons on each milestone, which write straight to Jira:
- **New, with no Target End or with Target End passed:** a date and Save, which sets Target End. Anyone with *Set invoice Target Ends* (Management and team leads by default) can do this one alone, as long as they can open the tile.
- **New:** **Create Draft**, which moves it to Ready to be Invoiced at once, so Jira's draft-invoice automation runs.
- **Ready to be Invoiced:** **Invoice Sent**, which moves it to Invoiced and sets its Invoice Due Date to today plus the customer's payment terms. The date is shown first and can be changed for special terms; a customer with no terms needs the date entered.
- **Any invoice not yet paid:** **Cancel invoice**, which asks first, then moves it to Cancelled in Jira. A cancelled invoice isn't owed or expected, takes no share of a service contract, and doesn't stop an order counting as fully paid. They're listed, folded, under Cancelled.
- **Invoiced or Overdue:** **Paid**, which asks the date it was paid (today to begin with) and moves it to Paid in Jira; and **Change Invoice Due Date**. A later date on an Overdue invoice moves it back to Invoiced.
Each change is in the audit log. Jira's workflow needs the New → Ready to be Invoiced and Ready to be Invoiced → Invoiced transitions, and the Invoice Due Date field editable on Invoiced items.

**Overdue in Jira.** The hub moves each Invoiced, unpaid invoice to **Overdue** in Jira once its Invoice Due Date has passed, checking at least every half hour, so the Jira automation that did this can be turned off. Paid invoices, and ones given a later Invoice Due Date first, are left alone. It can be switched off under Invoicing's cog, which also lists the last week's moves and any Jira refused; a refused move is tried again, less often, and an alert is sent after a few tries. Jira's workflow needs a transition from Invoiced to Overdue, which it already has if the automation worked.

**Orders moving on in Jira.** With "Moves orders in Jira" on in the WIP settings, the hub runs the order workflow in place of the Jira rule. Run `schema-052.sql` in the D1 console first.
- A **Category** item (Hardware, Software, Condor or Site Visit) is moved to **Complete** once every sub-task under it is done. A category with no sub-tasks is left for someone to complete.
- Once every Category item on an order is Complete, the order moves from Work in progress to **Awaiting Payment** if **Paid?** isn't Paid, to **Documentation Check** if it's Paid and **Documentation** isn't Yes, or to **Done** if both are.
- **Paid?** (customfield_16325) is marked **Paid** once every invoice on the order is paid (or its tokens are). **Documentation** (customfield_15983) is marked **Yes** once the Documentation Check Phase item is done. Each is marked before the order is moved, so Jira lets it leave Awaiting Payment.
- Awaiting Payment moves on once Paid? is Paid, and Documentation Check moves to Done once Documentation is Yes.
- Where Jira has no direct transition, the order goes through the statuses in between, one at a time.
- An order is only moved when something it depends on changes, so one moved back by hand stays put. Orders the hub last looked at under the old rule start from where they are now, and are moved only once something under them changes.
- The WIP's "Status changes in Jira" lists each move, including categories completed and fields marked.

**The WIP as Excel.** On the WIP tile, **Download this month** saves the month chosen, and **Download year** saves a financial year (May to April) chosen beside it, this year or any earlier one the hub has months for: a tab for each month so far, newest first, named like the WIP spreadsheet (WIP Nov 26).
- **Each month's tab** is laid out like the WIP spreadsheet, without the columns that were only there for its formulas or the Kanban automation: OrderID (linked to Jira), Custom Quote Number, Acceptance Date, Ordered Date, Date Complete, Organisation, Title, Upfront Total, Quote Status, Division, WIP Value, Percentage Complete, This month Percentage Change, Non Admin Progress, This month Change, Promtek SA time, Invoiced Value (excl VAT), Percentage Invoiced, Percentage Paid, Amount paid (Excl VAT) and Amount Remaining.
- **Its look:** blue headings, rows banded light blue and white, £ and % formats, the first row and column frozen, a filter on the headings, and drop-downs for Quote Status and Division.
- **Promtek SA time:** the share of the time logged on the order (and everything under it) up to the month's end by the people marked as Promtek SA staff in the WIP settings; blank where they logged none.
- **The totals** sit below the orders in the columns they're about, as figures from the tile rather than formulas: order book, new orders and counts by status under Title and Upfront Total; WIP value, this month's and active value under Division and WIP Value; progress, this month's progress and unrealised value; work progress; invoiced, paid and awaiting payment.
- **After the months:** Active Order Invoices (with Overdue highlighted) and Monthly Recurring, when the year includes this month, and Overall Data up to the last month in the file.

## Part 14d: Page walkthroughs

The first time someone opens a tile, the hub offers a walkthrough of it. Starting it reloads the page in practice mode: a blue bar across the top says so, and the page is filled with example customers, jobs, PSCs and contracts. Each step highlights one part of the page. Steps that explain something have Next; steps marked **Your turn** ask the person to do the next thing themselves (tap this job, type this, choose that) and move on once they have. **Do it for me** does any step for them.

Nothing done in practice reaches Jira, Tempo, 8x8 or the hub's database. Every request goes to `public/practice.js` instead, which answers from its own example data and keeps track of what the person has done, so their logged time, picked-up PSCs and so on show up as they would for real. Leaving practice, or finishing, reloads the real page.

The **?** in each page header starts the walkthrough again. Which ones someone has been offered is kept with their account, so they aren't offered again on another device. Steps for things a person doesn't do, such as approving disputes or Condor triage, are left out for them. The company chart, XP shop and Admin keep a short look round the real page instead.

The wording and steps of every walkthrough are in `public/tours.js`; the example data is in `public/practice.js`. If a page changes, its walkthrough may need its steps updating to match.


## Part 14e: Service contracts

The **Service contracts** tile shows each customer's Service Contract item from Jira: its status, tier, bank holiday cover, dates, service, calibration and obsolescence visits done, and its tokens. The Service team, team leads, Management and admins see it. The Insights tab is for Service team leads, Management and admins.

**Where it reads from.** Service Contract items, with their Service Visit, Calibration Visit and Service Token subtasks. A Service Visit called "Obsolescence Report" counts as the obsolescence survey rather than a service visit. The customer is the project the contract is in. PSC items name their customer in the Organization field, matched to the project by name; any that don't match can be matched under the tile's settings cog. Everything is read every 20 minutes or so by the background job, and straight away with **Read from Jira now**.

**What the hub does once tracking has started** (settings cog, **Start tracking**):
- Contract Sent moves to Needs Chasing when the start date is two weeks away. If the start date passes before it's accepted, it stays in Needs Chasing and an alert says so.
- Contract Confirmed moves to In Contract on the start date; In Contract moves to Required Renewal on the renewal date; In Contract or Required Renewal moves to Contract Expired after the end date. Archived and Contract Lost are never changed.
- Dates that don't add up (not a whole number of years, a renewal date not a month before the end, or what looks like a day and month swapped) raise an alert, and that contract's status is left alone until the dates are fixed or the alert is marked resolved.
- **Token clock.** Each contract has one running clock of the time logged to the contract item, its tokens, and the customer's PSC items (not Snags or Sub-Snags) from the day tracking started, within the contract's dates. Every 4 hours uses the next Available token: it's renamed "Token used for …", linked to the PSC that took the clock over ("implements"), and moved to Token Used. With no Available token left, an "[OVERDRAFT]" token is created instead. When a contract expires, an hour or more left on the clock uses one more token, then any tokens still Available are moved to Token Expired through Admin.
- **Chargeable.** A PSC's time goes on the clock unless the PSC is marked **Not chargeable: Promtek at fault** (on the PSC, or when resolving it), which writes Promtek at Fault to the Chargable field. Resolving without that ticked writes Chargable PSC. Time logged to the contract item itself still asks whoever logged it whether it's chargeable.
- **What used each token.** Clicking a token anywhere in the hub (or opening **What used it** on the contract) lists the items that used it, each with its time, who logged it and how many entries, then every entry with its date and the worklog's description. An entry that crossed from one token into the next is split between them. **Copy as text** and **Download CSV** give it in a form to send the customer.
- **Not chargeable, later.** Each item in that list has **Not chargeable**. For a PSC it marks the whole PSC Promtek at Fault (in Jira too), so all its time comes off the clock, not only what's on that token; for time on the contract item it marks those worklogs. The clock is worked out again at once.
- **Tokens given back.** Whenever the clock drops below the tokens already used, the latest are given back: the implements link to the PSC is removed, the token is renamed to its name before the hub used it (or "Service Token n" by its place among the contract's tokens, for tokens used before this came in), and it's moved to Available through the **Token Refunded** transition. An overdraft token the hub made is deleted instead (or, if Jira won't let the hub delete it, renamed and flagged for someone to delete). Marking time not chargeable gives tokens back straight away; any other drop (a worklog deleted or shortened) waits 15 minutes in case it's only being moved, and is then picked up within the hour. If the clock goes back up before a token has been given back, that token is kept instead. Run `schema-063.sql` in the D1 console first; until then a drop is only flagged, as before.
- Each contract's Available, Tokens used and Overdraft fields are kept up to date. Tokens in Token Allocated count as used in Jira; in the hub they're shown separately.
- Time logged to a PSC item with no Organization emails the person who logged it and the contract alert list, at most once a day per item. The alert for it shows in the PSC tile, where the Organization can be set or the alert marked resolved, not here.

**Bank holidays.** The Contracts tab says whether today is a bank holiday in England, and which is next. The dates come from gov.uk's England and Wales list, checked weekly, so one-off holidays are included; the regular ones are worked out if gov.uk can't be reached.

**Insights** show renewals, token use against each contract's progress, visits falling behind, time that can't reach a contract (last 90 days), and where service time went by customer and engineer (last 30 days). Each total opens to the time logs behind it.

**Alerts** go to the Service team's leads and any Management in the Service team (everyone in the Service team if there are none), plus anyone added under the settings cog. PSC and service contract alerts aren't sent to other admins or managers. That covers the home screen alerts (new PSCs to pick up, contract problems), the bell notifications and these emails. Anything Jira refuses is retried, and after three tries appears in Needs attention and is emailed.

**Logging time** to a Service Contract item first asks whether it was really a contracted visit, and offers that customer's visits instead.

## Part 14e2: PSC

The **PSC** tile shows every support request: the PSC issue types (Incident, Further Investigation, PSC, Problem, Change, Service Request, plus Snag and Sub-Snag when asked for) in the PSC project and the customer projects. The Service team, team leads, Management and admins see it. It's read from Jira every 10 minutes by the background job, and straight away with **Refresh**.

**Who it's for.** An item in a customer project belongs to that customer. An item on the PSC board belongs to the customer its Organization names, matched the same way as for service contracts. The customer's live contract, tier, free tokens and bank holiday cover show on the item.

**Contract tiers.** Each item takes the tier of the customer's live service contract (In Contract or Required Renewal). Bronze, an expired contract or no contract counts as no contract: lowest priority and chargeable. The tiers' terms, from the Maintenance Level Agreements, are at the top of `src/psc.js` and shown on each item:

| Tier | Cover | Callout response | Callout rates | T&M |
|---|---|---|---|---|
| Platinum | 1 to 3 shifts, any day | Same day | £90/hour, £0.90/mile | £80/hour |
| Gold | 1 to 3 shifts, weekdays | 1 working day | £100/hour, £1.00/mile | £90/hour |
| Silver | 1 shift, weekdays (the day shift) | 2 working days | £110/hour, £1.10/mile | £100/hour |
| No contract | Office hours, weekdays (the day shift) | By arrangement | Chargeable | Chargeable |

No tier is covered on Christmas Eve, Christmas Day, Boxing Day, New Year's Eve or New Year's Day; other bank holidays are covered only for contracts with bank holiday cover. Callouts out of office hours carry the £750 breakdown surcharge.

**First look.** Each item is due a first look a set time (by tier, under the cog) after the customer's cover starts: straight away if it was raised in cover, otherwise when their cover next begins. From then it counts around the clock. The first look is the first of: a comment or internal note by someone at Promtek, a change to the description by someone at Promtek, or the item being moved to an In Progress status (by anyone, automations included). On the PSC board, someone at Promtek is anyone with a Jira account (customers there have service desk accounts). On a customer's own project, where customers can have Jira accounts too, it's anyone in the hub's employee list. On a customer copy, the first look on either the copy or its PSC original counts. Jira's automatic replies don't count. An item closed without any of these counts from when it was closed. The first comment or description change in an item's history also counts straight away, without waiting for it to be read again. Items raised by the team themselves count as looked at from the start, and are left out of the response figures.

**After that.** Each item shows the team's last update (who and what), and flags when the customer has replied since the team last did anything, or when it has gone quiet for longer than the setting.

**Filters.** Everyone's, Mine or Unassigned, and an **Assignee** list to pick one person; Contract, Customer and Sort lists; search; Resolved; and Include Snags.

**Triage** opens with three counts: items missing an Organization (on the PSC board), missing an assignee, and waiting for a first look. Below them are the same three lists, each folding open or shut; tapping a count opens its list and goes to it. An item can be in more than one list. Items assigned to Richard Key or Simon Williams count as missing an assignee until that person has commented, moved it on, changed its description, picked it up in the hub or logged time on it (the names are `PLACEHOLDER_OWNERS` in `src/psc.js`). **I'm on it**, **Assign to…** and the Organization list save to Jira; if Jira is busy, the change waits in the hub, is retried, and admins are emailed if it keeps failing. The Organization list comes from the service desk, so the hub's Jira account needs agent access to it.

**PSC with no Organization.** PSC board items with time logged but no Organization are listed at the top of the Triage and Open tabs, with the Organization list to set it in Jira, **New Customer**, which opens the item ready to send to Prospects (see below), and **Mark resolved**. Turning an item into a quote, or sending it to Condor Dev, resolves its alert.

**Not support work: Quote and Condor.** Each open item has two buttons, on its card in the Triage and Open lists (next to I'm on it) and on the item itself; from a card they open the item with the quote or Condor step ready. Run `schema-053.sql` in the D1 console before using them.
- **Quote** turns it into a quote, with its categories and Promtek team chosen first. In a customer's project, the item's issue type is changed to Quote and it's moved under that project's Quote List; where Jira won't change the type (a different workflow, say), a new Quote is made there instead and linked to it. Either way the quote joins the Quotes tile, with the PSC's description, for the sales team.
- On the PSC board (no Organization), the customer is chosen first, and **New Potential Customer** at the top of the list takes a name instead. They go to **Prospects** in the Quotes tile (see Part 21), with the PSC's summary and description as what they're interested in and its reporter as the contact. The PSC board item gets an internal comment saying so, and leaves the PSC tile.
- **Condor** copies it to the MES project as a Bug, with its summary and description, linked to the PSC with the Sync To / Sync From link type (the PSC Syncs To the Bug). It then shows in Condor Dev's **PSC** tab, with the Bug's status, until the Bug is done.
- Once either has gone through, the item, and its PSC board original, leave the PSC tile. If Jira refuses, the hub keeps it, tries again every few minutes, and emails admins after three tries.

**Raised in the last 24 hours.** On Triage and Open, items raised in the last 24 hours are listed first, newest first, under their own heading. The rest follow in the order below (or the Sort chosen).

**Order.** Late items first, then new items due within the hour, then customers waiting on us, then other new items by when they're due; within each, Platinum, Gold, Silver, then no contract.

**Emails.** The Service team's leads (and Management in the Service team; everyone in the team if there are none) hear when an item passes its first-look deadline, or when a change can't be made in Jira or a ticket can't be copied. The owner (or the lead, if no one has it) hears when a customer has been waiting longer than that.

**Settings** (cog, admin only): the first-look target for each tier (Platinum 1 hour, Gold 2, Silver 4, no contract 8 to start with), the day shift (08:00 to 17:00), and how many days without an update before an item is quiet.

### Raising a PSC

**New PSC** (next to Refresh) raises one from the hub, as in Jira:
- **Customer**: type to search the customer projects.
- **Type**: Incident (to start with), Further Investigation, PSC, Problem, Change or Service Request. Snags are raised on their orders.
- **Assignee**: anyone in the hub, you to start with, or unassigned.
- **Summary** and **Description**: blank lines start a new paragraph.
- **Pictures**: up to 10, 10 MB each. Choose them, drop them on the form or paste a screenshot. They're attached to the ticket.
- **Condor**: sends it straight to Condor Dev as a Bug in MES, as the Condor button does.

The customer is known, so it's raised in the customer's own project, under its PSC & Snag List (a Service Request under its Service item), not on the PSC board. The PSC board is for what customers raise themselves, through the portal or by email. The person raising it is the reporter. Where Jira won't let the hub set the reporter, the hub's account raises it and their name goes at the end of the description; where it won't take the list, it's raised without and the lists job moves it under later. It shows in the tile straight away, opened. Every PSC raised is in the audit log.

### Moving a ticket on

An open ticket's page has a status list beside the owner: **<its status>: move to…** lists the statuses Jira allows from where it is, and choosing one moves it in Jira (if Jira doesn't take it, the hub tries again). Resolved [Promtek] isn't in the list, because **Resolve** asks for the root cause and chargeable first. **Admin** is only offered to admins, here, after logging time, and on Jobs.

### Reading tickets in the hub

Opening an item on the PSC tile shows the ticket itself under the hub's details: who raised it (with their email address, taken from the service desk when Jira hides it), the Organization, description, attachments, links, the customer copy or original, and every comment, marked **Internal**, **Only Promtek Members** or **Customer can see**. A link to a PSC ticket or one of its customer copies anywhere in the hub opens the same view in a side panel instead of Jira. A link to a Service Token opens what used it instead (see Service contracts). Links to anything else (contracts, visits, orders) open in Jira; Ctrl or Cmd click always does, and so does **Open in Jira** in the panel. Attachments download through the hub, which checks the file belongs to that ticket first.

People who only have a Jira licence (no service desk agent licence) can read PSC tickets and add internal notes as JSM collaborators, so this is how most of the team work PSC.

**Comments.** Each comment is **Internal** or **Customer visible**:

- On a PSC board ticket, only Internal is allowed: it's saved as an internal note. Customers hear from the copy in their project.
- On a customer project copy, Internal is restricted to the **Promtek Members** group (change it with `PSC_INTERNAL_GROUP`), so Copy & Sync leaves it out. Customer visible is an ordinary comment, which Copy & Sync carries across to the PSC ticket as a public reply.
- Every comment starts with the name of the person who wrote it, since Jira shows the hub's account as the author.

**No Organization.** A PSC ticket with no Organization suggests the likely customer: the Organization on the reporter's earlier tickets, a company email domain that matches an Organization's name, or an Organization named in the summary or description. **Set** saves it to Jira.

### Customer contacts

A customer's ticket gets its Organization filled in automatically when they're a member of that Organization in Jira (the service desk's customer list). The hub keeps a copy of every Organization's members, reading a few Organizations each run and starting again twice a day. Run `schema-060.sql` in the D1 console first; until then, items still save and nothing here runs.

When a PSC ticket raised by a customer is under an Organization they aren't a member of, the hub notes it and emails admins: their next ticket won't get it filled in. The email says when no one else from their email domain is in that Organization yet, since that's the likeliest sign of a mistake. Only tickets raised after this is first running are checked, and each person and Organization only once. People at Promtek (a Promtek email address, or in the hub's employee list) are never linked, as they raise tickets for any customer. Someone in more than one Organization (a manager over several sites, say) is fine as long as they're in the ticket's.

PSC tile → cog → **Customer contacts**:
- **Add to …** adds them to the Organization in Jira.
- **A different Organization** adds them to the right one instead, when the ticket was put under the wrong customer (put the ticket right too).
- **Not right** drops it without changing Jira.
- **Find a customer** searches everyone in an Organization by name or email, to **Move** them to another Organization or **Take out** of one, in Jira as well.
- **Recent changes** shows who did what. Every change is also in the audit log.

The hub's Jira account needs to be a service desk agent (or admin) to add and remove Organization members.

On a ticket in the hub, **Raised by** shows which Organizations the customer is in, and a PSC ticket under an Organization they aren't in says so. A ticket with no Organization suggests, first, the Organizations the customer is in, then ones other people from their email domain are in, then their earlier tickets and any customer named in it. On a customer project item, **Customer** shows the project.

### Customer copies, made by the hub

This replaces the two Jira automations (rule 2178201 on create, 2177983 on edit) that filled in the **Automation** field and called Copy & Sync.

Every PSC read (10 minutes), PSC board tickets with an Organization, no copy in that customer's project yet, not done, and changed since copying was switched on are copied, up to 5 a run. For each, the hub:

1. skips Quotes (issue type 13031, or "quote" in the summary), which the PSC to Quote recipe handles;
2. finds the customer project named exactly as the Organization (then ignoring case and spaces); with none, it records why and emails admins;
3. treats an existing link into that project as the copy, so nothing is made twice (links into other projects are ignored);
4. otherwise puts the project in the Automation field (`customfield_14981`) and calls Copy & Sync's copy endpoint with the **Copy & Sync Work Items** recipe.

Each ticket is asked for once. Its state (asked for, copied, failed, no project) shows on the ticket in the PSC tile, with **Ask again** or **Copy to the customer's project** for one that failed or came before copying was switched on. Admins are emailed when one fails.

**Setting it up:**

1. Run `schema-059.sql` in the D1 console.
2. Add the secret `COPYSYNC_TOKEN` with the Copy & Sync API token: `npx wrangler secret put COPYSYNC_TOKEN`. It's never kept in the code.
3. New copies use Copy & Sync Work Items v2. To use a different recipe, add `COPYSYNC_RECIPE` as a variable with its ID (see The Copy & Sync recipes below). Optional: `COPYSYNC_URL` if Elements ever moves the endpoint, `PSC_INTERNAL_GROUP` if the internal group is renamed.
4. PSC tile → cog → **Customer copies** → **On**. Only tickets changed from that moment are copied automatically.
5. In Jira, disable automation rules 2178201 and 2177983 straight after, so tickets aren't copied twice.

### The Copy & Sync recipes

Copy & Sync keeps each synced pair against the recipe that made it, so deactivating a recipe stops every pair it made from syncing. Old recipes stay active for their existing pairs; fixes apply to pairs made from now on.

**Copy & Sync Work Items v2** (`RECIPE_e3e97e4e-2f15-44fb-8eec-76f427acd9f1`) makes the hub's new copies. Set `COPYSYNC_RECIPE` only if that changes. It's only run when called (by the hub, or by hand in Jira), never by a link being added, so it and the original **Copy & Sync Work Items** can both stay active without syncing anything twice: the original keeps the pairs it already made. Compared with the original:
- Status changes go both ways (the workflows match across projects).
- Customer-visible comments made on the customer copy are public on the PSC ticket.
- No longer maps: Issue Type, Status category, Resolution, Sprint, Creation Date, Progress, Summary → Key and Summary → IMS Origin Item. These either can't be set on a copy, are set by Jira, or overwrote other fields with the summary.
- **Reporter → Reporter must stay mapped.** Without it, Jira shows the Copy & Sync account (whoever owns the token) as having raised the copy, not the customer who raised the PSC ticket.

**Who raised it.** As a safety net, the hub sets the reporter of each open customer copy back to whoever raised its PSC ticket, 15 a run, once each. Closed copies are left alone. Jira refuses when that person isn't a customer of the copy's project (their Organization isn't on the project); PSC tile → cog → Customer copies → **Who raised it** shows how many were put right and any Jira refused.

Before activating it, in its Comments tab set **Restrictions** → **Synchronise public comments**, so internal notes and Promtek Members comments never cross, and **Visibility in JSM** → **Always public**, which needs a Synchronisation Author with a service desk agent licence. Without one, a customer-visible comment from someone with no agent licence lands as internal on PSC.

**Sync Work Items** stays as it is. It runs whenever a Sync From / Sync To link is added (the hub's Condor button adds one between a PSC ticket and its MES Bug), so a second recipe on the same link would sync every new pair twice. Its "Entity not found" mappings are to fields that no longer exist and do nothing.

Copy one test PSC ticket from the tile afterwards and check the copy, a comment each way and a status change.

## Part 14g: IMS

The **IMS** tile treats the ten IMS projects (GOALS, LEGAL, HEALTH, COMPLIANCE, FINANCE, INNOV, IS, MARKETING, SUGGEST, QA) and the IMS Main Board (PROMTEK) as one. Management and admins see it (change it under Admin, Access). Run `schema-061.sql` in the D1 console first.

**How it's read.** Everything in those projects is read once a day, a few pages a run, and what changed every 10 minutes (**Refresh** reads now). Fields are found by name: IMS Task Type, IMS Task Sub-Type(s), Included IMS Categories, Root Cause, Is Root Cause Required?, IMS Origin Item, Start date, Target end and the 8D fields.

**One item, many copies.** Copies of an item in several areas are joined by Sync (or clone) links, or name the same item in IMS Origin Item. The tile shows each such item once, with a chip for each area it's in. Filter by area to see one area's items, as in its own project.

**Keeping copies in step.** The hub remembers, for each item, the value of each of these fields that all its copies had: summary, description, status, assignee, priority, labels, IMS Task Type, sub-type, areas, root cause, root cause required, start date, target end, and the 8D text fields.
- A change made to one copy, in Jira or the hub, is made to the others: from the hub straight away; from Jira at the next read (within about 10 minutes). The hub records what it wrote, so nothing bounces back.
- Copies that already disagreed when the hub first looked are left alone, marked **Copies differ**, and the item shows each copy's value with **Use this**. **See the list** (Items tab) lists them all to tidy by hand; **Make every copy match its latest version** settles them all in favour of each item's most recently updated copy (as Jira last saw it changed).
- A copy the hub hasn't seen before (one just made, say) is brought in line with the others.
- Status changes use the copy's own workflow. Where a copy can't go straight to the new status, Jira's refusal is shown on the item and in the count at the top of the tile, and the hub tries again a few times.
- Comments and attachments stay on the copy they were added to.

**Adding an area.** Ticking an area on an item (in the hub, or in Included IMS Categories in Jira) makes a copy in that area's project: same fields, in a folder of the same name if there is one, linked Sync To from the original, with IMS Origin Item set to the original. Taking an area off leaves its copy where it is. Areas already missing a copy when the hub first looked are left as they are.

**What counts.** Folders, legacy items, meeting sub-tasks and the IMS Main Board's own items aren't counted as items. Other sub-tasks are (most non-conformities are raised as sub-tasks). In Operational Improvements (SUGGEST) only IMS Tasks, 8D Reports and Incidents count, and sub-tasks under them; its product ideas and features are left out of the tile. An item with copies counts once overall and once in each of its areas. Copies made before the Sync links were in place (the same summary and type, raised in different areas within the hour) are counted as one item too, and listed to be linked up.

**Stats.** For the whole IMS or one area, over the last 12 months or one month: step through the months with ‹ and ›, the month list, or by choosing a bar or point on a chart. Every number follows the month chosen.
- Along the top: open (and past target) at the end of the month, raised and closed in it (with the typical time to close), non-conformities open and raised (non-conformities and incidents), 8D reports open, and root cause still needed.
- How long since the last incident, non-conformity and 8D report, each opening that item. These are rare enough that a chart says less than the date.
- One chart month by month, switching between raised and closed, non-conformities, and what was open at each month's end.
- Each area's open items and incidents, non-conformities and 8D reports (red: one of those open; blue: open tasks; green: clear).
- Pie charts by IMS Task Type (open or raised), root causes (raised or open) and sub-type, and open by assignee as bars. Root causes leave out items marked as not needing one, and "Not set" there is only items that need one.

**What's behind a number.** Any number, slice, legend entry or bar opens the items that make it up. Where an item has its IMS Task Type, assignee, root cause (when one is needed, or on a root cause chart) or sub-type (on the sub-type chart) not set, it can be set there and then, as in PSC Triage; the change goes to every copy.

**Items tab.** Each area's button is coloured by what's open in it: red for an open incident, non-conformity or 8D report, blue for other open work, green for nothing open. **See the list** under the copies-disagree note lists every item whose copies disagree, field by field with each copy's value, and the likely unlinked copies, to tidy by hand. **Match the latest** on an item makes its other copies match the one updated most recently (marked *latest*). **Dismiss** on an item leaves its copies as they are and takes it off the list and the count; it comes back only if another field starts to disagree. **Make every copy match its latest version** skips dismissed items.

**Meetings.** The meetings under the Management Meeting List (PROMTEK-21), newest first, with how many items each raised. A meeting shows its minutes (attachments, opened through the hub) and the items linked to it. **New meeting** (top right on the Meetings tab) adds one under the list with its date. **Upload minutes** attaches them and, if ticked, moves the meeting to For Reference.

**New IMS item.** Choose the areas it belongs to and its main area (where it's raised), then kind (IMS Task, Incident, 8D Report or Change Management), IMS Task Type, assignee, Promtek Staff Involved, dates, root cause required, the meeting it came from, summary, description, sub-type and root cause. It's raised in the main area with IMS Origin Item set to itself, copied to the other areas straight away, and linked to the meeting with the Active/Legacy link.
- **Root cause required?** Yes or No must be chosen for every kind except Incident and 8D Report, which always need one. Items marked No are left out of the root cause numbers and charts.
- **Incident** has tabs: Incident (Date & Time of Incident, Location of Incident, What Happened?, Incident Severity 1 to 5), Result of Incident (Description of Injury/Damage) and Response (Containment, root cause, Contributing Factors, Analysis & Planning of Corrective Actions).
- **8D Report** has tabs: 8D Information (Business Area, Customer, Customer Address), Persons Involved (filled in from Promtek Staff Involved, with more added by hand), Description of Problem, Containment, Root Cause Analysis & Plan of Corrective Actions, and Corrective & Preventative Actions.
- **Change Management** is an IMS Task with a Change Description table and a Change Documentation table.
- Tables are filled in a row at a time (**Add another**) and written to Jira as tables.
- The form only shows the fields the chosen type has in the main area's project (read from Jira, so a field added to a screen there shows up within six hours). If Jira refuses a field when raising, the item is raised without it and the hub says which were left off.
- Gap analysis items aren't raised here yet.

**The IMS Main Board's categories.** Each area's category item (PROMTEK-2 Strategic Objectives to PROMTEK-20 Quality Assurance) follows the area's colour, at each read (every 10 minutes, or **Refresh**): **Active Incident** while an incident, non-conformity or 8D report is open in the area, **Active Tasks** while other work is, and **Clear** when nothing is. So it only comes down a step once everything at the step above is closed. A category moved by hand in Jira is put back. Each move is in the audit log. If Jira won't make a move (a transition missing from the workflow, say), the IMS tile says which and why, and the hub tries again at each read. PROMTEK-1 Management Team is left alone.

**5 Whys.** Alongside Root cause, on an item's page and when raising one (on the Response tab for incidents and Root Cause Analysis for 8D reports): the problem, then "why?" asked of each answer in turn (**Ask why again**), the last answer being the root cause, whose category is chosen under Root cause. It's optional and offered on every task and sub-task, whether or not a root cause is required. Nudges, not rules: an answer about what someone did ("forgot", "didn't check") suggests asking why once more; stopping before three whys suggests going on; a root cause chosen without a 5 Whys gets a reminder, and the Stats tab counts them (under Root causes, opening the list). It's kept in Jira's **5 Whys** field (customfield_16920) as a table, Problem then Why 1, Why 2 and so on, so it's readable there; it's kept the same on every copy like the other fields, and copied to new copies. The field needs to be on the create and edit screens of IMS Task, Incident, 8D Report, Change Management and Internal Sub-Task in the ten IMS projects (a sub-task's page says so if its screen hasn't got it): where it isn't, Jira won't take it, and the hub says so (when raising) or shows it waiting on the item. Text typed into the field in Jira is shown as it is, and set out as a table when saved from the hub.

**Preboarding and onboarding.** When raising an item, **Onboarding** isn't offered as a sub-type, and **Preboarding** is offered only when Information Security is the only area. Jira's automation adds the preboarding sub-tasks to a Preboarding item. Once every sub-task under it is done (status category Done), the hub adds **Onboarding** to its sub-types alongside Preboarding, at the next read, which starts Jira's next automation. It's done once: an item that already has Onboarding is left alone. Each is in the audit log, and if Jira won't take it the IMS tile says so and the hub tries again. New sub-types added in Jira show in the hub within 12 hours.

**Root cause, when required.** On a new item, Root cause shows only once **Root cause required?** is Yes (always for incidents and 8D reports); the 5 Whys is always there. On an item's page the same, except that a root cause already filled in is always shown.

**Moving an item on.** Each item in the list has **Move…**, and an item's page has a move list beside its status: both offer the statuses Jira allows from where it is (Admin only to admins). Choosing one moves the item and every copy of it in the other areas, as the person who chose it. A copy whose workflow can't go straight there is shown as waiting on the item, and the hub tries again; it can be moved in Jira by hand. Sub-tasks move the same way from their own page.

**Sub-tasks.** Sub-tasks aren't in the Items list, and the area buttons count only the items listed (an open sub-task still turns its area red or blue). Searching for a sub-task's key, summary or assignee finds the item it's under. An item's page lists its sub-tasks, each once however many copies it has, with the areas it's in, its status and assignee. Tap one to open it in the hub, where it can be changed like any item (summary, status from those its workflow allows, assignee, dates, root cause and its 5 Whys), saved to every copy; **↑** at the top goes back to its parent. **Add a sub-task** takes a summary, assignee, dates, whether a root cause is required, a description and a 5 Whys. It's made as an **Internal Sub-Task** (or the area's own sub-task type) under the item's first copy, then copied under each of the other copies, joined by Sync links and the IMS Origin Item like any copies, and kept in step from then on. When an area is added to an item, its copy there gets those sub-tasks too. A sub-task made in Jira under one copy, from now on, is copied under the others the same way; if one of the same name is already under a copy it's joined to it rather than made twice. Sub-tasks from before this are left where they are. Sub-type sits above Summary.

**Jira rules to turn off** once the tile is in use:
- **IMS - Clone to Other Category on Creation** and **on Edit**: the hub makes the copies now. Left on, items raised in Jira would be copied twice. (Items raised in the hub name themselves as origin, which those rules skip.)
- The eleven **Task Counter** rules and **IMS - Total Task Counter**: about 130 searches an hour for numbers the Stats tab works out.
- **IMS - Task Status Transition 1/2 and 2/2**: the hub moves the IMS Main Board's categories itself (below).
- **IMS - Number of Items Needing Action** and **Number of Sub-task Requiring Action**: the tile shows these.
- Keep the Onboarding, Leaver, 8D set up and training gap rules for now.

Copies made before the tile are also still synced with their original by Copy & Sync (the original Copy & Sync Work Items recipe). That does no harm alongside the hub, but keep the IMS on that original recipe: the v2 recipe made for PSC doesn't fill IMS Origin Item. Copies the hub makes aren't Copy & Sync copies.

## Part 14g1: Gap analysis

Run `schema-067.sql` in the D1 console first. The **Gap analysis** tab is on the IMS tile, so only those with the IMS tile (management) see it.

**Each meeting's gap analysis.** Adding a meeting on the Meetings tab makes a Gap Analysis item for it in Compliance & Training, linked to the meeting. One that nothing has been put in yet isn't left behind: it moves on to the next meeting instead, until it's used. Before the first meeting is added through the hub, **Start one now** makes one for the latest meeting.

**Gap areas.** Inside it, **＋ New gap area** for each team or group being looked at (keep Projecting, Service and Condor apart, as each person is assessed by their line manager). Each goes through six steps, and shows only what each step needs, so nothing earlier colours what comes later:
1. **Skills needed**: the name, team, Objective(s), Promtek Staff Involved, Industry Regulations / Standards, and the Identified Skills Required, one a line, each with the level needed. **Lock the skills** when they're right: from then they can't change, so everyone is assessed against the same thing.
2. **Plan assessments**: for each person, who assesses them (their line manager, set on their page under Admin, People; anyone else can be chosen), the Assessment Tasks and the Date of Assessment. **Send the assessments** makes a Skill Assessment item for each, assigned to the assessor, who's told (IMS notifications, "Skill assessments").
3. **Assessing**: each assessor rates their person on each skill, 0 None, 1 Aware, 2 With help, 3 Competent, 4 Can teach it, with a note. They don't see the level needed, or anyone else's ratings; nor does anyone looking at the gap area until every assessment is in. Assessors find theirs under "Your assessments to do" at the top of the tab. Each completed assessment is written to its Skill Assessment's Assessed Current Skill and completed in Jira.
4. **Gaps**: once the last assessment is in, the ratings and levels needed are shown side by side (green meets it, amber one level short, red two or more short), and every skill rated below the level needed is listed as a gap. Each is kept, with a Plan for Gap, Training Provision and due date, or dismissed. Gaps the ratings didn't show can be added by hand. **Raise the training** makes a Training Requirement for each kept gap; with none kept, the area is closed.
5. **Training**: each gap's training is marked done in the hub, or its Training Requirement completed in Jira (picked up at the next IMS read). A Toolbox Talk can be arranged straight from the gap. **On the training matrix** links the gap to a matrix course, or adds it as a new one, by hand; training done is then recorded on the matrix. Once done, **Did it work?** records a fresh rating, to show the training was effective.
6. **Gaps filled**: once every kept gap's training is done, the Gap Area moves to Gaps Filled; once every area in the gap analysis has, it moves to All Gaps Closed.

**In Jira.** Everything entered is written to the items' fields as it's saved: Objective(s), Team, Promtek Staff Involved, Industry Regulations / Standards, Identified Skills Required (a table with the levels), Assessment Tasks, Who is being assessed, Date of Assessment, Assessed Current Skill (a table), Identified Gap, Plan for Gap, Who Requires the Training, Training Provision and the Training Requirement's Due date. Fields are found by name; any a screen doesn't have are noted on the tab. Items are moved through the workflow to the status that fits each step. Make changes in the hub: changes made to these fields in Jira aren't read back (only Training Requirements being completed are). The hub never sets "Information Filled". Gap items are kept out of the IMS items list and stats.

**Jira automations to turn off** once this is in use: the monthly Gap Analysis creation, and every gap analysis rule (Information Filled making a Gap Area or Skill Assessments, Skill Assessment completed copying to the Gap Area, Training Provision making a Training Requirement, Training Requirements completed moving the Gap Area to Gaps Filled, and Gap Areas filled closing the Gap Analysis). Left on, they'd make items twice, and copy ratings onto the Gap Area before every assessment is in.

**Overview.** The tab lists the open gap analysis and its areas with their step and progress, earlier ones folded away, and skills that keep coming up as gaps.

## Part 14g2: Training & Policy

Run `schema-065.sql` in the D1 console first. Whoever has the **IMS** tile (management and admins) sees it as IMS, with **Training** and **Policy** tabs alongside Items, Stats and Meetings. Everyone else sees it as **Training & Policy**, which shows just three lists: tool box talks coming up for them, tool box talks for them to acknowledge, and policies for them to acknowledge. Arranging talks, publishing policies, keeping the matrix and seeing who has acknowledged need **Manage training and policies** (management by default; change it under Admin, Access).

**Training.** Courses (with how often they're due again), grouped into divisions, with each person's state for each: done (with the date, an expiry, evidence link and note), required, optional, not applicable. Expired and due-within-30-days show in red and amber. Five views:
- **Overview**: how much required training is in date, the next tool box talk, counts of expired, due soon and not done (each filters the list), everything that needs doing (most overdue first), and each division's figure (opens its matrix).
- **Tool box talks**: coming up, to acknowledge and held.
- **People**: everyone, least in date first, searchable and by division; open someone for their training, worst first.
- **Courses**: each course with a bar of who's in date, due, expired and not done; open one for who has it.
- **Matrix**: the grid, one division at a time (or every division), with symbols in place of dates (**Show dates** brings them back).
Anywhere, choosing a person's course opens it to record training. **＋ Course** and **Download CSV** are at the top right.
- **Everyone on the hub is in the matrix.** Someone not yet in a division has no courses that apply; the cog on their page sets their divisions (and a note, such as their role). A name from the old spreadsheet that doesn't match anyone on the hub can be matched to someone, or taken off the matrix from the same cog.
- **Changing a course.** Open it under Courses and use the cog: **Edit the course** (name, category, how often, divisions) or **Delete the course**, which takes it off the matrix and every division but keeps the training recorded against it. A person in the matrix is linked to their hub account by name; anyone left unlinked can be linked by hand.

**Bringing in the current matrix.** `training-matrix-import.sql` (sent separately, not in the ZIP, as it holds people's training records) loads the AD2 matrix: 72 courses across Service Division, Projects Team, Office/Sales, Development team and IT Department. Run it once, after `schema-065.sql`, in the D1 console or with `npx wrangler d1 execute <database> --remote --file=training-matrix-import.sql`. Run it only once: running it again would put the spreadsheet's values back over changes made in the hub since.

**Tool box talks.** **Create tool box talk**: title, date and time, length, where, a Google Meet or Teams link, what it's about, the matrix course it counts as (if any), and who it's for (everyone, teams, matrix divisions or named people). It's raised in Jira as an Internal Training item in Compliance & Training, dated the day of the talk. Everyone it's for is told straight away and reminded each morning until the day, with a countdown; the meeting link is on the alert and the talk. Once the talk has started they acknowledge it; if it counts as a course, that's recorded on the matrix. Management see who has and hasn't acknowledged, can change the link or time, and can cancel it.

**Before and after a talk.** Run `schema-068.sql` first. When a talk is arranged, its Internal Training item gets the talk's day as its Target end date and is moved to **Training Date Confirmed**. Each hour the hub looks for talks that have finished: each is moved to **Training Provided**, the join link is put away (management still see it under Change it), and everyone it was for who hasn't acknowledged it is emailed the link to acknowledge it (Training & Policy notifications, "Tool box talk to acknowledge", emailed by default) and shown an alert on their home screen. The alert can't be dismissed; it goes once they've acknowledged. Talks that finished more than three days before this first runs, and talks from the old spreadsheet, aren't chased. If Jira won't make a move (a status named differently, say), the talk says so to management.

**Reminding.** On a tool box talk (once it has started) and a policy, management see **Email the N people who haven't acknowledged it**. Each person still to acknowledge it gets an email straight away (whatever their notification settings), with a link that opens it ready to acknowledge, and the same in the hub's notifications. The page shows when everyone was last reminded. It can be sent once every 10 minutes, and each one is in the audit log.

**Acknowledging.** Under "I attended this tool box talk and understood it", everyone chooses how they found it (good, OK or poor) and can leave feedback. Management see the totals and the comments on the talk, and each person's face beside their name.

**Who's had each one.** Under Training, **Tool box talks**, **Who's had each one**: every topic across the top, everyone on the hub down the side, and the date and time each last acknowledged it. A topic is due again a year after it was last acknowledged: amber in the month before, red once it's a year or more. A cross is someone asked to a talk on it who hasn't acknowledged it; a dash, someone never asked. The Overview shows the same totals. A talk's **Topic** (on the new talk form, suggested from earlier ones) is what groups repeats of the same talk; left blank it's the title.

**Bringing in the old spreadsheet.** `toolbox-talks-import.sql` (sent separately, not in the ZIP, as it holds people's records) brings in the talks already held from the Training and Awareness schedule: ISO Accreditation (1 July 2025), ISO and Fire awareness (6 August 2026) and Housekeeping (7 October 2026), with who was asked and when each person completed it. Run it after `schema-068.sql`, in the D1 console or with `npx wrangler d1 execute <database> --remote --file=toolbox-talks-import.sql`. Running it again does no harm. Names are matched to the hub either way round; anyone whose name doesn't match isn't brought in. Topics on the spreadsheet with no date yet are left to be arranged as talks.

**A talk's documents.** The presentation or any other document can be attached when the talk is created, or later from the talk (**Attach a document**, up to 50 MB each). They're kept as attachments on the talk's Internal Training item in Jira, so they're there too, and ones attached in Jira show in the hub as well (each time the talk is opened, or with **Check again**). Everyone the talk is for sees them on the talk, on the Training & Policy tile or the IMS tile. PDFs and pictures are read right on the page; PowerPoint and Word files open in PowerPoint or Word (browsers can't show them), so a PDF copy saved alongside lets everyone read it in the hub. Management can remove them. (The hub's pages now allow frames from the hub itself, for the PDF reader; nothing from anywhere else.)

**Sending the acknowledgement link.** Once a talk has started, management see **Send people straight to the acknowledgement** on it (and on every policy): a link to copy into an email or chat message. It opens that talk or policy, ready to acknowledge, for anyone it's for: on the Training & Policy tile for staff, or the IMS tile's Training or Policy tab for management. It asks them to sign in first if they need to.

**Policies.** Publish a policy with links to its documents, a version, who must read it and an acknowledge-by date. Nothing is made in Jira. Each person ticks "I have read and understood this policy" and acknowledges it. Management see who has and hasn't. A new version asks everyone again. Those who haven't acknowledged are reminded on Mondays.

**Notifications.** The tile's bell chooses how new talks, talk reminders, new policies and policy reminders arrive, like other tiles.

## Part 14g3: Birthdays

Run `schema-066.sql` in the D1 console first. Until it's run, people still save as before and no birthdays show.

Each person's page (Admin, People) has an optional **Birthday**: the day and month only, no year. On the day, from 7am on weekdays:
- The home screen's news says whose birthday it is ("It is Sam Lee's birthday today: wish them a happy birthday"). Birthdays shared with someone else are one message ("Birthdays today: Owen Hume and Sam Lee"). The person themselves is wished a happy birthday instead, and told who they share it with.
- Everyone gets a notification, worded the same way, under **Everything else**, **Birthdays** in the bell's choices (in the hub by default, not emailed; each person can change it).
- Birthdays on a Saturday or Sunday are caught up on the Monday, as belated. A 29 February birthday falls on the 28th in other years. People who have left aren't included.

## Part 14h: Notifications

Run `schema-062.sql` in the D1 console first. Until it's run, alerts are emailed exactly as before.

**The bell.** The bell at the top of every page shows how many notifications are new; press it for the list. Pressing one opens the page it's about, with the PSC, IMS item, contract or near miss open. It checks for new ones every minute. On a device that allows notifications, new ones also show on screen while the hub is open in the background. Browsers only show them while the hub is open somewhere; with it fully closed, email is the way to hear.

**Choosing.** Each tile has a bell button at the top right of its page. Everyone chooses, for each thing that tile can tell them about, whether it shows in the hub, is emailed, both or neither; and for PSC and IMS whether it's every item or only those assigned to them. PSC also lets you untick customers (wherever their tickets are raised) and pick priorities. IMS lets you untick areas. Emails can come one at a time or as one email at 8am, and can be held outside 8am to 6pm, Monday to Friday. "Everything else" (from the bell or the home page) covers messages for everyone and any other alert.

**What PSC tells you about.** New PSCs, assigned to you, customer comments, team comments and internal notes, status or owner changes, resolved, first look overdue, and customers waiting. The hub sees these as it reads Jira (every ten minutes), so they come a few minutes after the change. A customer's copy of a PSC ticket isn't counted twice. Nobody is told about what they did themselves.

**Every other alert** the hub sends to a person (estimate requests, new orders, timers left running, near misses, renewals and the rest) now follows that person's choices. Alerts to the hub's own alert address, and to people not in the hub, are emailed as before.

## Part 14f: Which Jira projects the hub uses

The hub only lists and searches customer projects, the ones in the **Promtek UK Customers** and **Promtek SA Customers** categories, plus its own working projects: MES (Condor Dev), PSC (service items), PMB (general tasks and assisting), PROMTEKIT and ASSET (IT support) and the ten IMS projects (internal time). Any other project, such as CSIMS, CSIMSB, CSIMST, ARCHIVE, TEST or TPB, is left out without needing to be listed, so a new testing project stays out as long as it isn't put in a customer category. CSIMS, CSIMSB, CSIMST, ARCHIVE, TEST and TPB are also blocked outright, in case one is ever put in a customer category by mistake. Both lists are at the top of `src/jira.js`.

Looking up a particular item by its key still works, so TEST is a safe place to try things out. The list of customer projects is read from Jira every six hours.

## Part 14f2: Changes in Jira made as the person

Without this, everything the hub does in Jira shows in Jira's history as the hub's own account. With it, a change someone makes in the hub is made as them. That covers editing an IMS item, adding a sub-task or comment, moving a job, raising a tool box talk, uploading a file, and changes to customers' copies of PSC tickets (assigning, resolving, commenting and so on, from the PSC tile too). The exceptions all stay with the hub's account:
- The PSC board's own items (PSC-…), whoever changes them, including making their customer copies.
- Fetching the latest from Jira.
- The hub's own background work, such as IMS copies and keeping them in step, and a change Jira didn't take first time that the hub tries again later.

Reading from Jira always uses the hub's account.

**Setting it up (once):**
1. At developer.atlassian.com, signed in as a Jira admin, open **Developer console** and **Create** an **OAuth 2.0 integration**. Name it Promtek Hub.
2. **Permissions:** add **Jira API** and give it `read:jira-work`, `write:jira-work` and `read:jira-user`.
3. **Authorization:** set the callback URL to `https://<the hub's address>/api/jira-connect/callback`.
4. **Distribution:** turn on **Enable sharing**, so people other than the app's owner can connect. Fill in Promtek as the vendor, a privacy policy link, and say the app stores personal data (each person's access to Jira).
5. **Settings:** copy the Client ID and Secret, then add them to the Worker:
   - `ATLASSIAN_CLIENT_ID`, as a variable or a secret.
   - `ATLASSIAN_CLIENT_SECRET`, as a secret: `npx wrangler secret put ATLASSIAN_CLIENT_SECRET`.
6. Run `schema-069.sql` in the D1 console.

**Connecting:** until someone connects, the hub asks as soon as it opens, in a box that can't be closed: **Connect my Jira account**. Their home screen alerts say the same. **Connect** takes them to Atlassian once, to allow the hub, and back. The hub checks the Atlassian account is theirs, on Promtek's Jira, before keeping it. If connecting doesn't work (the page says why), **Back to the hub** lets them carry on until they next open it. If Atlassian says the app needs approving, a site admin approves it once in admin.atlassian.com under Connected apps. Nobody is asked on the shared tablet, or while viewing as someone else.

**How it keeps working:**
- **Storage:** each person's access is kept locked (encrypted with a key made from the client secret) and renewed as it runs out.
- **If the connection stops:** if it lapses (after about 90 days unused, or if they remove the app from their Atlassian account), their change still goes through as the hub's account, and their home screen asks them to **Reconnect**.
- **If their own account can't do something:** anything their Jira permissions don't allow is done as the hub's account instead, so nothing stops working.
- **Changing the client secret:** this disconnects everyone, and they each connect again.

## Part 14f3: The shared tablet

A company tablet stays signed in to the hub as **automation@promtek.com** (set `TABLET_EMAILS` to use another account, or several, separated by commas). Instead of the home screen it shows **Who's using the tablet?**: each person taps their name and enters their PIN, and the hub is theirs.
- **Who it acts as:** their tiles, their time, and their changes in Jira (as them, once they've connected their Jira account). The audit log notes when each person starts using the tablet.
- **Switching and timing out:** **Switch user** in the top bar goes back to the names. Left untouched for 30 minutes (set `TABLET_IDLE_MINUTES` for another time, from 1 to 240), the page is covered by **Still you, <name>?**. Their PIN carries them on exactly where they left off, with anything half-typed still there. **No, switch accounts** goes back to the names. While it asks, nobody can carry on as them, and if a change was sent just as it locked, they're asked for their PIN and can send it again.

**PINs.** Each person sets theirs from their own sign-in, under their account menu, **Shared tablet PIN**.
- **Rules:** 4 to 8 digits, not one digit repeated, and not a run like 1234.
- **Storage:** kept only as a salted hash.
- **Who's listed:** everyone in the UK (anyone not marked Promtek Africa on the company chart). Anyone without a PIN yet is marked **No PIN yet**, and tapping their name shows how to set one from their own phone or computer.
- **Wrong PINs:** five in a row lock that person out on the tablet for 15 minutes.
- **Changing or removing a PIN:** this ends any session on the tablet under the old one.

**On the tablet nobody is an admin.** Admin tools, the settings cogs, viewing as someone else, connecting a Jira account and setting a PIN all need the person's own sign-in. Everything else (management permissions from their groups included) works as usual.

**Setting it up:**
1. Run `schema-070.sql` in the D1 console.
2. In Cloudflare Zero Trust, make sure automation@promtek.com can get through the hub's Access application. Give it a long session (a policy just for it with a session duration of a month, say), so the tablet isn't asked to sign in to Google often.
3. On the tablet, open the hub in Chrome, sign in as automation@promtek.com, and install it as an app (Chrome menu, Add to Home screen / Install app). It opens full screen from there.
4. Ask everyone who'll use it to set their PIN (the tablet also tells anyone without one how, when they tap their name).

**Keeping it to the hub (kiosk).** A web page can't stop someone leaving it, so this is done on the tablet:
- **Android's App pinning (free):**
  - **Turn it on:** Settings → Security → More security settings → App pinning (the wording varies by make), with **Ask for PIN before unpinning**.
  - **Pin the hub:** open the hub app, open the app switcher, tap the hub's icon and choose **Pin**.
  - **Get out:** hold Back and Overview together (or swipe up and hold, with gesture navigation), then enter the tablet's own screen-lock PIN. Only admins know that PIN.
- **Fully Kiosk Browser (a paid app, a few pounds per tablet):** locks the tablet to the hub, keeps the screen on, and reloads if it crashes. Its exit is a secret gesture (a swipe from the left edge, or several taps in a corner) followed by its own kiosk PIN.

## Part 15: 8x8 calls

Engineers open the tile, pick a day and tap to fetch their calls. Nothing is pulled from 8x8 until someone asks, which keeps it quick and means each person sees their own calls.

Missed incoming calls are left out, since there's nothing to log against them; outgoing calls always show. On the everyone view each call carries the name of whoever dealt with it.

Each call offers four choices: relate it to a job, to an existing PSC, raise a new PSC, or discard it. Anything but discard leads to logging the time, and the customer step is skipped when the number is already known. An unrecognised number asks who it was, and remembers the answer, so the list gets better the more it is used. A number can also be marked as not work related, and it won't be suggested again.

### Setting it up

1. In the 8x8 Admin Console, go to **API Keys → Create App**, give it a name with no spaces, and tick the **Work Analytics** product.
2. Create or pick an 8x8 account for the hub to use, with Work Analytics access. **Sign in as that account and open Analytics in a browser once**, or the API will refuse it.
3. Find your PBX name at https://admin.8x8.com/company/pbx.
4. In the Worker's **Settings → Variables and secrets**, add as **Secrets**:
    - `EIGHT8_API_KEY`: the key from step 1
    - `EIGHT8_USERNAME` and `EIGHT8_PASSWORD`: the account from step 2
    - `EIGHT8_PBX_ID`: your PBX name, or `allpbxes`
    - `EIGHT8_BASE_URL`: only if you are on the EU region, set it to `https://api.8x8.com/eu/analytics/work`
5. On the Admin page, select **Test the 8x8 connection**. It reports how many calls are on the system today.
6. Still on the Admin page, fill in each engineer's **extension** in the engineers table. Calls are matched to people by extension, or by the name on the call if the extension is blank.

## Part 16: XP shop (demonstration)

The shop is visible to admins only, so you can show it to people while the rewards are being agreed. It has your reward list, works out who qualifies, and shows what a reward would cost: how many levels, how much XP, what level and title you would drop to, and how long it would take to earn back at 60 and at 400 XP an hour.

Nothing is spent. There is no route in the hub that reduces anyone's XP or level, so it can be demonstrated safely.

Pricing works two ways on purpose. **Cash and career rewards cost a set number of levels**, so they get dearer the further up someone is: £100 costs 120 levels, which is about 58,000 XP at level 300 and about 203,000 at level 900. **Time off costs a fixed amount of XP**, set at the level it unlocks, so it stays reachable however senior someone gets: an extra holiday day is always about 68,000 XP, which is 150 levels at level 300 but only 38 levels at level 900.

When you're ready to make it real, the parts still to add are a way to request a reward, an approval step for team leads, and the ledger entry that takes the levels off.

## Part 17: Obsolescence surveys

The obsolescence app now lives in the hub. The Google Sheet, the Apps Script and the Zapier step are no longer involved.

- **The equipment library** ships with the hub, seeded from your master sheet: 25 VDUs, 11 control PCs, 6 amplifiers, 75 PLC cards, 50 software entries and 115 critical spares. It grows on its own: anything an engineer types during a survey is added, so suggestions improve with use.
- **The client list** is read straight from Jira, from the Obsolescence Reports issues, with the contract number and service level pulled from the matching Service Contract issue exactly as the old script did.
- **The survey** is filled in section by section: site details, control servers, VDUs, amplifiers, load cells, PLC panels, software, critical spares, then notes. Each item gets a condition, and part numbers suggest from the library as you type.
- **The report is a PDF**, in the same style as the risk assessment, with a summary of what was found by condition. It is attached to the Jira item, filed in the shared drive under a folder for that client, and the report link field on the issue is updated.
- **The job moves on**: the Obsolescence Reports item goes to **New Survey Added**.

### The sales review

Anyone whose team is set to **Sales** on the Admin page is asked first whether they want to **survey a site** or **review surveys**, so nobody is locked out of either job. Reviewing shows every report sitting at New Survey Added, with a button to read the PDF, and there's a switch on each screen to move between the two. **Finished reading** then offers **Quote required** or **No quote needed**.

Quote required creates a **Quote** in the customer's project, under their Active Quote List, summarised as "Obsolescence quote for [survey date] Survey", assigned to the salesperson, and linked so the quote is caused by the report. Either choice moves the report to **Report Up To Date**.

### Setting it up

Add one more **Secret** in the Worker's **Settings → Variables and secrets**:

- `OBS_DRIVE_FOLDER_ID`: `1s6Vq0rwZoSjHlkQ1OpIVCHNpPButKkWN`

The same service account used for risk assessments does the uploading, so share that folder with it as well, as **Content manager**.

Two things to check in Jira: that **New Survey Added** and **Report Up To Date** are both reachable from wherever your reports usually sit, and that a link type named **Causes** exists. If it doesn't, the hub links the quote as "relates to" instead and says so.

## Part 18: Retiring the old obsolescence app

28. The tile now opens the hub's own obsolescence app, so nothing needs copying in.
29. Keep the old GitHub Pages copy and its Apps Script running until a few surveys have gone through the hub, then retire them. The `public/apps/obsolescence/` folder can be deleted once you do.

## Part 19: The ELO engine

Each finished category is a match between the job and the people who logged time on it. Doing it in less time than the estimate raises their ELO, running over lowers it, and how much depends on how hard the job was rated against their own ELO and on their share of the hours. Whatever people gain, the job's own learned ELO loses, so ratings stay comparable with job difficulty instead of creeping upwards.

- **What gets rated:** categories recorded under Completed job tracking, three days after they finish so late time logs still count. Categories with no estimate, no time or no difficulty are listed as not rated, with the reason.
- **Job ELO** is 750 + 250 × the weighted score from the order's difficulty scores, unless the category already has one.
- **XP rates** use each person's ELO as it stood on Monday morning, so a rating that moves mid-week never changes what the rest of that week earns.
- **Rank** shows the best reached in the last three months, so one difficult job never costs anyone their rank.
- **History:** everyone sees their own on the XP & rank page, and leads see anyone's from Reports. Admins can undo a rating, which puts back both the person's points and the job's.

### Starting it

1. Under **Admin, ELO engine**, choose the date to rate finished jobs from and select **Start the ELO engine**. Today rates only work finished from now on; an earlier date replays jobs already recorded, oldest first.

## Part 20: Jobs, disputes and modifiers

**Jobs tile.** Every open order in the customer projects, with each category's job ELO and its time logged against the estimate. Mine shows categories you've logged time on in the last six months; My team and All show the rest.

- **Who's on it.** Each category (and each item on an older order) shows its Assignee as a picture (or initials, or ? when nobody is assigned) and everyone in Promtek Staff Involved on that category as smaller ones beside it, up to five then "+N". The Assignee isn't repeated among them. Hover over them, or tap on a phone, for the list of names. Each sub-task shows its own assignee's picture before its key. Searching finds orders by these names too.
- **Icons and status.** Each order has the purple Epic icon before its key, and each category its discipline's icon (Software, Hardware, Site visit, Condor, from `public/icons/`). Each category shows its Jira status and how many of its sub-tasks are done.
- **Sub-tasks.** Under each category its sub-tasks always show; on older orders they start folded away. Each has a rough guide to its time: the category's estimate shared out by the agreed weightings for its kind of sub-task (the same ones quoting uses, a weight of 1 for any kind not listed; on older orders, equal shares of the item's estimate). It's only a guide while there's little data: only the category as a whole going over its estimate counts towards ELO or estimate alerts. Time logged to sub-tasks counts in their category's total (Jira's Σ Time Spent). Each shows that estimate, its time logged, its status and **Log time**, which opens the Log time form for it. Tap a status to move it to any status Jira allows from there; the move is made in Jira as the hub's Jira account and recorded in the audit log under Jobs. Only sub-tasks in customer projects can be moved.
- **Filters.** Customer, Team (when there's more than one), Category (Software, Hardware, Site visit, Condor, or older orders' items), Assignee and Status, as well as the search. Category and Status show only the categories that match. Assignee finds orders where someone is the assignee of the order, a category, an item or a sub-task. Status shows only the categories and items in that status.
- **Older orders.** Orders from before categories show on My team and All with their open items and who each is assigned to; Mine shows only the ones assigned to you.
- **Difficulty set later.** A category quoted without a difficulty shows **Work out difficulty** instead of Dispute. Score the four areas, with an optional estimate. A team lead, Management or an admin sets it straight away; anyone else's goes to the team lead like a dispute. It is kept alongside the quote as an agreed dispute is (reason "Difficulty set after the order was made"), XP already earned on it is recalculated, and the ELO is written to the category in Jira.

**New order emails.** As well as the home screen alert, each new order emails the leads of its team once: Service orders to Service leads, Projects orders to Projecting leads. An order whose division still isn't set a day after it was created goes to both. It runs hourly, and the first run only records where things stand, so nobody is emailed about orders already there.

**Disputes.** Anyone can dispute a category's difficulty: their own scores for the four areas, an optional better estimate, what changed, and a comment. It goes to the team leads for the order's Promtek Team (Service or Projecting; any lead if it has none), who agree, adjust or decline it in Jobs. Nobody decides their own.

Once agreed:
- the agreed ELO and estimate are used for XP and by the ELO engine, and the XP already earned on that category and its stages is recalculated;
- the quoted scores, ELO and estimate are kept alongside, for quoting;
- the agreed ELO is written to the category in Jira with a comment. If Jira can't be reached, the hub carries on with the agreed values, tells the lead, and retries every hour.

**Estimate alerts.** Every hour, open Service and Projecting categories are checked against their estimate. Team leads are emailed once at 90% and once when it passes. The first run only records where things stand, so nobody is sent alerts for jobs already over. An agreed dispute starts the alerts again against the new estimate.

**Modifiers.** From XP & rank, anyone can ask for something to be taken into account: Supporting apprentices, Training someone, Covering for absence, Learning on the job, Heavy workload, Unwell or Personal circumstances. No details are recorded. Their supervisor (the manager on the company chart) is emailed, without saying what it is, and agrees or declines it in Jobs. Only the person, their supervisor and admins can see it. While it applies, time logged counts for less towards ELO in both directions.

Alert emails go to each lead or supervisor's own email address through the mail relay, falling back to `ALERT_EMAIL` when there's nobody to send them to.

## Part 21: Quotes

**Prospects.** New potential customers, with no project in Jira yet, are kept in the **Prospects** tab rather than as quotes. Each one records:
- **The company:** name, industry or sector, website, size, sites, the country (for people who see both), and what their business does.
- **What they'd like from Promtek:** what they're interested in, what it could involve (Software, Hardware, Site visit, Condor), timescale, budget, and who they use now.
- **Primary contact:** name, job title, email and phone.
- **Addresses:** site address, and billing address if different.
- **Where they came from, and what's next:** how they found us and the details, the next step and when by, the status (New, In conversation or Not going ahead), and notes.

New ones come from **Add a prospect**, or from a PSC sent there. The list shows open ones by default, with next steps past their date in red.

**Ready for a quote?** at the bottom of a prospect starts their quote in the Quote builder, as a new customer's quote, with a title, categories and team, and what's known about them as its description. From then it follows the usual process: it stays in the hub, can be marked **Accepted**, and goes into their Quote List in Jira once they have a project (chosen on the quote, or found every hour by name). Until then it has no Jira key to use as the quote number in Quoter.

**When they become a customer.** Once their quote is in their new project, their site and billing addresses and primary contact (with job title) go into the Customers tile, with the contact as primary unless one has already been chosen there, and an **About them** section on their page shows what the sales team knew. The prospect is marked **Now a customer** and can no longer be changed.

New customers are no longer started from the Quote builder's customer list; it points to Prospects instead. Quotes for new potential customers made before Prospects existed became prospects automatically: open ones wait there, with their estimates kept for when a quote is started again; accepted ones carry on as quotes, with their prospect alongside.

**Setting it up:** run `schema-076.sql` in the D1 console.

**Who uses it.** The sales team and team leads start and edit quotes. Anyone asked for an estimate can open that quote and give theirs; nobody else sees it.

**Starting a quote** creates a Quote issue in the customer's Jira project, under their Quote List, assigned to whoever started it. Its description is what the person starting the quote writes about the job, and it can be edited on the quote at any time; Jira is updated on each save. When the quote is ready to send, the hub's estimates are added under the description in Jira, and taken off again if it goes back to being worked on. Engineers asked for an estimate see the description as "About the job". Its key is the quote number in Quoter. If Jira can't be reached, the quote is kept in the hub and created in Jira on the next hourly run, or with Try again.

**Each category** (Software, Hardware, Site visit, Condor) records:
- counts and conditions for that kind of work, and for site visits the kind of visit;
- whether it has been done before and how clear the spec is;
- best, likely and worst hours;
- technical complexity, uncertainty and risk, and dependencies, each 1 to 5;
- the hours to quote.

Alongside, the hub suggests hours from the three-point estimate, adjusted by how the most similar finished jobs ran against their estimates. It shows how the estimator's likely hours have compared with what happened, and job ELO from the three difficulty scores. Similar finished jobs are listed with their estimated and actual hours, and can be marked easier, the same or harder.

**The learned estimate** starts for each kind of work once 15 quoted jobs of that kind have finished. It learns how the counts, conditions, novelty and spec relate to actual hours and to the job's learned difficulty, and shows its figures beside the others.

**Asking an engineer** emails them and puts the request at the top of Quotes for them. Their answer is posted as a comment on the Jira quote. If the category is still empty it fills it in; otherwise sales can choose to use it.

**When the quote becomes an order.** Every hour, the hub looks for orders whose Quote Number matches a quote. It then writes each category's job ELO and its hours (Original Estimate) to Jira, and the difficulty scores onto the order. Categories can arrive a little after the order, so it waits up to a week for them before saying any are missing. If Jira refuses, nothing is marked done, an alert is raised, and it tries again the next hour. Once linked, the quote is marked as won and can no longer change.

**Were the counts right?** When a quoted category finishes, its team lead gets a card in Jobs with the quoted counts to confirm or correct. Corrected counts are what the learned estimate and the similar-jobs list use.

**Settings.** Admins edit the counts, conditions and kinds of visit under the cog. Keep a count's short name the same once quotes use it, or its history stops matching.

**Estimates.** A category's estimate is its own Original Estimate plus its subtasks' Original Estimates, since older jobs were quoted by subtask. Where the subtasks add up to the category's own figure (within 5%), they're a split of it and the hours are counted once. Base sprints only fill in where there's no Original Estimate at all, and story points are no longer used. The same figure is used by the Jobs tile, estimate alerts, Quoting, disputes and the ELO engine. Quoting groups jobs by the size of their estimate.

**Sharing hours across subtasks.** When a quote becomes an order, the hub shares each category's hours across its subtasks' Original Estimates. It uses these weights by subtask type, with anything unlisted counting as 1:

| Category | Weights |
|---|---|
| Hardware | New Design 2, New Purchase Order 1, New Build 2, New Configuration & Testing 2, New Dispatch 1 |
| Software | New Software Development 3, New Download Phase 1 |
| Site visit | New Order Site Visit 1 |
| Condor | New Condor Development 3, New Download Phase 1 |

How the sharing works:
- **Whole minutes:** hours are shared in whole minutes, so the subtasks always add up to the category exactly.
- **Data first:** once every subtask type in a category has at least 10 finished jobs of that kind behind it, the share of time those types really took is used instead of the weights.
- **Late subtasks:** subtasks can arrive after the order. The hub waits a week for the first ones, then checks daily for a fortnight and re-shares if more appear.
- **Hand edits:** a category where someone has changed the hub's figures by hand is left alone.
- **Pace:** the work is done a few categories at a time in the background.

Jira's own splitting automation should be off for orders created from hub quotes.

## Part 22: Condor Dev

**PSC tab.** Service items the service team sent over with the Condor button in PSC: each one's Bug in MES, the customer, the PSC it came from, who sent it and the Bug's status. Open lists the ones not yet done, with Estimate to estimate them.

The Condor Dev tile is shown to the Condor team and to admins.

**Your day, from Bitbucket.** Every 15 minutes the hub reads Bitbucket with an API token. It checks only repositories with new work, and for everyone in Condor Dev records:
- commits on every branch;
- pull requests opened, updated, commented on, approved, sent back with changes requested, merged or declined;
- pipelines they run (needs the read:pipeline:bitbucket scope; skipped without it);
- tags they make.

Each piece goes to the Jira ticket named in its commit message, branch, or pull request title or description; any project's key counts. Activity with no ticket joins the ticket worked on either side of it in the same block of work, or, if the whole block has none, shows as a draft for the developer to choose a ticket for.

A developer is matched by their Atlassian account, then by the email or name in the commit. Bitbucket identities that match nobody on the hub are listed in the Condor Dev cog, where they can be linked to a developer or ignored; linking one reads the last week again.

Each day's activity becomes draft worklogs:
- activity close together is one block of work, starting half an hour before the first commit and ending a quarter of an hour after the last;
- a pause of over two hours starts a new block;
- half an hour comes off a block that runs through 12:30;
- time is split between tickets where the work switched;
- drafts are rounded to the quarter hour;
- time already logged on that ticket that day is taken off, so nothing is logged twice.

Developers check the times, change anything that's wrong, and log the day to Tempo in one tap. "Not work time" clears a draft. Anything Tempo refuses stays as a draft. Drafts go back a week. On weekdays they're emailed at 16:00 that their day is ready, and at 09:00 the next working day if it's still waiting.

**Setting it up.**
1. At id.atlassian.com (Security, Create API token with scopes), create a token with Bitbucket as the app and these scopes: read:repository:bitbucket, read:pullrequest:bitbucket, read:workspace:bitbucket, read:pipeline:bitbucket and read:user:bitbucket. Note its expiry date. App passwords stopped working on 9 June 2026, and a Jira API token without Bitbucket scopes is refused.
2. Add it to the Worker as the secret `BITBUCKET_API_TOKEN`.
3. Add `"BITBUCKET_WORKSPACE": "<workspace slug>"` to the vars in `wrangler.jsonc`. The slug is the part after `bitbucket.org/` in a repository's address.
4. The token is used with `JIRA_EMAIL`. If it belongs to a different account, add that account's email as `BITBUCKET_EMAIL`.

The Condor Dev cog shows the last check and any problem, and has Test connection (which tries each scope in turn and says which is missing), Check now, and Read the last week again. When the token is refused, the cog and Admin's "Last sync problem" say so; the next check after it's replaced catches up on up to eight days.

### Estimating MES tickets

The hub keeps its own copy of MES: two years back on the first run, then kept current every couple of minutes.

A ticket is estimated by comparing it with finished tickets that have logged time:
- Comparison tickets are of the same type and Condor Module where there are at least five. Otherwise the pool widens to the same module, then the same type, then all of MES.
- Each question is about the middle of what's left: smaller, about the same, or bigger. Each answer narrows the range, and the estimate is the middle of it.
- Every question shows the estimate so far, its range and its precision: how much of the comparable tickets' range the answers have ruled out, labelled tight, fairly sure, rough or very rough.
- Questions carry on until there's nothing left between the answers, the range is within about ±15%, or eight have been asked. From the third answer, "Accept this estimate" takes the estimate so far.
- "About the same" stops at that ticket's time.
- With nothing to compare against yet, best, likely and worst hours are asked instead.
- A bug whose cause isn't known can be time-boxed for investigation and re-estimated once the cause is found.

Each estimate also records how hard the ticket is to do well (1 to 5), which sets its ticket ELO at 750 + 250 × difficulty, plus optional tags. Saving an estimate:
- sets Original Estimate in Jira;
- recalculates XP already logged on the ticket;
- keeps every earlier estimate, so re-estimates can be learned from.

Anyone in the Condor team can estimate.

### Triage

At the start of each release, Condor leads, management or admins pick the release from MES's open versions, or start a new one: a name, start date and release date, made in Jira as a version. They then go through every incomplete MES ticket, one at a time: Must, Should or Could puts it in the release and sets its Fix Version; Not this time leaves it for the next release's triage.

**Sprints.** Each release has its own board, which the team works from:
- **The board:** a board whose name contains the release's name, such as Gobi Release, is used as it is, with its sprints. Otherwise the hub creates "[Release] Release". Its Backlog shows the release's tickets and all MES work not yet in a release.
- **The sprints:** a board with no sprints gets three, splitting the release's dates into thirds, each ending on a Friday with the next starting the Monday after.
- **Placing tickets:** "Make the sprints", or later "Place the tickets in the sprints", puts each planned ticket in the sprint its plan starts in. Tickets already in a sprint that has started or finished are never moved.

Creating boards needs permission in Jira to create filters and boards in MES.

### The Condor development rating

Each developer has a Condor rating, separate from their customer ELO. Each finished MES ticket with an estimate is rated three days after it closes, the same way as customer categories. Time-boxed tickets aren't rated. Time on MES earns XP at the ticket's ELO against the developer's Condor rating. Developers see their own rating; Condor leads and admins see the team's.

If Jira can't take an estimate or a triage decision, it's kept in the hub, retried every hour, and an alert says how many are waiting.

### Release planning

The Plan tab lays each open release's triaged tickets onto the Condor team's working days.

**Capacity.** Each person has their hours a week on Condor, the weekdays they work on it, and periods away (leave, university blocks, customer work). It defaults to 37.5 hours, Monday to Friday. Anyone can be left out of planning. A share of everyone's time is kept free for emergencies, 20% unless changed. Kieran, Simon and admins edit all of this on the Plan tab. Bank holidays aren't known to the hub, so add them as days away.

**The plan.**
1. Musts first, then Shoulds, then Coulds. Within each, work in progress comes first, then assigned work, then the oldest.
2. Assigned tickets go to their assignee; unassigned ones to whoever would finish soonest.
3. A ticket's hours are its estimate less the time already logged. A ticket already past its estimate keeps a fifth of it, at least an hour, and is marked for re-estimating.
4. Tickets without an estimate are listed for estimating rather than planned.
5. A release with no date in Jira is planned to 90 days ahead.

**Suggestions.** When Musts or Shoulds don't fit, lower-priority work is offered for the next release. A move is only suggested if it lets more important work finish sooner. A Should never makes way for another Should, and work in progress is never moved. Coulds that can't fit are offered too. "Move it" changes the Fix Version in Jira; "Keep it in" stops the suggestion for that release.

**Accepting the plan** writes each planned ticket's start and due dates to Jira, puts it in the sprint it starts in, and sets the planned person where nobody is assigned. The timeline marks where each sprint starts, and taking a day off someone's capacity takes 7.5 hours off their week (adding one adds 7.5). The start date goes in the field named "Start date", looked up by name; if there isn't one, only due dates are written. Writes beyond the first 30 carry on in the background. Developers see their own planned tickets.

### Keeping inside Cloudflare's limits

The free Workers plan allows 50 outside calls (to Jira, Tempo, Bitbucket or the mail relay) in each run. Every 2 minutes the hub runs the weekly snapshot, the ELO freeze and the Tempo sync, then the next of these jobs in turn:
- orders
- finished categories
- ELO ratings
- Bitbucket
- MES
- MES changes to Jira
- the three hourly jobs
- alert emails

A job with nothing to do passes its turn on. Long pieces of work, such as reading Bitbucket or two years of MES, carry on across runs, a capped amount at a time.

## Part 23: Audit log and company chart versions

### Audit log

Admin has an audit log of changes made by hand. It records who made each change, when, and each field before and after. It covers:
- employees added, changed, deactivated or removed, and Jira account IDs changed;
- vehicles added or changed;
- Condor capacity and the reserve;
- settings: IT request types, quote counts and conditions, the ELO engine started or paused, ratings undone, the XP ledger started, and where employees are kept;
- each company chart version issued.

Managers are shown by name, Condor days as weekdays, and a new photo as "a photo" without storing the image. Bookings, walkaround checks, defects and time logging aren't included; they're everyday use with records of their own.

The log can be filtered and searched, loads 50 entries at a time, and downloads as CSV. It's kept indefinitely. It lives in the hub's own database, so it uses none of Cloudflare's outside-call allowance.

### Company chart versions (IMS2.02)

The company chart is a controlled document. The chart and its page show the current reference, IMS2.02-N. Version 8 was the chart when versioning began.

**Major and minor changes.** Changes collect until an admin issues the next version.
- Major changes are people joining or leaving, reporting lines, job titles, departments and names.
- Minor changes, such as photos, pronouns, extensions, chart order and icons, show on the chart straight away and go out with the next version.
- Hub roles, teams and XP rates aren't on the chart, so they aren't counted.

**Issuing.** Under the chart's cog, an admin reviews "N major changes, N minor changes", unticks anything that shouldn't count, and issues the next version. The admin who issues it is the approver. The hub then updates the Confluence page:
- **Document control table:** found by its Version and Last Reviewed headings. Version becomes "Issue N" and Last Reviewed the issue date; every other cell is left alone.
- **The hub's block,** under the table: the chart image, a link to the house-style PDF (both uploaded as attachments, which Confluence versions), what changed, the version history, and a note of who approved it and when.
- **Anything else on the page** is kept.

**If something goes wrong:**
- If the table can't be found, the chart is still published and admins are emailed what to set by hand.
- If Confluence can't be reached, the version is still issued in the hub, admins are emailed, and the newest version is retried every hour.
- Major changes left waiting more than three days get a weekly reminder.

The hub publishes with the same Atlassian login it uses for Jira. That account needs permission to edit the IMS2.02 page in the PIMS space and to add attachments to it.

## Adding more apps later

Each app lives in its own folder under `public/apps/`, and gets one entry in `public/modules.js` with a name, description, link and icon. Set `comingSoon: true` to show a placeholder tile, or `adminOnly: true` to show it only to admins. Apps that need to save data get their own API routes in `src/index.js` and tables in the same database.

## Troubleshooting

**"Couldn't load the hub" or "Sign in with your Promtek Google account to continue."**
The Worker couldn't verify the sign-in. Check that `ACCESS_TEAM_DOMAIN` (including `https://`) and `ACCESS_AUD` in `wrangler.jsonc` exactly match the values in Zero Trust, then commit again.

**Google says the app is blocked or the redirect URI doesn't match.**
Recheck step 7. The redirect URI must be exactly `https://YOUR-TEAM-NAME.cloudflareaccess.com/cdn-cgi/access/callback`.

**The Sync panel shows a Jira 401 or Tempo 401 error.**
A token secret is missing or wrong. Re-add it under the Worker's **Settings → Variables and secrets**.

**Someone's XP didn't appear.**
New worklogs appear within about 2 minutes, or straight away when the person opens the hub. Check the time was logged on or after the ledger start date, and that they have a profile.

**The Install option never appears.**
Browsers fetch the app's manifest and icons separately. On some setups, Cloudflare Access asks those requests to sign in, which blocks installing. Let those few files through without a login:
1. Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Add these public hostname paths, all on your hub's hostname (`promtek-hub.YOUR-SUBDOMAIN.workers.dev`): `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and `apple-touch-icon.png`.
3. Add one policy with action **Bypass** and include **Everyone**, then save.

They contain only the logo and app name, so nothing private is exposed. Path-specific applications take priority over the Worker's Access rule.

**Checking logs.**
Open the Worker's **Logs** (Observability) tab. Every error from the API and the background job is recorded there.

## Testing on your own computer (optional)

This is only needed if you want to change code and try it before committing.

1. Install Node.js from https://nodejs.org.
2. In this folder, run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and fill in the tokens.
4. Run `npx wrangler d1 execute promtek-hub --local --file=schema.sql` once to create the local database.
5. Run `npm run dev` and open the address it prints. `DEV_EMAIL` stands in for the Google sign-in locally, and only works on your computer.

**Dates.** Every date in the hub shows its year (for example 19 Nov 2026), so something from last month can't be mistaken for something from years ago. Days of the week on the weekly charts and birthdays are the exceptions.
