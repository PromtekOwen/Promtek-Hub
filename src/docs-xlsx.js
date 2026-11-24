// The long lists in a job document (I/O, alarms, parameters and the like) as a spreadsheet as
// well, a sheet for each, laid out like the PDF: Promtek blue headings, grouped, filterable.
import { writeBook, colName } from '../public/xlsx-write.js';
import { fieldsOf } from './docs-library.js';
import { longDate } from './docs-pdf.js';

const HEAD = { bold: true, color: 'FFFFFF', fill: '008DC6', border: 'all', wrap: true, valign: 'center' };
const CELL = { border: 'all', wrap: true, valign: 'top' };
const BAND = { bold: true, color: '0E6293', fill: 'DCEEF7', border: 'all' };

export async function buildDocXlsx(input) {
  const t = input.type.template;
  const c = input.category;
  const tables = fieldsOf(t).filter((f) => f.type === 'table');
  const sheets = [];
  const used = new Set();
  for (const f of tables) {
    const rows = (Array.isArray(input.data?.[f.id]) ? input.data[f.id] : []).filter((r) => r && f.columns.some((col) => String(r[col.id] ?? '').trim()));
    if (!rows.length && tables.length > 1) continue;
    let name = String(f.label || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
    while (used.has(name)) name = `${name.slice(0, 28)} ${used.size}`;
    used.add(name);
    const out = [
      [{ v: `${t.title}: ${f.label}`, s: { bold: true, size: 14, color: '0E6293' } }],
      [{ v: `${c.epicKey || c.key}${c.customer ? ` | ${c.customer}` : ''} | Version ${input.version} | ${longDate(input.date)}`, s: { color: '6B7280' } }],
      [],
      f.columns.map((col) => ({ v: col.label, s: HEAD })),
    ];
    const headRow = out.length;
    const put = (r) => out.push(f.columns.map((col) => ({ v: r[col.id] ?? '', s: col.type === 'date' && r[col.id] ? { ...CELL, fmt: 'date' } : CELL })));
    if (f.group) {
      const names = f.groupNames || {};
      const order = Object.keys(names);
      const keys = [...new Set(rows.map((r) => String(r[f.group] || '')))].sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
      for (const k of keys) {
        const part = rows.filter((r) => String(r[f.group] || '') === k);
        const subs = f.sub ? [...new Set(part.map((r) => String(r[f.sub] || '')))] : [''];
        for (const s of subs) {
          const list = f.sub ? part.filter((r) => String(r[f.sub] || '') === s) : part;
          const spare = list.filter((r) => /spare/i.test(`${r.tag || ''} ${r.description || ''}`)).length;
          out.push([{ v: `${names[k] || k || 'Other'}${f.sub && s ? `, ${f.subLabel || ''} ${s}` : ''} (${list.length}${spare ? `, ${spare} spare` : ''})`, s: BAND },
            ...f.columns.slice(1).map(() => ({ v: '', s: BAND }))]);
          list.forEach(put);
        }
      }
    } else rows.forEach(put);
    const last = colName(f.columns.length - 1);
    const end = Math.max(out.length, headRow + 1);
    sheets.push({
      name, rows: out, widths: f.columns.map((col) => Math.round((col.w || 10) * 1.15 + 5)), freeze: { rows: headRow, cols: 0 },
      filter: `A${headRow}:${last}${end}`, heights: { [headRow - 1]: 30 },
      validations: f.columns.map((col, i) => (col.options ? { ref: `${colName(i)}${headRow + 1}:${colName(i)}${end + 200}`, list: col.options } : null)).filter(Boolean),
    });
  }
  if (!sheets.length) sheets.push({ name: 'Document', rows: [[{ v: t.title, s: { bold: true, size: 14 } }], ['Nothing listed yet.']] });
  const blob = writeBook(sheets);
  return new Uint8Array(await blob.arrayBuffer());
}
