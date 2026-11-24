// Lays a job document out as a Promtek document, in the style of the ones written by hand:
// the blue band with the logo and title, the date and order number, the customer's details,
// the version table, contents, then each section, with tables headed in Promtek blue and the
// accreditations and company details at the foot of every page.
import { Pdf, A4, widthOf, wrap } from './pdf.js';
import { bandPortrait, bandLandscape, footer } from './doc-assets.js';
import { HEADER_FIELDS } from './docs-library.js';

const BLUE = [0, 141 / 255, 198 / 255];
const NAVY = [14 / 255, 98 / 255, 147 / 255];
const INK = [0.13, 0.15, 0.18];
const GREY = [0.42, 0.45, 0.5];
const RULE = [0.78, 0.8, 0.83];
const ZEBRA = [0.955, 0.97, 0.985];
const GROUP = [0.86, 0.93, 0.97];
const PASS_C = [0.1, 0.5, 0.25];
const FAIL_C = [0.75, 0.15, 0.12];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Wrapped to a width, breaking a word too long for it (a long tag, say) wherever it has to.
function fit(text, size, width, bold = false) {
  const out = [];
  for (const line of wrap(text, size, width, bold)) {
    if (widthOf(line, size, bold) <= width) { out.push(line); continue; }
    let cur = '';
    for (const ch of line) {
      if (cur && widthOf(cur + ch, size, bold) > width) { out.push(cur); cur = ch.trim() ? ch : ''; } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

const ordinal = (d) => { const s = ['th', 'st', 'nd', 'rd']; const v = d % 100; return `${d}${s[(v - 20) % 10] || s[v] || s[0]}`; };
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${ordinal(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
}
const shortDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ''); };
const blank = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const cellText = (col, v) => (col.type === 'date' ? shortDate(v) : String(v ?? ''));
const fromDataUrl = (url) => { const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(url || '')); return m ? m[1] : null; };
function jpegDims(b64) {
  try {
    const s = atob(b64.slice(0, 40000));
    let i = 2;
    while (i + 9 < s.length) {
      if (s.charCodeAt(i) !== 0xff) { i++; continue; }
      const marker = s.charCodeAt(i + 1);
      const len = (s.charCodeAt(i + 2) << 8) + s.charCodeAt(i + 3);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (s.charCodeAt(i + 5) << 8) + s.charCodeAt(i + 6), width: (s.charCodeAt(i + 7) << 8) + s.charCodeAt(i + 8) };
      i += 2 + len;
    }
  } catch { /* not a JPEG */ }
  return null;
}

class Layout {
  constructor(input, pageOf) {
    const t = input.type.template;
    this.input = input;
    this.landscape = Boolean(t.landscape);
    this.size = this.landscape ? { width: A4.height, height: A4.width } : A4;
    this.W = this.size.width;
    this.H = this.size.height;
    this.L = 42;
    this.R = this.W - 42;
    this.cw = this.R - this.L;
    this.footW = Math.min(this.cw, 511);
    this.footH = this.footW * (footer.height / footer.width);
    this.bottom = 30 + this.footH + 26;
    this.pdf = new Pdf({ size: this.size, margin: 0, title: `${input.category.epicKey || input.category.key} ${t.title}` });
    this.pdf.addJpeg('Band', this.landscape ? bandLandscape : bandPortrait);
    this.pdf.addJpeg('Foot', footer);
    this.pageOf = pageOf || new Map();
    this.found = new Map();
    this.photos = new Map();
    for (const p of input.photos || []) {
      if (!this.photos.has(p.field)) this.photos.set(p.field, []);
      this.photos.get(p.field).push(p);
    }
    this.sigs = 0;
    this.y = this.H;
    if (input.draft) this.watermark();
  }

  get page() { return this.pdf.pages.length; }

