// Company vehicles: who has what when, the walkaround check before driving,
// defects, and keeping MOT, insurance, tax and service dates in view.
import { jira, searchJql } from './jira.js';
import { raiseAlert, londonDate } from './sync.js';
import { ON_SITE_STATUS } from './pow-data.js';

export const CHECK_ITEMS = [
  ['bodywork', 'Bodywork', 'Free of new or unreported damage'],
  ['leaks', 'Leaks', 'No fluid under the vehicle'],
  ['windows', 'Windows', 'Clean, undamaged, clear of ice and snow'],
  ['tyres', 'Tyres', 'Inflated, tread above 1.6mm'],
  ['wipers', 'Wiper blades', 'In good condition, not stuck to the screen'],
  ['lights-clean', 'Lights and plates', 'Reflectors, lights and number plates clean and undamaged'],
  ['wheels', 'Wheels', 'No significant dents, nuts present and tight'],
  ['seatbelts', 'Seatbelts', 'Lock when tugged sharply'],
  ['dashboard', 'Dashboard', 'No warning lights showing'],
  ['lights-work', 'Lights work', 'Lights and indicators all function'],
  ['washers', 'Washers and wipers', 'Both function correctly'],
  ['brakes', 'Brakes', 'Handbrake or parking brake holds'],
  ['kit', 'Tools and equipment', 'Everything for the day, including fuel card and breakdown cover'],
];

const EXPIRY_FIELDS = [['mot_due', 'MOT'], ['insurance_due', 'Insurance'], ['tax_due', 'Tax'], ['service_due', 'Service']];
const REMIND_AT = [30, 14, 7, 0];

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const daysUntil = (date) => (date ? Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${londonDate()}T12:00:00Z`)) / 86_400_000) : null);

export function checkSchema() {
  return { items: CHECK_ITEMS.map(([id, label, hint]) => ({ id, label, hint })) };
}

// ---------- The fleet ----------

export async function listVehicles(env, { includeInactive = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM vehicles${includeInactive ? '' : ' WHERE active = 1'} ORDER BY registration`
  ).all();
  const { results: defects } = await env.DB.prepare(
    "SELECT vehicle_id, COUNT(*) AS open_defects, SUM(severity = 'not-fit') AS serious FROM vehicle_defects WHERE status = 'open' GROUP BY vehicle_id"
  ).all();
  const defectsBy = new Map(defects.map((d) => [d.vehicle_id, d]));

  return {
    vehicles: results.map((v) => {
      const expiries = EXPIRY_FIELDS
        .map(([field, label]) => ({ label, date: v[field], days: daysUntil(v[field]) }))
        .filter((e) => e.date);
      const soonest = expiries.filter((e) => e.days !== null).sort((a, b) => a.days - b.days)[0] || null;
      const open = defectsBy.get(v.id);
      return {
        ...v,
        expiries,
        soonest,
        openDefects: open?.open_defects || 0,
        offRoad: v.status === 'off-road' || Boolean(open?.serious),
      };
    }),
  };
}

export async function saveVehicle(env, vehicle) {
  const now = new Date().toISOString();
  const id = vehicle.id || newId('veh');
  const registration = String(vehicle.registration || '').toUpperCase().trim();
  if (!registration) throw new Error('A registration is needed.');
  await env.DB.prepare(
    `INSERT INTO vehicles (id, registration, make, model, kind, mot_due, insurance_due, tax_due, service_due,
       mileage, status, responsible_email, notes, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET registration = excluded.registration, make = excluded.make, model = excluded.model,
       kind = excluded.kind, mot_due = excluded.mot_due, insurance_due = excluded.insurance_due,
       tax_due = excluded.tax_due, service_due = excluded.service_due, mileage = excluded.mileage,
       status = excluded.status, responsible_email = excluded.responsible_email, notes = excluded.notes,
       active = excluded.active, updated_at = excluded.updated_at`
  ).bind(id, registration, vehicle.make || null, vehicle.model || null, vehicle.kind || 'Van',
    vehicle.motDue || null, vehicle.insuranceDue || null, vehicle.taxDue || null, vehicle.serviceDue || null,
    Number(vehicle.mileage) || null, vehicle.status || 'available', vehicle.responsibleEmail || null,
    vehicle.notes || null, vehicle.active === false ? 0 : 1, now, now).run();
  return { id };
}

// ---------- Bookings ----------

export async function weekBookings(env, weekStart) {
  const from = `${weekStart}T00:00:00`;
  const to = `${londonDate(Date.parse(`${weekStart}T12:00:00Z`) + 7 * 86_400_000)}T00:00:00`;
  const { results } = await env.DB.prepare(
    `SELECT b.*, e.name AS engineer FROM vehicle_bookings b LEFT JOIN employees e ON e.account_id = b.account_id
      WHERE b.starts_at < ? AND b.ends_at > ? ORDER BY b.starts_at`
  ).bind(to, from).all();
  return { weekStart, bookings: results };
}

