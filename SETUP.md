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

**XP rate** is the base XP per hour. Engineers are on 60, and their rate rises and falls with the difficulty of the job against their own ELO. Admin staff are on 75, since they get no ELO adjustment.

**Pictures** are added on the same page and appear on the company chart. They are squared off and shrunk in the browser before saving, so a phone photo is fine.

**Badges** mark the people to go to in an emergency: first aider, mental health first aider, fire marshal, evacuation warden, defibrillator trained, and health and safety trained. They show as white discs on the nameplate.

**Adding someone** before their Atlassian account exists is fine: leave the Jira account ID blank and they are marked as pending. Filling it in later moves their history across with them.

**Removing someone** offers two things: hide them and keep their XP history, or remove them and it entirely.

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

**Downloads.** Everything the hub saves (the chart image, the WIP workbook, CSVs, certificates, release notes) says "Downloading" and then "Downloaded" with the file's name, which matters in the installed app, where there's no download bar. Files from the server are fetched first, so "Downloaded" only shows once the file has arrived. In the installed app on an iPhone or iPad, the share sheet opens instead, for Save to Files.

Someone new with no manager and no level appears on the Directors row, which makes them easy to spot until they're set up.

### Roles

Access is set with **groups** (roles) and **teams**. A person can be in any number of each. What each role and team can open starts from the defaults below, and admins can change it under **Admin → Who can use what** (see below).

- **Everyone:** their own XP, time and profile, the leaderboard, and the tiles for their teams.
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

The hub then sends any waiting alerts once an hour.

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

- **The fleet** is managed on the Admin page: registration, make, model, MOT, insurance, tax and service dates, mileage, and who looks after repairs.
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

**Log time** is the button at the bottom of the home screen: centred on a phone, bottom-right on a larger screen. While a timer runs, it shows the job and the running clock. After picking a job, the engineer chooses **Add time already done** (the usual form) or **Start the timer**. Logging an 8x8 call's time goes straight to the form. The timer is kept in the hub, so it carries on across tabs and devices, and a bar at the foot of every other page shows it running.

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
- Each contract's Available, Tokens used and Overdraft fields are kept up to date. Tokens in Token Allocated count as used in Jira; in the hub they're shown separately.
- Time logged to a PSC item with no Organization emails the person who logged it and the contract alert list, at most once a day per item. The alert for it shows in the PSC tile, where the Organization can be set or the alert marked resolved, not here.

**Bank holidays.** The Contracts tab says whether today is a bank holiday in England, and which is next. The dates come from gov.uk's England and Wales list, checked weekly, so one-off holidays are included; the regular ones are worked out if gov.uk can't be reached.

**Insights** show renewals, token use against each contract's progress, visits falling behind, time that can't reach a contract (last 90 days), and where service time went by customer and engineer (last 30 days). Each total opens to the time logs behind it.

**Alerts** go to the Service team leads, plus anyone added under the settings cog. Anything Jira refuses is retried, and after three tries appears in Needs attention and is emailed.

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

**First look.** Each item is due a first look a set time (by tier, under the cog) after the customer's cover starts: straight away if it was raised in cover, otherwise when their cover next begins. From then it counts around the clock. The first look is the first of: a comment, status change or assignment by a Promtek person in Jira; time logged to it; or **I'm on it** in the hub. Jira's automatic replies don't count. Items raised by the team themselves count as looked at from the start, and are left out of the response figures.

**After that.** Each item shows the team's last update (who and what), and flags when the customer has replied since the team last did anything, or when it has gone quiet for longer than the setting.

**Triage** lists items with no first look, no owner, or (on the PSC board) no Organization. **I'm on it**, **Assign to…** and the Organization list save to Jira; if Jira is busy, the change waits in the hub, is retried, and admins are emailed if it keeps failing. The Organization list comes from the service desk, so the hub's Jira account needs agent access to it.

**PSC with no Organization.** PSC board items with time logged but no Organization are listed at the top of the Triage and Open tabs, with the Organization list to set it in Jira, **New Customer**, which opens the item ready to turn into a quote for a New Potential Customer (see below), and **Mark resolved**. Turning an item into a quote, or sending it to Condor Dev, resolves its alert.

