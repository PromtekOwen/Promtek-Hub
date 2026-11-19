// The COSHH assessment as a PDF, laid out like the paper form (SP 04/A): the same boxes in the
// same order, filled in, with the product's photos in the containers box.
import { Pdf, A4, wrap, widthOf } from './pdf.js';
import { WHERE_USED, HAZARDS, PPE, DISPOSAL } from './coshh.js';

const GREY = [0.85, 0.85, 0.85];
const PALE = [0.94, 0.94, 0.94];
const LINE = [0, 0, 0];
const INK = [0, 0, 0];
const MUTED = [0.35, 0.35, 0.35];
const BLUE = [0, 0, 0.8];
const RED = [0.8, 0.1, 0.1];
const RISK = { low: [[0.15, 0.6, 0.25], 'LOW'], medium: [[0.85, 0.55, 0.05], 'MEDIUM'], high: [[0.8, 0.1, 0.1], 'HIGH'] };
const M = 30;
const PAD = 3;

const ukDate = (day) => (day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.split('-').reverse().join('/') : day || '');
const r2 = (n) => Math.round(n * 100) / 100;

// A box: its fill, border and text, top-left at (x, top).
function cell(doc, x, top, w, h, { fill = null, lines = [], size = 8.5, bold = false, align = 'left', valign = 'middle', colour = INK } = {}) {
  doc.rect(x, top - h, w, h, { fill, stroke: LINE, lineWidth: 0.6 });
  const leading = size * 1.2;
  const block = lines.length * leading;
  let y = valign === 'top' ? top - PAD - size : valign === 'bottom' ? top - h + PAD + block - size : top - (h - block) / 2 - size + 1;
  for (const l of lines) {
    const piece = typeof l === 'string' ? { text: l } : l;
    doc.text(piece.text, x + PAD, y, { size: piece.size || size, bold: piece.bold ?? bold, colour: piece.colour || colour, align, width: w - PAD * 2 });
    y -= leading;
  }
}
const wrapped = (text, size, width, bold = false) => (String(text || '').split('\n').flatMap((p) => wrap(p, size, width, bold)));
function heightFor(texts, size = 8.5, min = 16) {
  return Math.max(min, ...texts.map(([t, w, bold]) => wrapped(t, size, w - PAD * 2, bold).length * size * 1.2 + PAD * 2));
}

function breakAnywhere(text, size, width) {
  const out = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (line && widthOf(line + ch, size) > width) { out.push(line); line = ''; }
    line += ch;
  }
  if (line) out.push(line);
  return out;
}

// A tick or a cross, drawn.
function mark(doc, cx, cy, on, size = 7) {
  if (on) {
    doc.colour([0, 0, 0], true);
    doc.ops.push(`1.4 w ${r2(cx - size * 0.5)} ${r2(cy)} m ${r2(cx - size * 0.15)} ${r2(cy - size * 0.4)} l ${r2(cx + size * 0.55)} ${r2(cy + size * 0.5)} l S`);
  }
}

// The GHS diamond: red border, white inside, its name inside it.
function diamond(doc, cx, cy, r, on, label) {
  const pts = [[cx, cy + r], [cx + r, cy], [cx, cy - r], [cx - r, cy]];
  doc.colour(on ? [1, 1, 1] : [0.97, 0.97, 0.97]);
  doc.colour(on ? RED : [0.75, 0.75, 0.75], true);
  doc.ops.push(`${on ? 2.2 : 1} w ${pts.map(([x, y], i) => `${r2(x)} ${r2(y)} ${i ? 'l' : 'm'}`).join(' ')} h B`);
  const lines = wrapped(label, 5.2, r * 0.95, true).slice(0, 3);
  lines.forEach((l, i) => doc.text(l, cx - r, cy + (lines.length - 1) * 3.1 - i * 6.2 - 2, { size: 5.2, bold: true, colour: on ? INK : [0.6, 0.6, 0.6], align: 'center', width: r * 2 }));
}

