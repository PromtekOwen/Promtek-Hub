// Lays out the point of work risk assessment as a PDF.
import { Pdf, A4, wrap, widthOf } from './pdf.js';
import { LOGO } from './logo.js';
import { BEFORE_QUESTIONS, PPE_ITEMS, HAZARDS, REVIEW_QUESTIONS, labelOf } from './pow-data.js';

const BLUE = [0.055, 0.384, 0.576];
const BLUE_BRIGHT = [0, 0.553, 0.776];
const TINT = [0.945, 0.969, 0.984];
const INK = [0.059, 0.169, 0.239];
const MUTED = [0.404, 0.49, 0.557];
const LINE = [0.886, 0.914, 0.937];
const GREEN = [0.122, 0.478, 0.302];
const AMBER = [0.78, 0.55, 0.05];
const RED = [0.7, 0.15, 0.12];
const WHITE = [1, 1, 1];

const BAND = 96;
const RISK_COLOURS = { Low: GREEN, Medium: AMBER, High: RED };

function header(doc, form) {
  const { margin, contentWidth } = doc;
  doc.rect(0, A4.height - BAND, A4.width, BAND, { fill: BLUE });
  doc.rect(0, A4.height - BAND - 4, A4.width, 4, { fill: BLUE_BRIGHT });

  const logoHeight = 34;
  const logoWidth = (LOGO.width / LOGO.height) * logoHeight;
  doc.image('Logo', margin, A4.height - 54, logoWidth, logoHeight);

  const textX = margin + logoWidth + 14;
  doc.text('Point of Work Risk Assessment', textX, A4.height - 34, { size: 15, bold: true, colour: WHITE });
  doc.text(form.details.customer || 'Customer not recorded', textX, A4.height - 48, { size: 10, colour: [0.79, 0.89, 0.95] });

  const job = form.details.jobNo || 'No job number';
  const jobWidth = widthOf(job, 10, true) + 20;
  doc.roundRect(margin + contentWidth - jobWidth, A4.height - 40, jobWidth, 19, 9.5, { fill: WHITE });
  doc.text(job, margin + contentWidth - jobWidth + 10, A4.height - 34, { size: 10, bold: true, colour: BLUE });
  doc.text(form.details.date || '', margin, A4.height - 54, {
    size: 9, colour: [0.79, 0.89, 0.95], align: 'right', width: contentWidth,
  });

  doc.y = A4.height - BAND - 22;
}

function partTitle(doc, number, name) {
  doc.space(48, () => header(doc, doc._form));
  const y = doc.y;
  doc.roundRect(doc.margin, y - 15, 44, 17, 8.5, { fill: TINT });
  doc.text(`Part ${number}`, doc.margin, y - 10, { size: 8.5, bold: true, colour: BLUE, align: 'center', width: 44 });
  doc.text(name, doc.margin + 54, y - 10, { size: 12.5, bold: true, colour: INK });
  doc.line(doc.margin, y - 24, doc.margin + doc.contentWidth, y - 24, { colour: LINE });
  doc.y = y - 36;
}

function tick(doc, x, y, on, colour, size = 11) {
  doc.roundRect(x, y, size, size, 3, { fill: on ? colour : WHITE, stroke: on ? colour : LINE });
  if (on) {
    doc.line(x + 2.6, y + size / 2, x + size / 2 - 0.4, y + 2.8, { colour: WHITE, lineWidth: 1.5 });
    doc.line(x + size / 2 - 0.4, y + 2.8, x + size - 2.4, y + size - 2.8, { colour: WHITE, lineWidth: 1.5 });
  }
}

function detailsBlock(doc, form) {
  const rows = [
    ['Engineer', form.details.engineer],
    ['Customer', form.details.customer],
    ['Job number', form.details.jobNo || 'Added later'],
    ['Date on site', form.details.date],
    ['Site', form.details.site],
    ['Contact', [form.details.contact, form.details.contactPhone].filter(Boolean).join(', ')],
  ];
  const gap = 10;
  const cardWidth = (doc.contentWidth - gap) / 2;
  rows.forEach((row, i) => {
    const x = doc.margin + (i % 2) * (cardWidth + gap);
    const y = doc.y - Math.floor(i / 2) * 48;
    doc.roundRect(x, y - 42, cardWidth, 42, 8, { fill: TINT });
    doc.text(row[0], x + 12, y - 14, { size: 8, colour: MUTED });
    const lines = wrap(row[1] || 'Not recorded', 10, cardWidth - 24, true).slice(0, 2);
    lines.forEach((line, n) => doc.text(line, x + 12, y - 28 - n * 12, { size: 10, bold: true }));
  });
  doc.y -= Math.ceil(rows.length / 2) * 48 + 2;
}

