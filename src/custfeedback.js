// Customer feedback: what customers say at the end of a visit, asked on the point of work
// assessment before they sign it off. Kept here rather than in the assessment, for the
// Customer Feedback tile. Wanting a sales visit or to give a testimonial is passed to Sales or
// Marketing; a poor score to Management.
import { raiseAlert } from './sync.js';
import { canTile } from './permissions.js';
import { scopeFor } from './country.js';
import { record as audit } from './audit.js';
import { FEEDBACK_QUESTIONS } from './pow-data.js';

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').slice(0, n);
const score = (v) => { const x = Number(v); return Number.isInteger(x) && x >= 1 && x <= 5 ? x : null; };
const yesNo = (v) => (v === 'yes' ? 1 : v === 'no' ? 0 : null);
const nameOf = (viewer) => viewer?.employee?.name || viewer?.name || viewer?.email || 'Someone';
const projectOf = (key) => String(key || '').split('-')[0] || null;

function mustSee(viewer) { if (!canTile(viewer, 'custfeedback')) throw refuse('Customer Feedback isn\'t open to you.', 403); }

async function teamEmails(env, { team = null, group = null }) {
  const { results } = await env.DB.prepare('SELECT email, teams, groups FROM employees WHERE active = 1').all();
  const has = (v, x) => { try { return JSON.parse(v || '[]').includes(x); } catch { return false; } };
  return results.filter((e) => e.email && (team ? has(e.teams, team) : has(e.groups, group))).map((e) => String(e.email).toLowerCase());
}

// From a point of work assessment, as it's sent.
export async function fromPow(env, viewer, form, fb) {
  const s = form.signoff || {};
  const row = {
    satisfied: score(fb.satisfied), resolved: fb.resolved === 'yes' || fb.resolved === 'no' ? fb.resolved : null, recommend: score(fb.recommend),
    dataConfidence: score(fb.dataConfidence), salesVisit: yesNo(fb.salesVisit), testimonial: yesNo(fb.testimonial), suggestions: clip(fb.suggestions, 4000).trim() || null,
  };
  if (Object.values(row).every((v) => v == null)) return null;
  const issueKey = form.issueKey || null;
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`INSERT INTO customer_feedback (source, source_id, issue_key, project_key, customer, site, engineer_account, engineer_name, name, email, position,
      satisfied, resolved, recommend, data_confidence, sales_visit, testimonial, suggestions, created_at)
    VALUES ('pow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_id) DO NOTHING`)
    .bind(String(form.id), issueKey, form.projectKey || projectOf(issueKey), clip(form.details?.customer, 200) || null, clip(form.details?.site, 300) || null,
      viewer?.accountId || null, clip(form.details?.engineer || nameOf(viewer), 120), clip(s.customerName, 120) || null, clip(s.customerEmail, 200) || null,
      clip(s.customerPosition, 120) || null, row.satisfied, row.resolved, row.recommend, row.dataConfidence, row.salesVisit, row.testimonial, row.suggestions, now).run();
  if (!res.meta?.changes) return null;
  const id = res.meta.last_row_id;
  const who = `${s.customerName || 'The customer'}${s.customerPosition ? `, ${s.customerPosition}` : ''} at ${form.details?.customer || 'a customer'}`;
  const contact = `${s.customerName || ''}${s.customerEmail ? ` <${s.customerEmail}>` : ''}`.trim() || 'No contact details given';
  const where = `${issueKey ? `${issueKey}, ` : ''}visited by ${form.details?.engineer || nameOf(viewer)}`;
  const tell = async (kind, emails, subject, body) => {
    for (const email of [...new Set(emails)]) {
      await raiseAlert(env, { kind, dedupe: `${kind}:${id}:${email}`, recipient: email, link: '#/custfeedback', subject, body }).catch(() => {});
    }
  };
  if (row.salesVisit === 1) {
    await tell('feedback-sales', await teamEmails(env, { team: 'Sales' }), `${form.details?.customer || 'A customer'} would like a visit from Sales`,
      `${who} would like a member of the Sales team to contact them to arrange a visit.\n\nContact: ${contact}\nFrom: ${where}`);
  }
  if (row.testimonial === 1) {
    await tell('feedback-testimonial', await teamEmails(env, { team: 'Marketing' }), `${form.details?.customer || 'A customer'} would like to give a testimonial`,
      `${who} would like to provide a testimonial for Promtek.\n\nContact: ${contact}\nFrom: ${where}`);
  }
  if ((row.satisfied && row.satisfied <= 2) || row.resolved === 'no' || (row.recommend && row.recommend <= 2)) {
    const lines = FEEDBACK_QUESTIONS.filter((q) => q.scale || q.choices).map((q) => {
      const v = { satisfied: row.satisfied, resolved: row.resolved, recommend: row.recommend, dataConfidence: row.dataConfidence, salesVisit: fb.salesVisit, testimonial: fb.testimonial }[q.id];
      const label = (q.scale || q.choices).find(([k]) => String(k) === String(v))?.[1];
      return label ? `${q.text} ${label}` : null;
    }).filter(Boolean);
    await tell('feedback-poor', await teamEmails(env, { group: 'management' }), `Poor feedback from ${form.details?.customer || 'a customer'}`,
      `${who} gave poor feedback after a visit (${where}).\n\n${lines.join('\n')}${row.suggestions ? `\n\nSuggestions: ${row.suggestions}` : ''}\n\nContact: ${contact}`);
  }
  return id;
}