export async function buildCoshhPdf(item, photos = []) {
  const d = item.data || {};
  const doc = new Pdf({ title: `COSHH ${item.no || ''} ${item.product || ''}`.trim(), margin: M });
  const W = A4.width - M * 2;
  const L = M;
  let top = A4.height - M;
  const need = (h) => { if (top - h < M + 10) { doc.newPage(); top = A4.height - M; } };

  // Heading, as the form has it.
  cell(doc, L, top, 90, 30, { lines: ['SP 04/A', 'Side 1 of 1'], size: 7.5, align: 'center' });
  cell(doc, L + 90, top, W - 180, 30, { lines: [{ text: 'C.O.S.H.H. ASSESSMENT FORM', bold: true, size: 12 }] });
  cell(doc, L + W - 90, top, 90, 30, { lines: ['Issue D', '15/09/2017'], size: 7.5, align: 'center' });
  top -= 38;

  const lab = 112;
  const label = (text, size = 8.5) => wrapped(text, size, lab - PAD * 2, true).map((t) => ({ text: t, bold: true, size }));
  // COSHH No, MSDS.
  cell(doc, L, top, 80, 18, { fill: GREY, lines: ['COSHH No:'], bold: true });
  cell(doc, L + 80, top, 122, 18, { lines: [{ text: String(item.no || ''), bold: true, size: 11 }], align: 'center' });
  cell(doc, L + 202, top, 150, 18, { fill: GREY, lines: ['MSDS Ref. Number(s)'], bold: true, align: 'right' });
  // A link to the sheet is broken anywhere to fit, on two small lines.
  const msdsW = W - 352 - PAD * 2;
  const isLink = /^https?:\/\//i.test(String(d.msds || ''));
  const msdsLines = isLink ? breakAnywhere(d.msds, 6, msdsW).slice(0, 2) : wrapped(d.msds, 8.5, msdsW).slice(0, 1);
  cell(doc, L + 352, top, W - 352, 18, { lines: msdsLines, size: isLink ? 6 : 8.5, colour: isLink ? BLUE : INK });
  top -= 18;

  // Product, and whether it's still in use.
  let h = heightFor([[item.product, 250, true]], 9, 30);
  need(h);
  cell(doc, L, top, lab, h, { fill: GREY, lines: label('Principal product name:') });
  cell(doc, L + lab, top, 250, h, { lines: wrapped(item.product, 9, 250 - PAD * 2, true), size: 9, bold: true });
  cell(doc, L + lab + 250, top, W - lab - 250, h / 2, { fill: GREY, lines: ['Is product known to still be in use or required?'], size: 6.2, bold: true, align: 'center' });
  cell(doc, L + lab + 250, top - h / 2, W - lab - 250, h / 2, { lines: [{ text: item.inHouse ? 'Yes' : 'No', bold: true, colour: item.inHouse ? [0.1, 0.55, 0.2] : RED }], align: 'center' });
  top -= h;

  // Other names, appearance.
  h = heightFor([[d.otherNames, 150], [d.appearance, W - lab - 150 - 95]], 8.5, 26);
  need(h);
  cell(doc, L, top, lab, h, { fill: GREY, lines: label('Other names / manufacturers:') });
  cell(doc, L + lab, top, 150, h, { lines: wrapped(d.otherNames, 8.5, 150 - PAD * 2) });
  cell(doc, L + lab + 150, top, 95, h, { fill: GREY, lines: [{ text: 'Appearance:', bold: true }, { text: '(under normal conditions)', size: 6.5 }] });
  cell(doc, L + lab + 245, top, W - lab - 245, h, { lines: wrapped(d.appearance, 8.5, W - lab - 245 - PAD * 2) });
  top -= h;

  // Containers, with the photos.
  const shown = photos.slice(0, 4);
  const textW = shown.length ? 150 : W - lab;
  const textLines = wrapped(d.containers, 8.5, textW - PAD * 2);
  h = Math.max(shown.length ? 120 : 40, textLines.length * 10.2 + PAD * 2);
  need(h);
  cell(doc, L, top, lab, h, { fill: GREY, lines: [{ text: 'Normal container(s):', bold: true }, { text: 'Include picture if possible', size: 7 }] });
  cell(doc, L + lab, top, W - lab, h, { lines: textLines, valign: 'top' });
  if (shown.length) {
    const room = W - lab - textW - PAD;
    const each = (room - PAD * (shown.length - 1)) / shown.length;
    shown.forEach((p, i) => {
      const scale = Math.min(each / p.width, (h - PAD * 2) / p.height);
      const pw = p.width * scale;
      const ph = p.height * scale;
      const name = `P${i}`;
      doc.addJpeg(name, p);
      const x = L + lab + textW + i * (each + PAD) + (each - pw) / 2;
      doc.image(name, x, top - h + (h - ph) / 2, pw, ph);
    });
  }
  top -= h;

  // What it's used for.
  h = heightFor([[d.usedFor, W - lab]], 8.5, 22);
  need(h);
  cell(doc, L, top, lab, h, { fill: GREY, lines: label('What is this product used for?', 8) });
  cell(doc, L + lab, top, W - lab, h, { lines: wrapped(d.usedFor, 8.5, W - lab - PAD * 2) });
  top -= h;

  // Where it's used: a box for each, ticked.
  need(22);
  cell(doc, L, top, lab, 22, { fill: GREY, lines: [...label('Where is this product used?', 7.5), { text: '(tick all that apply)', size: 6 }] });
  const optW = (W - lab) / WHERE_USED.length;
  WHERE_USED.forEach(([k, label], i) => {
    const x = L + lab + i * optW;
    cell(doc, x, top, optW - 16, 22, { fill: PALE, lines: wrapped(label, 6.2, optW - 16 - PAD * 2, true).slice(0, 3), size: 6.2, bold: true, align: 'center' });
    cell(doc, x + optW - 16, top, 16, 22, {});
    mark(doc, x + optW - 8, top - 11, (d.where || []).includes(k));
  });
  top -= 22;

  // Assessed by, date, signature, risk.
  need(36);
  const half = (W - lab) / 2;
  cell(doc, L, top, lab, 18, { fill: GREY, lines: label('Initial Assessment by (name):', 7.5) });
  cell(doc, L + lab, top, half, 18, { lines: [item.assessedBy || ''] });
  cell(doc, L + lab + half, top, 74, 18, { fill: GREY, lines: [{ text: 'Assessment Date:', bold: true, size: 7.5 }], align: 'right' });
  cell(doc, L + lab + half + 74, top, half - 74, 18, { lines: [ukDate(item.assessedOn)] });
  top -= 18;
  cell(doc, L, top, lab, 18, { fill: GREY, lines: ['Signature:'], bold: true });
  cell(doc, L + lab, top, half, 18, { lines: [{ text: item.assessedBy ? `Signed in Promtek Hub by ${item.assessedBy}` : '', size: 7.5, colour: MUTED }] });
  const risk = RISK[d.risk];
  cell(doc, L + lab + half, top, half, 18, { fill: GREY, lines: risk ? [{ text: risk[1], bold: true, size: 11, colour: risk[0] }] : [], align: 'center' });
  top -= 18;

  // Next reviews: up to six years.
  need(16 + 18 * 3);
  const colW = (W - 70) / 6;
  const reviews = (d.reviews || []).slice(-6);
  cell(doc, L, top, 70, 14, { fill: GREY, lines: ['Next Reviews'], bold: true });
  ['1st', '2nd', '3rd', '4th', '5th', '6th'].forEach((n, i) => cell(doc, L + 70 + i * colW, top, colW, 14, { fill: GREY, lines: [`${n} year`], align: 'center' }));
  top -= 14;
  for (const [label, get] of [['Name', (r) => r.name], ['Signature', (r) => (r.name ? 'Signed in the hub' : '')], ['Date', (r) => ukDate(r.date)]]) {
    cell(doc, L, top, 70, 18, { fill: GREY, lines: [label], bold: true, align: 'right' });
    for (let i = 0; i < 6; i++) {
      const r = reviews[i];
      cell(doc, L + 70 + i * colW, top, colW, 18, { lines: r ? wrapped(get(r), label === 'Signature' ? 6.5 : 7.5, colW - PAD * 2).slice(0, 2) : [], size: label === 'Signature' ? 6.5 : 7.5, colour: label === 'Signature' ? MUTED : INK, align: 'center' });
    }
    top -= 18;
  }
  top -= 6;

  // Hazards: the nine pictograms, the ones that apply marked.
  need(96);
  cell(doc, L, top, W, 12, { fill: GREY, lines: [{ text: 'HAZARDS (GHS pictograms on the label or data sheet)', bold: true, size: 7.5 }] });
  top -= 12;
  const hW = W / HAZARDS.length;
  HAZARDS.forEach(([k, label], i) => {
    const on = (d.hazards || []).includes(k);
    cell(doc, L + i * hW, top, hW, 62, {});
    diamond(doc, L + i * hW + hW / 2, top - 31, 26, on, label);
    cell(doc, L + i * hW, top - 62, hW, 14, {});
    if (on) mark(doc, L + i * hW + hW / 2, top - 69, true);
  });
  top -= 76;

  // PPE.
  const ppe = (d.ppe || []).map((k) => PPE.find(([x]) => x === k)?.[1]).filter(Boolean);
  const ppeText = ppe.length ? ppe.join(', ') : 'None';
  h = heightFor([[`${ppeText}${d.ppeNote ? `. ${d.ppeNote}` : ''}`, W, true]], 9, 18);
  need(14 + h);
  cell(doc, L, top, W, 14, { fill: GREY, lines: [{ text: 'PPE requirements are mainly for handling concentrated product. Note: some personnel may prefer to use PPE beyond the minimum requirements.', size: 6.6 }] });
  top -= 14;
  cell(doc, L, top, W, h, { lines: wrapped(`${ppeText}${d.ppeNote ? `. ${d.ppeNote}` : ''}`, 9, W - PAD * 2, true), size: 9, bold: true, align: 'center' });
  top -= h;

  // First aid.
  const fa = d.firstAid || {};
  const faL = 55;
  const faW = (W - faL * 2) / 2;
  need(14);
  cell(doc, L, top, W, 14, { fill: GREY, lines: ['FIRST AID'], bold: true, size: 9 });
  top -= 14;
  for (const [[l1, v1], [l2, v2]] of [[['Eye contact:', fa.eye], ['Inhalation:', fa.inhalation]], [['Skin Contact:', fa.skin], ['Ingestion:', fa.ingestion]]]) {
    h = heightFor([[v1, faW], [v2, faW]], 8, 20);
    need(h);
    cell(doc, L, top, faL, h, { fill: GREY, lines: [l1], bold: true, size: 8 });
    cell(doc, L + faL, top, faW, h, { lines: wrapped(v1, 8, faW - PAD * 2), size: 8 });
    cell(doc, L + faL + faW, top, faL, h, { fill: GREY, lines: [l2], bold: true, size: 8 });
    cell(doc, L + faL * 2 + faW, top, faW, h, { lines: wrapped(v2, 8, faW - PAD * 2), size: 8 });
    top -= h;
  }

  // Precautions.
  h = heightFor([[d.precautions, W]], 8.5, 22);
  need(14 + h);
  cell(doc, L, top, W, 14, { fill: GREY, lines: ['Are any particular precautions required? Comments?'], bold: true, size: 9 });
  top -= 14;
  cell(doc, L, top, W, h, { lines: wrapped(d.precautions, 8.5, W - PAD * 2) });
  top -= h;

  // Disposal.
  need(14 + 26);
  cell(doc, L, top, W, 14, { fill: GREY, lines: ['DISPOSAL'], bold: true, size: 9 });
  top -= 14;
  const dW = W / DISPOSAL.length;
  DISPOSAL.forEach(([k, label], i) => {
    const x = L + i * dW;
    const [main, sub] = label.split(' (');
    cell(doc, x, top, dW - 20, 26, { fill: PALE, lines: [{ text: main, bold: true, size: 7.5 }, ...(sub ? [{ text: `(${sub}`, size: 6 }] : [])], align: 'center' });
    cell(doc, x + dW - 20, top, 20, 26, {});
    mark(doc, x + dW - 10, top - 13, (d.disposal || []).includes(k));
  });
  top -= 30;

  // The three questions.
  need(13 * 4);
  const qs = [['HAVE STAFF RECEIVED SUFFICIENT INFORMATION RELATING TO THE PRODUCT UNDER ASSESSMENT?', d.infoGiven], ['IS ANY TRAINING REQUIRED?', d.training], ['ARE HEALTH SURVEILLANCE CONTROLS REQUIRED?', d.surveillance]];
  const yW = 34;
  cell(doc, L, top, W - yW * 2, 12, { fill: GREY, lines: [] });
  cell(doc, L + W - yW * 2, top, yW, 12, { fill: GREY, lines: ['YES'], bold: true, size: 7.5, align: 'center' });
  cell(doc, L + W - yW, top, yW, 12, { fill: GREY, lines: ['NO'], bold: true, size: 7.5, align: 'center' });
  top -= 12;
  for (const [q, a] of qs) {
    cell(doc, L, top, W - yW * 2, 13, { fill: GREY, lines: [q], bold: true, size: 7 });
    cell(doc, L + W - yW * 2, top, yW, 13, {});
    cell(doc, L + W - yW, top, yW, 13, {});
    if (a === 'yes') mark(doc, L + W - yW * 1.5, top - 6.5, true);
    if (a === 'no') mark(doc, L + W - yW * 0.5, top - 6.5, true);
    top -= 13;
  }
  need(24);
  cell(doc, L, top, W, 24, { fill: GREY, lines: [{ text: 'Fire Precautions; Spillage Procedure; Health Effects; Safety & Risk Phrases and other information, is contained in', bold: true, size: 7, colour: BLUE },
    { text: 'the associated Material Safety Datasheet (reference number(s) shown at the top of this assessment)', bold: true, size: 7, colour: BLUE }], align: 'center' });
  top -= 24;

  // Each page's foot.
  const total = doc.pages.length;
  doc.pages.forEach((ops, i) => {
    doc.ops = ops;
    doc.text(`Made in Promtek Hub${item.assessedOn ? `, assessed ${ukDate(item.assessedOn)}` : ''}${(d.reviews || []).length ? `, last reviewed ${ukDate(d.reviews.at(-1).date)}` : ''}`, M, 16, { size: 7, colour: MUTED });
    doc.text(`${i + 1} / ${total}`, M, 16, { size: 7, colour: MUTED, align: 'right', width: W });
  });
  return doc.toBytes();
}