function beforeBlock(doc, form) {
  const answers = form.before || {};
  const colX = [doc.margin + doc.contentWidth - 118, doc.margin + doc.contentWidth - 74, doc.margin + doc.contentWidth - 30];
  ['Yes', 'No', 'N/A'].forEach((label, i) => doc.text(label, colX[i] - 3, doc.y, { size: 8, colour: MUTED }));
  doc.y -= 14;

  let flagged = 0;
  BEFORE_QUESTIONS.forEach(([key, question], i) => {
    doc.space(26, () => header(doc, form));
    const answer = answers[key] || 'na';
    if (answer === 'no') flagged++;
    const y = doc.y;
    if (i % 2 === 0) doc.roundRect(doc.margin, y - 14, doc.contentWidth, 22, 6, { fill: TINT });
    doc.paragraph(question, doc.margin + 12, y, doc.contentWidth - 140, { size: 9.5 });
    tick(doc, colX[0], y - 8, answer === 'yes', GREEN, 10);
    tick(doc, colX[1], y - 8, answer === 'no', RED, 10);
    tick(doc, colX[2], y - 8, answer === 'na', MUTED, 10);
    doc.y = y - 24;
  });

  if (flagged) {
    doc.space(34, () => header(doc, form));
    doc.roundRect(doc.margin, doc.y - 22, doc.contentWidth, 26, 8, { fill: [1, 0.965, 0.906] });
    doc.rect(doc.margin, doc.y - 22, 3.5, 26, { fill: AMBER });
    doc.text(`${flagged} answer${flagged > 1 ? 's' : ''} marked "No" — action taken or reported before starting work.`,
      doc.margin + 14, doc.y - 13, { size: 9, bold: true, colour: [0.55, 0.36, 0.02] });
    doc.y -= 34;
  }
}

function chips(doc, items, selected, columns = 3) {
  const gap = 8;
  const colWidth = (doc.contentWidth - gap * (columns - 1)) / columns;
  for (let start = 0; start < items.length; start += columns) {
    doc.space(28, () => header(doc, doc._form));
    const y = doc.y;
    items.slice(start, start + columns).forEach(([id, label], column) => {
      const x = doc.margin + column * (colWidth + gap);
      const on = selected.includes(id);
      doc.roundRect(x, y - 16, colWidth, 20, 10, { fill: on ? GREEN : WHITE, stroke: on ? GREEN : LINE });
      doc.text(label, x + 14, y - 10, { size: 9, bold: on, colour: on ? WHITE : MUTED });
    });
    doc.y = y - 24;
  }
  doc.y -= 2;
}

function significantBlock(doc, form) {
  const entries = (form.significant || []).filter((e) => e.hazard);
  if (!entries.length) {
    doc.roundRect(doc.margin, doc.y - 24, doc.contentWidth, 28, 8, { fill: TINT });
    doc.text('No hazards were judged significant on this job.', doc.margin + 14, doc.y - 14, { size: 9.5, colour: MUTED });
    doc.y -= 36;
    return;
  }
  for (const entry of entries) {
    const risk = entry.risk || 'Low';
    const colour = RISK_COLOURS[risk] || MUTED;
    const controlWidth = doc.contentWidth - 190;
    const controlLines = wrap(entry.control || 'Not recorded', 9.5, controlWidth);
    const height = Math.max(62, controlLines.length * 13 + 34);
    doc.space(height + 12, () => header(doc, form));
    const y = doc.y;

    doc.roundRect(doc.margin, y - height, doc.contentWidth, height, 9, { fill: TINT });
    doc.rect(doc.margin + 1, y - height + 8, 3.5, height - 16, { fill: colour });
    doc.text(wrap(labelOf(HAZARDS, entry.hazard), 10.5, 128, true)[0], doc.margin + 16, y - 20, { size: 10.5, bold: true });
    doc.text('Remaining risk', doc.margin + 16, y - 36, { size: 8, colour: MUTED });
    doc.pill(risk, doc.margin + 16, y - 54, { fill: colour, size: 8.5, height: 15 });

    doc.text('Control measures and precautions', doc.margin + 170, y - 18, { size: 8, colour: MUTED });
    controlLines.forEach((line, i) => doc.text(line, doc.margin + 170, y - 32 - i * 13, { size: 9.5 }));
    doc.y = y - height - 8;
  }
}

function listBlock(doc, values, empty) {
  if (!values.length) {
    doc.text(empty, doc.margin + 2, doc.y - 8, { size: 9.5, colour: MUTED });
    doc.y -= 24;
    return;
  }
  const gap = 8;
  const cardWidth = (doc.contentWidth - gap) / 2;
  values.forEach((value, i) => {
    const x = doc.margin + (i % 2) * (cardWidth + gap);
    const y = doc.y - Math.floor(i / 2) * 24;
    doc.roundRect(x, y - 18, cardWidth, 20, 6, { fill: WHITE, stroke: LINE });
    doc.roundRect(x + 10, y - 11.5, 5, 5, 2.5, { fill: BLUE_BRIGHT });
    doc.text(wrap(value, 9, cardWidth - 32)[0], x + 22, y - 12, { size: 9 });
  });
  doc.y -= Math.ceil(values.length / 2) * 24 + 2;
}