  watermark() {
    const cx = this.W / 2 - (this.landscape ? 160 : 130);
    const cy = this.H / 2 - 120;
    this.pdf.ops.push(`BT /FB 110 Tf 0.94 0.95 0.96 rg 0.7071 0.7071 -0.7071 0.7071 ${cx.toFixed(1)} ${cy.toFixed(1)} Tm (DRAFT) Tj ET`);
  }

  newPage() {
    this.pdf.newPage();
    if (this.input.draft) this.watermark();
    // Every page after the first carries the document and order along the top.
    const top = this.H - 30;
    this.pdf.text(this.input.type.template.title, this.L, top, { size: 8, bold: true, colour: NAVY });
    this.pdf.text(this.orderLine(), this.L, top, { size: 8, colour: GREY, align: 'right', width: this.cw });
    this.pdf.line(this.L, top - 6, this.R, top - 6, { colour: BLUE, lineWidth: 0.8 });
    this.y = top - 24;
  }

  orderLine() {
    const c = this.input.category;
    const v = this.input.draft ? 'Draft' : `Version ${this.input.version}`;
    return `${c.epicKey || c.key}${c.customer ? ` | ${c.customer}` : ''} | ${v}`;
  }

  need(h) { if (this.y - h < this.bottom) { this.newPage(); return true; } return false; }

  // ---------- the first page ----------

  cover() {
    const t = this.input.type.template;
    const c = this.input.category;
    const band = this.landscape ? bandLandscape : bandPortrait;
    const bh = this.W * (band.height / band.width);
    this.pdf.image('Band', 0, this.H - bh, this.W, bh);
    const tx = this.W * (this.landscape ? 0.19 : 0.27);
    const tsize = widthOf(t.title, 22) > this.W - tx - 30 ? 17 : 22;
    this.pdf.text(t.title, tx, this.H - bh / 2 - tsize * 0.35, { size: tsize, colour: [1, 1, 1] });
    this.y = this.H - bh - 30;

    // The date, and Promtek's order number.
    const half = this.cw / 2;
    const rowTop = this.y + 14;
    this.pdf.text(longDate(this.input.date), this.L, this.y, { size: 13, bold: true, colour: INK });
    const label = "Promtek's Order Number: ";
    const lx = this.L + half + 14;
    this.pdf.text(label, lx, this.y, { size: 13, bold: true, colour: INK });
    this.pdf.text(c.epicKey || c.key, lx + widthOf(label, 13, true), this.y, { size: 13, colour: INK });
    this.pdf.line(this.L + half, rowTop, this.L + half, this.y - 10, { colour: RULE, lineWidth: 1 });
    this.pdf.line(this.L, this.y - 12, this.R, this.y - 12, { colour: RULE, lineWidth: 0.6 });
    this.y -= 34;

    if (t.intro) {
      const lines = wrap(t.intro, 10.5, this.cw * 0.8, true);
      lines.forEach((l, i) => this.pdf.text(l, this.L, this.y - i * 14, { size: 10.5, bold: true, colour: INK, align: 'center', width: this.cw }));
      this.y -= lines.length * 14 + 12;
    }

    // The customer's details, two to a row.
    const h = this.input.header || {};
    const pairs = [['Customer name', c.customer || ''], ...(t.header || []).map((k) => [HEADER_FIELDS[k]?.label || k, HEADER_FIELDS[k]?.type === 'date' ? longDate(h[k]) : h[k] || ''])];
    if (c.order) pairs.splice(1, 0, ['Order', c.order]);
    const colW = (this.cw - 24) / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const row = pairs.slice(i, i + 2);
      const heights = row.map(([k, v]) => Math.max(wrap(k, 9, 92, true).length, wrap(v || ' ', 9.5, colW - 100).length) * 12.5);
      const rh = Math.max(...heights) + 8;
      row.forEach(([k, v], j) => {
        const x = this.L + j * (colW + 24);
        wrap(k, 9, 92, true).forEach((l, n) => this.pdf.text(l, x, this.y - n * 12.5, { size: 9, bold: true, colour: GREY }));
        wrap(v || ' ', 9.5, colW - 100).forEach((l, n) => this.pdf.text(l, x + 100, this.y - n * 12.5, { size: 9.5, colour: INK }));
        this.pdf.line(x, this.y - rh + 6, x + colW, this.y - rh + 6, { colour: RULE, lineWidth: 0.6 });
      });
      this.y -= rh + 6;
    }
    this.y -= 10;

