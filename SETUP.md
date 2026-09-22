# Promtek Hub: setup guide

This guide takes you from nothing to a working hub at a web address your team can open, signed in with their Promtek Google accounts. Nothing here costs money.

Allow about an hour and a half the first time. Do the steps in order: some later steps need values from earlier ones.

What you'll end up with:

- A web app that runs on Cloudflare. Engineers sign in with Google and see their level, title, ELO rank and a breakdown of which time logs earned which XP.
- A database (Cloudflare D1) holding an XP ledger with one row per Tempo worklog.
- A background job every 2 minutes that picks up new and edited Tempo worklogs and removes XP for deleted ones. On the hour it also refreshes ELO and baseline values from the DNM Employee issues.
- Shadow mode. Your existing Jira automations and Apps Scripts keep running untouched while you compare the hub's numbers against Jira. Nothing in Jira is changed by the hub.

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
15. Back in the D1 database page, open the **Console** tab. Paste the whole of `schema.sql` in and select **Execute**. Afterwards, the **Tables** tab should list `employees`, `jobs`, `xp_ledger`, `unmatched_worklogs` and `sync_state`.

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
    - For the authentication policy, choose **Email domain** and enter `promtek.com`.
    - Select **Apply Access**.
20. Go to **Zero Trust → Access → Applications** and open the application that was just created for `promtek-hub`.
    - Under **Login methods**, tick only **Google**, and turn on **Instant Auth** (sometimes worded "skip identity provider selection"). People then go straight to Google instead of seeing a choice screen.
    - Set the **session duration** to something like **1 month**, so engineers aren't asked to sign in every day.
    - Copy the **Application Audience (AUD) Tag**, shown on the application's overview or basic information page.
21. In GitHub, edit `wrangler.jsonc` again:
    - `ACCESS_TEAM_DOMAIN` → `https://YOUR-TEAM-NAME.cloudflareaccess.com`
    - `ACCESS_AUD` → the AUD tag you just copied
    - Check `ADMIN_EMAILS` has your email. To add another admin, separate emails with commas.

    Commit the change and wait a minute for the automatic deploy.

## Part 7: First sign-in and starting the ledger

22. Open `https://promtek-hub.YOUR-SUBDOMAIN.workers.dev`. You should be sent to Google, then land on the hub. It will say your account isn't linked yet; that's expected, because there are no engineers in the database yet.
23. Open **Admin → Refresh profiles from Jira**. This reads every Employee issue in DNM and lists the engineers.
    - Check the table looks right.
    - Any Employee issue without a UserID is listed as skipped. Fill in its UserID in Jira and refresh again.
24. Choose when to start the ledger. Starting it:
    - copies everyone's current Jira XP in as their starting balance;
    - makes the hub count XP from worklogs dated from that day onwards.

    Worklogs already logged earlier that same day would be counted twice (once in the Jira balance, once in the ledger). So do this in the evening, at a weekend, or first thing before anyone has logged time.
25. Type `START` and select **Start ledger**. Your own profile links automatically the next time you load the page, and the level and XP readout appears.

## Part 8: Invite the team

26. Send everyone the link. The first time each person signs in, the hub matches their Google email to their Atlassian account and links them.
    - If someone's account doesn't match (for example, they use a different email in Jira), link them by hand under **Admin → Link a Google account**.
27. Promtek Hub installs as an app on phones and computers, with its own icon and window:
    - **iPhone:** open the link in **Safari**, tap **Share**, then **Add to Home Screen**.
    - **Android:** open it in **Chrome** and tap **Install** when prompted. You can also use the **⋮** menu → **Install app**, or the account menu (tap your initials) → **Install the app**.
    - **Windows or Mac:** open it in **Chrome** or **Edge** and click the install icon at the right-hand end of the address bar, or use the account menu → **Install the app**. It then opens in its own window and can be pinned to the taskbar or dock.

## Part 9: Run in shadow mode

Leave your Jira automations and Apps Scripts running for a week or two. During that time, check **Admin → Engineers**:

- **Difference** compares the hub's XP with the XP field in Jira. Small differences are normal and mostly come from issues in the old system, such as the Recent XP Gain field not re-triggering when two logs earn the same XP, and reconciliation failing. Large or growing differences on one person are worth looking into.
- **Worklogs from people without a profile** lists time from people who have no Employee issue. If this shows the whole team, the Tempo worklog author isn't matching the UserID field; the same values that work in your current automation should work here.
- **Sync** shows the last background run and any error message.

When you're happy the numbers are right, the next phase moves ELO updates and job difficulty scoring into the hub, and then the old automations can be switched off.

## Part 10: Move the obsolescence app in

28. Copy the files from your obsolescence app's GitHub repository into `public/apps/obsolescence/` in this repository, replacing the placeholder `index.html`. Commit.
29. It now opens from the tile on the home page, behind the same Google sign-in.
    - If it links to its own files with paths starting with `/` (for example `/style.css`), change them to relative paths (`style.css`) so they resolve inside `/apps/obsolescence/`.
    - Keep the old GitHub Pages copy running until people have switched over.

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
