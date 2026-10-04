# Updating Promtek Hub: groups and permissions

Each person's single role and team become **groups** and **teams**, and a person can have several of each:
- **Groups:** Admin, Management, Team lead, Sales and Developer.
- **Teams:** Projecting, Service, Condor, Sales and Marketing.
- **Leads:** a Team lead also chooses which of their teams they lead.

The XP shop shows as "Under construction" to anyone without access.

Allow about fifteen minutes. **`wrangler.jsonc` is deliberately not in this package**, and nothing in it needs changing.

---

## 1. Upload the files

Only these have changed since your last upload. Keep the folders as they are, then commit:

- `src/`: `permissions.js` (new), `index.js`, `people.js`, `audit.js`, `disputes.js`, `quotes.js`, `modifiers.js`, `elo.js`, `mes.js`, `mes-plan.js`
- `public/`: `app.js`, `modules.js`, `styles.css`
- Root: `schema-022.sql` (new), `README.md`, `SETUP.md`

Check the Worker's **Deployments** tab shows a new deployment.

## 2. Update the database

In **D1 → promtek-hub → Console**, run `schema-022.sql`. It moves everyone across:

- admins become **Admin**;
- team leads become **Team lead** of their current team;
- everyone keeps their team;
- anyone in the Sales team gets the **Sales** group, so they can still start quotes.

## 3. Set people's groups

Under **Admin → Employees**, open each person who needs more than an ordinary engineer. For example:

- **Simon:** Management.
- **Kieran:** Team lead, in Condor and Projecting, leading Condor.
- **Craig:** teams Condor and Marketing.
- **Anyone looking after the hub with you:** Developer.

**Admin → Groups and what they can do** shows exactly what each group allows.

## 4. Check it works

1. Ask an engineer to open the hub on **their own device**. The XP shop shows as "Under construction", and Reports and Admin aren't there.
2. Ask a team lead to open **Reports**. It opens on the team they lead.
3. Open **Admin → Audit log**. The changes you made in step 3 are listed.

## If something goes wrong

- **"no such column: groups":** step 2 hasn't been run.
- **Someone can't do something they should:** check their groups and teams under Admin → Employees, and compare with the grid. You can always get in through the `ADMIN_EMAILS` fallback.