const view = (r) => ({
  id: r.id, source: r.source, issueKey: r.issue_key, customer: r.customer, site: r.site, engineer: r.engineer_name, name: r.name, email: r.email, position: r.position,
  satisfied: r.satisfied, resolved: r.resolved, recommend: r.recommend, dataConfidence: r.data_confidence, salesVisit: r.sales_visit, testimonial: r.testimonial,
  suggestions: r.suggestions, createdAt: r.created_at, salesDone: r.sales_done_at ? { at: r.sales_done_at, by: r.sales_done_by } : null,
  testimonialDone: r.testimonial_done_at ? { at: r.testimonial_done_at, by: r.testimonial_done_by } : null,
});

export async function list(env, viewer) {
  mustSee(viewer);
  const { results } = await env.DB.prepare('SELECT * FROM customer_feedback ORDER BY created_at DESC LIMIT 2000').all();
  const country = await scopeFor(env, viewer, 'custfeedback');
  const rows = results.filter((r) => country.sees({ project: r.project_key || r.issue_key, keys: [r.issue_key] })).map(view);
  const avg = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const answered = rows.filter((r) => r.resolved);
  return {
    rows, questions: FEEDBACK_QUESTIONS,
    summary: {
      count: rows.length, satisfied: avg('satisfied'), recommend: avg('recommend'), dataConfidence: avg('dataConfidence'),
      resolved: answered.length ? Math.round((answered.filter((r) => r.resolved === 'yes').length / answered.length) * 100) : null,
      salesOpen: rows.filter((r) => r.salesVisit === 1 && !r.salesDone).length, testimonialOpen: rows.filter((r) => r.testimonial === 1 && !r.testimonialDone).length,
    },
  };
}

// Sales have been in touch about a visit, or Marketing about the testimonial.
export async function markDone(env, viewer, { id, what, undo = false }) {
  mustSee(viewer);
  const r = await env.DB.prepare('SELECT * FROM customer_feedback WHERE id = ?').bind(Number(id)).first();
  if (!r) throw refuse('That feedback has gone.', 404);
  const country = await scopeFor(env, viewer, 'custfeedback');
  if (!country.sees({ project: r.project_key || r.issue_key, keys: [r.issue_key] })) throw refuse('That belongs to the other country.', 403);
  const col = what === 'testimonial' ? 'testimonial' : 'sales';
  await env.DB.prepare(`UPDATE customer_feedback SET ${col}_done_at = ?, ${col}_done_by = ? WHERE id = ?`)
    .bind(undo ? null : new Date().toISOString(), undo ? null : nameOf(viewer), r.id).run();
  await audit(env, viewer, { area: 'Customer Feedback', action: undo ? 'Marked follow-up as not done' : col === 'sales' ? 'Contacted about a sales visit' : 'Contacted about a testimonial',
    subjectType: 'feedback', subjectId: String(r.id), label: r.customer || '' }).catch(() => {});
  return { ok: true };
}