    // The versions issued.
    const versions = [...(this.input.versions || [])];
    if (this.input.draft) versions.push({ version: (this.input.version || 0) + 1, initials: '', date: this.input.date, description: 'Draft, not yet issued' });
    this.table([{ id: 'version', label: 'Version No', w: 14 }, { id: 'initials', label: 'Initials', w: 12 }, { id: 'date', label: 'Date', w: 16, type: 'date' }, { id: 'description', label: 'Description', w: 58 }],
      versions.length ? versions : [{}], { width: this.landscape ? this.cw * 0.6 : this.cw, minRows: 3 });
    this.y -= 14;
  }

  contents(sections) {
    if (sections.length < 4) return;
    this.need(40);
    this.pdf.text('Contents', this.L, this.y, { size: 12, bold: true, italic: true, colour: NAVY });
    this.y -= 18;
    sections.forEach((s, i) => {
      this.need(14);
      const label = `${i + 1}.  ${s.title}`;
      const page = this.pageOf.get(s.title);
      this.pdf.text(label, this.L + 4, this.y, { size: 9.5, colour: INK });
      if (page) {
        const pw = widthOf(String(page), 9.5);
        const from = this.L + 8 + widthOf(label, 9.5);
        const to = this.R - pw - 6;
        if (to > from) this.pdf.text('.'.repeat(Math.max(0, Math.floor((to - from) / widthOf('.', 9.5)))), from, this.y, { size: 9.5, colour: RULE });
        this.pdf.text(String(page), this.R - pw, this.y, { size: 9.5, colour: INK });
      }
      this.y -= 14;
    });
    this.y -= 10;
  }

  // ---------- pieces ----------

  heading(text, n) {
    this.need(60);
    this.y -= 6;
    this.found.set(text, this.page);
    const label = `${n}. ${text}`;
    this.pdf.text(label, this.L, this.y, { size: 13, bold: true, colour: NAVY });
    this.pdf.line(this.L, this.y - 6, this.R, this.y - 6, { colour: BLUE, lineWidth: 0.6 });
    this.y -= 22;
  }

  sub(text) {
    this.need(64);
    this.pdf.text(text, this.L, this.y, { size: 10.5, bold: true, italic: true, colour: INK });
    this.y -= 15;
  }

  para(text, { size = 10, italic = false, colour = INK, indent = 0 } = {}) {
    const lines = wrap(text, size, this.cw - indent);
    const lead = size * 1.4;
    for (const l of lines) {
      this.need(lead);
      this.pdf.text(l, this.L + indent, this.y, { size, italic, colour });
      this.y -= lead;
    }
    this.y -= 6;
  }

  none(text = 'N/A') { this.para(text, { italic: true, colour: GREY }); }

  // A table headed in Promtek blue, its header repeated on each page, optionally grouped.
  table(columns, rows, { width = this.cw, minRows = 0, group = null, groupNames = {}, sub = null, subLabel = '', tone = null, numbered = false } = {}) {
    const cols = numbered ? [{ id: '#', label: 'No', w: 5 }, ...columns] : columns;
    const total = cols.reduce((t, c) => t + (c.w || 10), 0);
    const widths = cols.map((c) => ((c.w || 10) / total) * width);
    const fs = this.landscape || cols.length > 7 ? 7.8 : 8.6;
    const lead = fs * 1.3;
    const pad = 4;
    const head = () => {
      const lines = cols.map((c, i) => wrap(c.label, fs, widths[i] - pad * 2, true));
      const hh = Math.max(...lines.map((l) => l.length)) * lead + pad * 2;
      this.pdf.rect(this.L, this.y - hh, width, hh, { fill: BLUE });
      let x = this.L;
      lines.forEach((ls, i) => {
        // A single word too long for its column is set a little smaller, rather than cut off.
        const room = widths[i] - pad * 2;
        ls.forEach((l, n) => {
          const hs = Math.min(fs, (fs * room) / Math.max(1, widthOf(l, fs, true)));
          this.pdf.text(l, x + pad, this.y - pad - fs * 0.85 - n * lead, { size: hs, bold: true, colour: [1, 1, 1] });
        });
        x += widths[i];
      });
      this.y -= hh;
    };
    const filled = rows.filter((r) => r && cols.some((c) => c.id !== '#' && !blank(r[c.id])));
    if (!filled.length && !minRows) { this.none('None.'); return; }
    this.need(lead * 3 + 20);
    head();
    let zebra = false;
    const band = (text) => {
      const bh = lead + pad * 2;
      if (this.need(bh + lead + pad * 2)) head();
      this.pdf.rect(this.L, this.y - bh, width, bh, { fill: GROUP, stroke: RULE, lineWidth: 0.5 });
      this.pdf.text(text, this.L + pad, this.y - pad - fs * 0.85, { size: fs, bold: true, colour: NAVY });
      this.y -= bh;
      zebra = false;
    };
    const draw = (row, i) => {
      const cells = cols.map((c, j) => fit(c.id === '#' ? String(i + 1) : cellText(c, row[c.id]), fs, widths[j] - pad * 2));
      const rh = Math.max(1, ...cells.map((l) => l.length)) * lead + pad * 2;
      if (this.need(rh)) head();
      if (zebra) this.pdf.rect(this.L, this.y - rh, width, rh, { fill: ZEBRA });
      zebra = !zebra;
      let x = this.L;
      cells.forEach((ls, j) => {
        const c = cols[j];
        const v = String(row[c.id] ?? '');
        const colour = tone && c.id === tone ? (/^pass|^yes/i.test(v) ? PASS_C : /^fail|^no$/i.test(v) ? FAIL_C : INK) : /^spare$/i.test(v) ? GREY : INK;
        ls.forEach((l, n) => this.pdf.text(l, x + pad, this.y - pad - fs * 0.85 - n * lead, { size: fs, colour, bold: colour !== INK && colour !== GREY }));
        this.pdf.line(x, this.y, x, this.y - rh, { colour: RULE, lineWidth: 0.5 });
        x += widths[j];
      });
      this.pdf.line(this.L + width, this.y, this.L + width, this.y - rh, { colour: RULE, lineWidth: 0.5 });
      this.pdf.line(this.L, this.y - rh, this.L + width, this.y - rh, { colour: RULE, lineWidth: 0.5 });
      this.y -= rh;
    };
    if (group) {
      const order = Object.keys(groupNames);
      const keys = [...new Set(filled.map((r) => String(r[group] || '')))].sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      let n = 0;
      for (const k of keys) {
        const list = filled.filter((r) => String(r[group] || '') === k);
        const subs = sub ? [...new Set(list.map((r) => String(r[sub] || '')))] : [''];
        for (const s of subs) {
          const part = sub ? list.filter((r) => String(r[sub] || '') === s) : list;
          const spare = part.filter((r) => /spare/i.test(`${r.tag || ''} ${r.description || ''}`)).length;
          const name = groupNames[k] || k || 'Other';
          band(`${name}${sub && s ? `, ${subLabel} ${s}` : ''}  (${part.length}${spare ? `, ${spare} spare` : ''})`);
          part.forEach((r) => draw(r, n++));
        }
      }
    } else {
      filled.forEach((r, i) => draw(r, i));
    }
    for (let i = filled.length; i < minRows; i++) draw({}, i);
    this.y -= 16;
  }

  photosOf(fieldPath) {
    const list = this.photos.get(fieldPath) || [];
    if (!list.length) return false;
    const per = this.landscape ? 3 : 2;
    const gap = 14;
    const cellW = (this.cw - gap * (per - 1)) / per;
    const maxH = this.landscape ? 170 : 210;
    for (let i = 0; i < list.length; i += per) {
      const row = list.slice(i, i + per);
      const dims = row.map((p) => { const s = Math.min(cellW / p.width, maxH / p.height); return { w: p.width * s, h: p.height * s }; });
      const caps = row.map((p) => wrap(p.caption || '', 8.5, cellW));
      const rh = Math.max(...dims.map((d) => d.h)) + Math.max(...caps.map((c) => (c[0] ? c.length : 0))) * 11 + 14;
      this.need(rh);
      row.forEach((p, j) => {
        const name = `P${p.id}`;
        this.pdf.addJpeg(name, { base64: p.data, width: p.width, height: p.height });
        const x = this.L + j * (cellW + gap);
        const d = dims[j];
        this.pdf.rect(x + (cellW - d.w) / 2 - 0.5, this.y - d.h - 0.5, d.w + 1, d.h + 1, { stroke: RULE, lineWidth: 0.5 });
        this.pdf.image(name, x + (cellW - d.w) / 2, this.y - d.h, d.w, d.h);
        caps[j].forEach((l, n) => { if (l) this.pdf.text(l, x, this.y - d.h - 12 - n * 11, { size: 8.5, italic: true, colour: GREY, align: 'center', width: cellW }); });
      });
      this.y -= rh;
    }
    return true;
  }

  signoff(f, value) {
    const who = f.who || ['Signed'];
    const list = Array.isArray(value) ? value : [];
    const per = this.landscape ? 3 : 2;
    const gap = 18;
    const w = (this.cw - gap * (per - 1)) / per;
    const bh = 118;
    for (let i = 0; i < who.length; i += per) {
      this.need(bh + 8);
      who.slice(i, i + per).forEach((role, j) => {
        const s = list[i + j] || {};
        const x = this.L + j * (w + gap);
        const top = this.y;
        this.pdf.rect(x, top - bh, w, bh, { stroke: RULE, lineWidth: 0.6 });
        this.pdf.rect(x, top - 18, w, 18, { fill: BLUE });
        this.pdf.text(role, x + 6, top - 12.5, { size: 9, bold: true, colour: [1, 1, 1] });
        const line = (label, v, yy) => {
          this.pdf.text(label, x + 6, yy, { size: 8.5, bold: true, colour: GREY });
          this.pdf.text(v || '', x + 62, yy, { size: 9, colour: INK });
          this.pdf.line(x + 60, yy - 3, x + w - 8, yy - 3, { colour: RULE, lineWidth: 0.5 });
        };
        line('Name', s.name, top - 34);
        line('Position', s.position, top - 50);
        line('Date', s.date ? shortDate(s.date) : '', top - 66);
        this.pdf.text('Signature', x + 6, top - 84, { size: 8.5, bold: true, colour: GREY });
        const b64 = fromDataUrl(s.sig);
        const dims = b64 && jpegDims(b64);
        if (dims) {
          const name = `S${this.sigs++}`;
          this.pdf.addJpeg(name, { base64: b64, ...dims });
          const sc = Math.min((w - 72) / dims.width, 40 / dims.height);
          this.pdf.image(name, x + 62, top - 110, dims.width * sc, dims.height * sc);
        }
        this.pdf.line(x + 60, top - 110, x + w - 8, top - 110, { colour: RULE, lineWidth: 0.5 });
      });
      this.y -= bh + 12;
    }
  }

  // ---------- fields ----------

  field(f, data, path, { sectionTitle = '' } = {}) {
    const v = data?.[f.id];
    const p = path ? `${path}.${f.id}` : f.id;
    const label = String(f.label || '').toLowerCase() === sectionTitle.toLowerCase() ? null : f.label;
    switch (f.type) {
      case 'note':
        if (f.pdf === false) return;
        this.para(f.text, { size: 9, italic: true, colour: GREY });
        return;
      case 'text': case 'number': case 'select': case 'date': {
        const shown = f.type === 'date' ? longDate(v) : v;
        if (label) {
          const lw = Math.min(170, widthOf(`${label}: `, 10, true));
          const empty = blank(shown);
          const lines = empty ? [f.blank || 'N/A'] : wrap(String(shown), 10, this.cw - lw - 4);
          this.need(lines.length * 14 + 4);
          this.pdf.text(`${label}:`, this.L, this.y, { size: 10, bold: true, colour: INK });
          lines.forEach((l, n) => this.pdf.text(l, this.L + lw + 4, this.y - n * 14, { size: 10, italic: empty, colour: empty ? GREY : INK }));
          this.y -= lines.length * 14 + 6;
        } else if (blank(shown)) this.none(f.blank); else this.para(String(shown));
        return;
      }
      case 'textarea':
        if (label) this.sub(label);
        if (blank(v)) this.none(f.blank); else this.para(String(v));
        return;
      case 'table':
        if (label) this.sub(label);
        this.table(f.columns, Array.isArray(v) ? v : [], { group: f.group, groupNames: f.groupNames || {}, sub: f.sub, subLabel: f.subLabel });
        return;
      case 'tests': {
        if (label) this.sub(label);
        const cols = [{ id: 'action', label: 'Test', w: f.columns ? 30 : 48 }, ...(f.columns || []).filter((c) => c.id !== 'test').map((c) => ({ ...c, w: 24 })),
          { id: 'result', label: 'Result', w: 11 }, { id: 'date', label: 'Date', w: 10, type: 'date' }, { id: 'initials', label: 'Initial', w: 8 },
          ...(f.witness ? [{ id: 'witness', label: 'Witness', w: 9 }] : []), { id: 'note', label: 'Comments', w: 16 }];
        this.table(cols, (Array.isArray(v) ? v : []).filter((r) => !blank(r?.action)), { numbered: true, tone: 'result' });
        return;
      }
      case 'checklist': {
        if (label) this.sub(label);
        const list = Array.isArray(v) ? v : [];
        const rows = (f.items || []).map((item, i) => ({ item, answer: list[i]?.answer || '', note: list[i]?.note || '' }));
        list.slice((f.items || []).length).forEach((r) => rows.push({ item: r.item || '', answer: r.answer || '', note: r.note || '' }));
        this.table([{ id: 'item', label: 'Check', w: 52 }, { id: 'answer', label: 'Answer', w: 14 }, { id: 'note', label: 'Notes', w: 34 }], rows, { numbered: true, tone: 'answer' });
        return;
      }
      case 'steps': {
        if (label) this.sub(label);
        const list = (Array.isArray(v) ? v : []).filter((s) => !blank(s));
        if (!list.length) { this.none(f.blank); return; }
        list.forEach((s, i) => {
          const lines = wrap(String(s), 10, this.cw - 24);
          this.need(lines.length * 14 + 4);
          this.pdf.roundRect(this.L, this.y - 4, 15, 13, 6.5, { fill: NAVY });
          this.pdf.text(String(i + 1), this.L, this.y - 0.5, { size: 7.5, bold: true, colour: [1, 1, 1], align: 'center', width: 15 });
          lines.forEach((l, n) => this.pdf.text(l, this.L + 24, this.y - n * 14, { size: 10, colour: INK }));
          this.y -= lines.length * 14 + 5;
        });
        this.y -= 6;
        return;
      }
      case 'photos':
        if (!(this.photos.get(p) || []).length) { if (f.blank && label) { this.sub(label); this.none(f.blank); } return; }
        if (label) this.sub(label);
        this.photosOf(p);
        return;
      case 'files': {
        const list = (this.input.files || []).filter((x) => x.field === p);
        if (!list.length) { if (f.blank) { if (label) this.sub(label); this.none(f.blank); } return; }
        if (label) this.sub(label);
        this.table([{ id: 'name', label: 'File', w: 70 }, { id: 'size', label: 'Size', w: 30 }], list.map((x) => ({ name: x.name, size: size(x.size) })));
        return;
      }
      case 'signoff':
        this.signoff(f, v);
        return;
      case 'docs':
        this.table([{ id: 'name', label: 'Document', w: 46 }, { id: 'category', label: 'Category', w: 18 }, { id: 'version', label: 'Version', w: 14 }, { id: 'date', label: 'Issued', w: 22, type: 'date' }],
          this.input.finished || []);
        return;
      case 'chapters': {
        const list = Array.isArray(v) ? v : [];
        if (!list.length) { this.none(); return; }
        list.forEach((ch, i) => {
          this.need(70);
          const title = ch?.title || `${f.label} ${i + 1}`;
          this.pdf.text(`${this.sectionNo}.${i + 1}  ${title}`, this.L, this.y, { size: 12, bold: true, colour: INK });
          this.y -= 18;
          for (const inner of f.fields) {
            const iv = ch?.[inner.id];
            const base = `${p}.${ch?._k || i}`;
            const ip = `${base}.${inner.id}`;
            const has = inner.type === 'photos' ? (this.photos.get(ip) || []).length : inner.type === 'files' ? (this.input.files || []).some((x) => x.field === ip) : !blank(iv) && !(Array.isArray(iv) && !iv.some((r) => r && Object.values(r).some((x) => !blank(x))));
            if (!has) continue;
            this.field(inner, ch, base);
          }
          this.y -= 6;
        });
        return;
      }
      default:
        if (!blank(v)) this.para(String(v));
    }
  }

  footers() {
    const n = this.pdf.pages.length;
    const fh = this.footH;
    this.pdf.pages.forEach((ops, i) => {
      this.pdf.ops = ops;
      const base = 26;
      this.pdf.image('Foot', this.L + (this.cw - this.footW) / 2, base + 24, this.footW, fh);
      this.pdf.text('promtek.com', this.L, base + 12, { size: 6.5, bold: true, colour: INK });
      this.pdf.text('01782 375600', this.L, base + 4, { size: 6.5, bold: true, colour: INK });
      const mid = this.L + 70;
      const mw = this.cw - 140;
      this.pdf.text('Registered in England & Wales Company Registration No: 2275192 VAT Number GB 290012302', mid, base + 12, { size: 5.8, colour: INK, align: 'center', width: mw });
      this.pdf.text('Registered Office Fisher Street, Brindley Ford, Stoke-on-Trent, Staffordshire, ST8 7QJ, United Kingdom', mid, base + 4, { size: 5.8, colour: INK, align: 'center', width: mw });
      this.pdf.text(`Page ${i + 1} of ${n}`, this.L, base + 8, { size: 7.5, colour: INK, align: 'right', width: this.cw });
    });
  }

  build() {
    const t = this.input.type.template;
    this.cover();
    const sections = t.sections.filter((s) => s.fields.some((f) => f.type !== 'note' || f.pdf !== false));
    this.contents(sections);
    sections.forEach((s, i) => {
      this.sectionNo = i + 1;
      this.heading(s.title, i + 1);
      for (const f of s.fields) this.field(f, this.input.data, '', { sectionTitle: s.title });
      this.y -= 4;
    });
    this.footers();
    return this;
  }
}

// Laid out twice: the first time to find which page each section starts on, for the contents.
export async function buildDocPdf(input) {
  const first = new Layout(input).build();
  const second = new Layout(input, first.found).build();
  return second.pdf.toBytes();
}