export async function book(env, viewer, { vehicleId, startsAt, endsAt, issueKey, issueId, purpose }) {
  if (!vehicleId || !startsAt || !endsAt) throw new Error('Pick a vehicle and a time.');
  if (endsAt <= startsAt) throw new Error('The end time has to be after the start.');

  const clash = await env.DB.prepare(
    'SELECT b.id, e.name AS engineer, b.starts_at, b.ends_at FROM vehicle_bookings b LEFT JOIN employees e ON e.account_id = b.account_id'
    + ' WHERE b.vehicle_id = ? AND b.starts_at < ? AND b.ends_at > ? LIMIT 1'
  ).bind(vehicleId, endsAt, startsAt).first();
  if (clash) throw new Error(`${clash.engineer || 'Someone'} already has it from ${clash.starts_at.replace('T', ' ')} to ${clash.ends_at.replace('T', ' ')}.`);

  const vehicle = await env.DB.prepare('SELECT registration, status FROM vehicles WHERE id = ?').bind(vehicleId).first();
  if (!vehicle) throw new Error('That vehicle has gone.');
  if (vehicle.status === 'off-road') throw new Error(`${vehicle.registration} is off the road until its defects are cleared.`);

  const id = newId('bk');
  await env.DB.prepare(
    'INSERT INTO vehicle_bookings (id, vehicle_id, account_id, starts_at, ends_at, issue_key, issue_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, vehicleId, viewer.accountId, startsAt, endsAt, issueKey || null, issueId || null, purpose || null, new Date().toISOString()).run();
  return { id };
}

export async function cancelBooking(env, viewer, id) {
  const booking = await env.DB.prepare('SELECT * FROM vehicle_bookings WHERE id = ?').bind(id).first();
  if (!booking) return { ok: true };
  if (booking.account_id !== viewer.accountId && !viewer.isLead) throw new Error("That booking is someone else's.");
  await env.DB.prepare('DELETE FROM vehicle_bookings WHERE id = ?').bind(id).run();
  return { ok: true };
}

export async function myBookings(env, viewer) {
  const { results } = await env.DB.prepare(
    `SELECT b.*, v.registration, v.make, v.model FROM vehicle_bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.account_id = ? AND b.ends_at >= ? ORDER BY b.starts_at LIMIT 10`
  ).bind(viewer.accountId, `${londonDate()}T00:00:00`).all();
  return { bookings: results };
}

// ---------- The walkaround check ----------

export async function submitCheck(env, viewer, { vehicleId, bookingId, issueKey, issueId, mileage, results = {}, fitToDrive = true }) {
  const vehicle = await env.DB.prepare('SELECT * FROM vehicles WHERE id = ?').bind(vehicleId).first();
  if (!vehicle) throw new Error('Pick a vehicle.');
  const missing = CHECK_ITEMS.filter(([id]) => !results[id]?.result);
  if (missing.length) throw new Error(`${missing.length} check${missing.length > 1 ? 's' : ''} still to answer.`);

  const id = newId('chk');
  const now = new Date().toISOString();
  const fails = CHECK_ITEMS.filter(([key]) => results[key]?.result === 'fail');

  const statements = [env.DB.prepare(
    'INSERT INTO vehicle_checks (id, vehicle_id, account_id, booking_id, issue_key, mileage, fit_to_drive, results, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, vehicleId, viewer.accountId, bookingId || null, issueKey || null, Number(mileage) || null,
    fitToDrive ? 1 : 0, JSON.stringify(results), now)];

  for (const [key, label] of fails) {
    statements.push(env.DB.prepare(
      'INSERT INTO vehicle_defects (id, vehicle_id, check_id, account_id, item, note, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(newId('def'), vehicleId, id, viewer.accountId, label, results[key]?.note || null,
      fitToDrive ? 'defect' : 'not-fit', 'open', now));
  }
  if (Number(mileage)) statements.push(env.DB.prepare('UPDATE vehicles SET mileage = ?, updated_at = ? WHERE id = ?').bind(Number(mileage), now, vehicleId));
  if (!fitToDrive) statements.push(env.DB.prepare("UPDATE vehicles SET status = 'off-road', updated_at = ? WHERE id = ?").bind(now, vehicleId));
  await env.DB.batch(statements);

  // Being on site means the job should have moved on, so the hub does it.
  let transitionNote = null;
  if (issueKey) {
    try {
      transitionNote = await moveToOnSite(env, issueKey);
    } catch (err) {
      transitionNote = err.message;
    }
    if (transitionNote) {
      await env.DB.prepare('UPDATE vehicle_checks SET transition_note = ? WHERE id = ?').bind(transitionNote, id).run();
      await raiseAlert(env, {
        kind: 'visit-not-progressed',
        dedupe: `visit-not-progressed:${issueKey}:${londonDate()}`,
        subject: `Vehicle check done but ${issueKey} was not moved on`,
        body: `${viewer.employee?.name || viewer.email} checked out ${vehicle.registration} for ${issueKey} and is on the way.\n\n`
          + `The hub could not move the job on: ${transitionNote}\n\nWorth setting its status by hand.`,
      });
    }
  }

  if (fails.length) {
    await raiseAlert(env, {
      kind: fitToDrive ? 'vehicle-defect' : 'vehicle-off-road',
      dedupe: `vehicle-${fitToDrive ? 'defect' : 'off-road'}:${id}`,
      subject: `${vehicle.registration}: ${fitToDrive ? `${fails.length} defect${fails.length > 1 ? 's' : ''} reported` : 'reported not fit to drive'}`,
      body: `${viewer.employee?.name || viewer.email} reported the following on ${vehicle.registration}`
        + `${vehicle.make ? ` (${vehicle.make} ${vehicle.model || ''})` : ''}:\n\n`
        + fails.map(([key, label]) => `  ${label}: ${results[key]?.note || 'no detail given'}`).join('\n')
        + (fitToDrive ? '\n\nThey judged it still fit to drive.' : '\n\nIt is marked off the road and cannot be booked until the defects are cleared.')
        + (vehicle.responsible_email ? `\n\nMaintenance contact: ${vehicle.responsible_email}` : ''),
    });
  }

  return { id, defects: fails.length, fitToDrive, transitionNote };
}

// Moves a site visit to Commissioning or Visit In-Progress, whichever applies.
async function moveToOnSite(env, issueKey) {
  const issue = (await searchJql(env, `key = "${issueKey}"`, ['issuetype', 'status']))[0];
  if (!issue) return 'the item no longer exists';
  const type = issue.fields?.issuetype?.name;
  const target = ON_SITE_STATUS[type];
  if (!target) return `no on-site status is defined for a ${type}`;
  if (issue.fields?.status?.name === target) return null;

  const { transitions } = await jira(env, `/rest/api/3/issue/${issueKey}/transitions`);
  const transition = (transitions || []).find((t) => (t.to?.name || t.name) === target);
  if (!transition) return `"${target}" was not available from "${issue.fields?.status?.name}"`;

  await jira(env, `/rest/api/3/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
  return null;
}

// ---------- Defects ----------

export async function listDefects(env, { status = 'open' } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, v.registration, v.make, v.model, e.name AS reporter
       FROM vehicle_defects d JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN employees e ON e.account_id = d.account_id
      WHERE d.status = ? ORDER BY d.created_at DESC LIMIT 60`
  ).bind(status).all();
  return { defects: results };
}

export async function resolveDefect(env, viewer, { id, note }) {
  const defect = await env.DB.prepare('SELECT * FROM vehicle_defects WHERE id = ?').bind(id).first();
  if (!defect) throw new Error('That defect has gone.');
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE vehicle_defects SET status = 'closed', resolved_at = ?, resolved_by = ?, note = COALESCE(note, '') || ? WHERE id = ?"
  ).bind(now, viewer.employee?.name || viewer.email, note ? ` — fixed: ${note}` : '', id).run();

  const stillOpen = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vehicle_defects WHERE vehicle_id = ? AND status = 'open' AND severity = 'not-fit'"
  ).bind(defect.vehicle_id).first();
  if (!stillOpen.n) {
    await env.DB.prepare("UPDATE vehicles SET status = 'available', updated_at = ? WHERE id = ? AND status = 'off-road'")
      .bind(now, defect.vehicle_id).run();
  }
  return { ok: true };
}