**Not support work: Quote and Condor.** Each open item has two buttons, on its card in the Triage and Open lists (next to I'm on it) and on the item itself; from a card they open the item with the quote or Condor step ready. Run `schema-053.sql` in the D1 console before using them.
- **Quote** turns it into a quote, with its categories and Promtek team chosen first. In a customer's project, the item's issue type is changed to Quote and it's moved under that project's Quote List; where Jira won't change the type (a different workflow, say), a new Quote is made there instead and linked to it. Either way the quote joins the Quotes tile, with the PSC's description, for the sales team.
- On the PSC board (no Organization), the customer is chosen first, and **New Potential Customer** at the top of the list takes a name instead. A new potential customer's quote is kept in the Quotes tile, where it can be worked on and marked **Accepted**. Once they have a project in Jira, the quote is made in its Quote List: chosen on the quote, or found by the hub every hour when exactly one customer project has their name. The PSC board item gets an internal comment saying what happened.
- **Condor** copies it to the MES project as a Bug, with its summary and description, linked to the PSC with the Sync To / Sync From link type (the PSC Syncs To the Bug). It then shows in Condor Dev's **PSC** tab, with the Bug's status, until the Bug is done.
- Once either has gone through, the item, and its PSC board original, leave the PSC tile. If Jira refuses, the hub keeps it, tries again every few minutes, and emails admins after three tries.

**Order.** Late items first, then new items due within the hour, then customers waiting on us, then other new items by when they're due; within each, Platinum, Gold, Silver, then no contract.

**Emails.** The Service team lead hears when an item passes its first-look deadline. The owner (or the lead, if no one has it) hears when a customer has been waiting longer than that.

**Settings** (cog, admin only): the first-look target for each tier (Platinum 1 hour, Gold 2, Silver 4, no contract 8 to start with), the day shift (08:00 to 17:00), and how many days without an update before an item is quiet.

## Part 14f: Which Jira projects the hub uses

The hub only lists and searches customer projects, the ones in the **Promtek UK Customers** and **Promtek SA Customers** categories, plus its own working projects: MES (Condor Dev), PSC (service items), PMB (general tasks and assisting), PROMTEKIT and ASSET (IT support) and the ten IMS projects (internal time). Any other project, such as CSIMS, CSIMSB, CSIMST, ARCHIVE, TEST or TPB, is left out without needing to be listed, so a new testing project stays out as long as it isn't put in a customer category. CSIMS, CSIMSB, CSIMST, ARCHIVE, TEST and TPB are also blocked outright, in case one is ever put in a customer category by mistake. Both lists are at the top of `src/jira.js`.

Looking up a particular item by its key still works, so TEST is a safe place to try things out. The list of customer projects is read from Jira every six hours.

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

**Disputes.** Anyone can dispute a category's difficulty: their own scores for the four areas, an optional better estimate, what changed, and a comment. It goes to the team leads for the order's Promtek Team (Service or Projecting; any lead if it has none), who agree, adjust or decline it in Jobs. Nobody decides their own.

Once agreed:
- the agreed ELO and estimate are used for XP and by the ELO engine, and the XP already earned on that category and its stages is recalculated;
- the quoted scores, ELO and estimate are kept alongside, for quoting;
- the agreed ELO is written to the category in Jira with a comment. If Jira can't be reached, the hub carries on with the agreed values, tells the lead, and retries every hour.

**Estimate alerts.** Every hour, open Service and Projecting categories are checked against their estimate. Team leads are emailed once at 90% and once when it passes. The first run only records where things stand, so nobody is sent alerts for jobs already over. An agreed dispute starts the alerts again against the new estimate.

**Modifiers.** From XP & rank, anyone can ask for something to be taken into account: Supporting apprentices, Training someone, Covering for absence, Learning on the job, Heavy workload, Unwell or Personal circumstances. No details are recorded. Their supervisor (the manager on the company chart) is emailed, without saying what it is, and agrees or declines it in Jobs. Only the person, their supervisor and admins can see it. While it applies, time logged counts for less towards ELO in both directions.

Alert emails go to each lead or supervisor's own email address through the mail relay, falling back to `ALERT_EMAIL` when there's nobody to send them to.

## Part 21: Quotes

**New Potential Customer.** At the top of the customer list when starting a quote, for a company with no project in Jira yet. Their quote stays in the hub, can be marked **Accepted**, and goes into their Quote List in Jira once they have a project: chosen on the quote, or found every hour by name. Until then it has no Jira key to use as the quote number in Quoter.

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