function reviewBlock(doc, form) {
  const review = form.review || {};
  const noteLines = review.note ? wrap(review.note, 9.5, doc.contentWidth - 28).length : 0;
  doc.space(REVIEW_QUESTIONS.length * 26 + (noteLines ? noteLines * 13 + 38 : 0), () => header(doc, form));
  REVIEW_QUESTIONS.forEach(([key, question], i) => {
    doc.space(28, () => header(doc, form));
    const y = doc.y;
    if (i % 2 === 0) doc.roundRect(doc.margin, y - 15, doc.contentWidth, 24, 6, { fill: TINT });
    doc.paragraph(question, doc.margin + 12, y, doc.contentWidth - 110, { size: 9.5 });
    const yes = review[key] === 'yes';
    doc.pill(yes ? 'Yes' : 'No', doc.margin + doc.contentWidth - 64, y - 12, {
      fill: yes ? AMBER : [0.87, 0.91, 0.94], textColour: yes ? WHITE : INK, size: 9, height: 16, padding: 16,
    });
    doc.y = y - 26;
  });
  if (review.note) {
    const lines = wrap(review.note, 9.5, doc.contentWidth - 28);
    const height = lines.length * 13 + 28;
    doc.space(height + 10, () => header(doc, form));
    doc.roundRect(doc.margin, doc.y - height, doc.contentWidth, height, 8, { fill: WHITE, stroke: LINE });
    doc.text('Notes', doc.margin + 14, doc.y - 15, { size: 8, colour: MUTED });
    lines.forEach((line, i) => doc.text(line, doc.margin + 14, doc.y - 30 - i * 13, { size: 9.5 }));
    doc.y -= height + 6;
  }
}

function signBlock(doc, form) {
  const sign = form.signoff || {};
  const gap = 12;
  const cardWidth = (doc.contentWidth - gap) / 2;
  const cards = [
    ['Promtek', sign.promtekName || form.details.engineer, sign.promtekPosition || 'Engineer', 'Completed', form.completedAt],
    ['Customer', sign.customerName, sign.customerPosition, 'Email', sign.customerEmail],
  ];
  doc.space(124, () => header(doc, form));
  cards.forEach((card, i) => {
    const x = doc.margin + i * (cardWidth + gap);
    const y = doc.y;
    doc.roundRect(x, y - 104, cardWidth, 104, 9, { fill: i === 0 ? TINT : WHITE, stroke: i === 0 ? null : LINE });
    doc.pill(card[0], x + 12, y - 27, { fill: i === 0 ? BLUE : MUTED, size: 8.5, height: 15 });
    doc.text('Name', x + 12, y - 46, { size: 8, colour: MUTED });
    doc.text(wrap(card[1] || 'Not given', 11, cardWidth - 24, true)[0], x + 12, y - 60, { size: 11, bold: true });
    doc.text('Position', x + 12, y - 74, { size: 8, colour: MUTED });
    doc.text(wrap(card[2] || 'Not given', 9.5, cardWidth - 24)[0], x + 12, y - 86, { size: 9.5 });
    doc.text(card[3], x + 12, y - 98, { size: 8, colour: MUTED });
    doc.text(wrap(card[4] || 'Not given', 9, cardWidth - 24 - widthOf(card[3], 8) - 8)[0],
      x + 16 + widthOf(card[3], 8), y - 98, { size: 9 });
  });
  doc.y -= 112;
}

export async function buildPowPdf(form) {
  const doc = new Pdf({ title: `Point of Work Risk Assessment ${form.details.jobNo || ''}`.trim() });
  doc.addJpeg('Logo', LOGO);
  doc._form = form;
  header(doc, form);

  partTitle(doc, 1, 'Details');
  detailsBlock(doc, form);

  partTitle(doc, 2, 'Stop — before you start');
  beforeBlock(doc, form);

  partTitle(doc, 3, 'PPE used');
  chips(doc, PPE_ITEMS, form.ppe || []);

  partTitle(doc, 4, 'Think — hazards present');
  chips(doc, HAZARDS, form.hazards || []);

  partTitle(doc, 5, 'Significant hazards and controls');
  significantBlock(doc, form);

  partTitle(doc, 6, 'Risk assessments and safe systems of work used');
  listBlock(doc, form.ras || [], 'None recorded.');

  partTitle(doc, 7, 'End of job review');
  reviewBlock(doc, form);

  partTitle(doc, 8, 'Sign off');
  signBlock(doc, form);

  const total = doc.pages.length;
  doc.pages.forEach((ops, i) => {
    doc.ops = ops;
    doc.line(doc.margin, 52, doc.margin + doc.contentWidth, 52, { colour: LINE });
    doc.text(`Promtek Hub — completed ${form.completedAt || ''}`, doc.margin, 40, { size: 8, colour: MUTED });
    doc.text(`${i + 1} / ${total}`, doc.margin, 40, { size: 8, colour: MUTED, align: 'right', width: doc.contentWidth });
  });

  return doc.toBytes();
}