// ---------- Compliance reminders ----------

export async function checkExpiries(env) {
  const { results } = await env.DB.prepare('SELECT * FROM vehicles WHERE active = 1').all();
  let raised = 0;
  for (const vehicle of results) {
    for (const [field, label] of EXPIRY_FIELDS) {
      const days = daysUntil(vehicle[field]);
      if (days === null || days > 30) continue;
      const step = REMIND_AT.find((d) => days <= d);
      if (step === undefined) continue;
      await raiseAlert(env, {
        kind: 'vehicle-expiry',
        dedupe: `vehicle-expiry:${vehicle.id}:${field}:${vehicle[field]}:${step}`,
        subject: days < 0
          ? `${vehicle.registration}: ${label} expired`
          : `${vehicle.registration}: ${label} due in ${days} day${days === 1 ? '' : 's'}`,
        body: `${label} for ${vehicle.registration}${vehicle.make ? ` (${vehicle.make} ${vehicle.model || ''})` : ''} is due ${vehicle[field]}.`
          + (vehicle.responsible_email ? `\n\nMaintenance contact: ${vehicle.responsible_email}` : '')
          + (days < 0 ? '\n\nThis one has already passed.' : ''),
      });
      raised++;
    }
  }
  return { vehicles: results.length, raised };
}
