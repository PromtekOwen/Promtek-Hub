// The obsolescence survey as a PDF, in the same house style as the risk
// assessment: banner, part headings, tinted cards and coloured status pills.
import { Pdf, A4, wrap, widthOf } from './pdf.js';
import { LOGO } from './logo.js';
import { SECTIONS } from './obs-data.js';

const BLUE = [0.055, 0.384, 0.576];
const BLUE_BRIGHT = [0, 0.553, 0.776];
const TINT = [0.945, 0.969, 0.984];
const INK = [0.059, 0.169, 0.239];
const MUTED = [0.404, 0.49, 0.557];
const LINE = [0.886, 0.914, 0.937];
const GREEN = [0.122, 0.478, 0.302];
const AMBER = [0.78, 0.55, 0.05];
const RED = [0.7, 0.15, 0.12];
const GREY = [0.55, 0.6, 0.64];
const WHITE = [1, 1, 1];

const BAND = 96;
const CONDITION_COLOURS = {
  'Active': GREEN,
  'Active mature': AMBER,
  'Obsolete': RED,
  'End of life': RED,
};

const conditionColour = (value) => CONDITION_COLOURS[value] || GREY;

function header(doc, survey) {
  const { margin, contentWidth } = doc;
  doc.rect(0, A4.height - BAND, A4.width, BAND, { fill: BLUE });
  doc.rect(0, A4.height - BAND - 4, A4.width, 4, { fill: BLUE_BRIGHT });

  const logoHeight = 34;
  const logoWidth = (LOGO.width / LOGO.height) * logoHeight;
  doc.image('Logo', margin, A4.height - 54, logoWidth, logoHeight);

  const textX = margin + logoWidth + 14;
  doc.text('Obsolescence Survey', textX, A4.height - 34, { size: 15, bold: true, colour: WHITE });
  doc.text(survey.title?.client || 'Client not recorded', textX, A4.height - 48, { size: 10, colour: [0.79, 0.89, 0.95] });

  const label = survey.title?.contractNo || survey.reportKey || 'No contract';
  const width = widthOf(label, 10, true) + 20;
  doc.roundRect(margin + contentWidth - width, A4.height - 40, width, 19, 9.5, { fill: WHITE });
  doc.text(label, margin + contentWidth - width + 10, A4.height - 34, { size: 10, bold: true, colour: BLUE });
  doc.text(survey.title?.date || '', margin, A4.height - 54, {
    size: 9, colour: [0.79, 0.89, 0.95], align: 'right', width: contentWidth,
  });
  doc.y = A4.height - BAND - 22;
}

function partTitle(doc, number, name, note) {
  doc.space(52, () => header(doc, doc._survey));
  const y = doc.y;
  doc.roundRect(doc.margin, y - 15, 44, 17, 8.5, { fill: TINT });
  doc.text(`Part ${number}`, doc.margin, y - 10, { size: 8.5, bold: true, colour: BLUE, align: 'center', width: 44 });
  doc.text(name, doc.margin + 54, y - 10, { size: 12.5, bold: true, colour: INK });
  if (note) doc.text(note, doc.margin, y - 10, { size: 9, colour: MUTED, align: 'right', width: doc.contentWidth });
  doc.line(doc.margin, y - 24, doc.margin + doc.contentWidth, y - 24, { colour: LINE });
  doc.y = y - 36;
}

function detailsBlock(doc, survey) {
  const t = survey.title || {};
  const rows = [
    ['Client', t.client], ['Contract number', t.contractNo],
    // The old job number field only existed to steer the Apps Script upload.
    ['Jira reference', survey.reportKey || t.jobNo], ['Site contact', t.siteContact],
    ['Engineer', t.engineer], ['Date of survey', t.date],
  ];
  const gap = 10;
  const cardWidth = (doc.contentWidth - gap) / 2;
  rows.forEach((row, i) => {
    const x = doc.margin + (i % 2) * (cardWidth + gap);
    const y = doc.y - Math.floor(i / 2) * 44;
    doc.roundRect(x, y - 38, cardWidth, 38, 8, { fill: TINT });
    doc.text(row[0], x + 12, y - 14, { size: 8, colour: MUTED });
    doc.text(wrap(row[1] || 'Not recorded', 10.5, cardWidth - 24, true)[0], x + 12, y - 28, { size: 10.5, bold: true });
  });
  doc.y -= Math.ceil(rows.length / 2) * 44 + 2;
}

// A count of everything by condition, so the state of the site is clear at a glance.
function summaryBlock(doc, survey) {
  const counts = new Map();
  let total = 0;
  for (const section of SECTIONS) {
    for (const item of survey[section.id] || []) {
      const parts = section.cards ? (item.cards || []) : [item];
      for (const part of parts) {
        if (section.cards && !part.partNo) continue;
        const status = part.status || 'Not assessed';
        counts.set(status, (counts.get(status) || 0) + 1);
        total++;
      }
    }
  }
  const order = ['Obsolete', 'End of life', 'Active mature', 'Active', 'Not assessed'];
  const shown = order.filter((key) => counts.has(key)).map((key) => [key, counts.get(key)]);

  const gap = 8;
  const cardWidth = (doc.contentWidth - gap * (shown.length - 1 || 1)) / (shown.length || 1);
  shown.forEach(([status, count], i) => {
    const x = doc.margin + i * (cardWidth + gap);
    doc.roundRect(x, doc.y - 44, cardWidth, 44, 8, { fill: TINT });
    doc.rect(x + 1, doc.y - 38, 3.5, 32, { fill: conditionColour(status) });
    doc.text(String(count), x + 14, doc.y - 24, { size: 17, bold: true });
    doc.text(status, x + 14, doc.y - 36, { size: 8.5, colour: MUTED });
  });
  doc.y -= 52;
  doc.text(`${total} item${total === 1 ? '' : 's'} recorded across the site.`, doc.margin, doc.y, { size: 9.5, colour: MUTED });
  doc.y -= 18;
}

// One item: its name, condition, fields in two columns, and any comment.
function itemBlock(doc, survey, label, status, fields, comment, condition) {
  const pairs = fields.filter(([, value]) => String(value || '').trim());
  const colWidth = (doc.contentWidth - 28) / 2;
  const rowsHigh = Math.ceil(pairs.length / 2);
  const commentLines = comment ? wrap(comment, 9, doc.contentWidth - 28) : [];
  const height = 34 + rowsHigh * 24 + (commentLines.length ? commentLines.length * 12 + 14 : 0);

  doc.space(height + 10, () => header(doc, survey));
  const y = doc.y;
  doc.roundRect(doc.margin, y - height, doc.contentWidth, height, 9, { fill: WHITE, stroke: LINE });
  doc.rect(doc.margin + 1, y - height + 8, 3.5, height - 16, { fill: conditionColour(status) });

  doc.text(wrap(label, 11, doc.contentWidth - 150, true)[0], doc.margin + 16, y - 20, { size: 11, bold: true });
  const pillText = status || 'Not assessed';
  const pillWidth = widthOf(pillText, 8.5, true) + 18;
  doc.pill(pillText, doc.margin + doc.contentWidth - pillWidth - 12, y - 24, {
    fill: conditionColour(status), size: 8.5, height: 15, padding: 9,
  });
  if (condition) {
    doc.text(condition, doc.margin + doc.contentWidth - pillWidth - 12, y - 36, {
      size: 8, colour: MUTED, align: 'right', width: pillWidth,
    });
  }

  pairs.forEach(([name, value], i) => {
    const x = doc.margin + 16 + (i % 2) * (colWidth + 12);
    const rowY = y - 38 - Math.floor(i / 2) * 24;
    doc.text(name, x, rowY, { size: 7.5, colour: MUTED });
    doc.text(wrap(String(value), 9.5, colWidth - 8)[0], x, rowY - 11, { size: 9.5 });
  });

  if (commentLines.length) {
    const commentY = y - 38 - rowsHigh * 24;
    doc.line(doc.margin + 14, commentY + 8, doc.margin + doc.contentWidth - 14, commentY + 8, { colour: LINE });
    commentLines.forEach((line, i) => doc.text(line, doc.margin + 16, commentY - 2 - i * 12, { size: 9, colour: MUTED }));
  }
  doc.y = y - height - 8;
}

function emptyBlock(doc, text) {
  doc.roundRect(doc.margin, doc.y - 26, doc.contentWidth, 28, 8, { fill: TINT });
  doc.text(text, doc.margin + 14, doc.y - 16, { size: 9.5, colour: MUTED });
  doc.y -= 38;
}

function sparesBlock(doc, survey, spares) {
  const rows = spares.filter((s) => s.description);
  if (!rows.length) return emptyBlock(doc, 'No critical spares recorded.');

  const widths = [doc.contentWidth - 210, 110, 100];
  doc.text('Spare', doc.margin + 6, doc.y, { size: 8, colour: MUTED });
  doc.text('Area', doc.margin + widths[0] + 6, doc.y, { size: 8, colour: MUTED });
  doc.text('In stock', doc.margin + widths[0] + widths[1] + 6, doc.y, { size: 8, colour: MUTED });
  doc.y -= 12;

  rows.forEach((spare, i) => {
    doc.space(24, () => header(doc, survey));
    const y = doc.y;
    if (i % 2 === 0) doc.roundRect(doc.margin, y - 14, doc.contentWidth, 22, 6, { fill: TINT });
    doc.text(wrap(spare.description, 9.5, widths[0] - 12)[0], doc.margin + 6, y - 8, { size: 9.5 });
    doc.text(spare.area || '—', doc.margin + widths[0] + 6, y - 8, { size: 9.5, colour: MUTED });
    const stock = spare.inStock || 'Not checked';
    const colour = stock === 'Yes' ? GREEN : stock === 'No' ? RED : GREY;
    doc.pill(stock, doc.margin + widths[0] + widths[1] + 6, y - 12, { fill: colour, size: 8, height: 14, padding: 8 });
    doc.y = y - 24;
  });
  doc.y -= 6;
}

export async function buildSurveyPdf(survey) {
  const doc = new Pdf({ title: `Obsolescence Survey ${survey.title?.client || ''}`.trim() });
  doc.addJpeg('Logo', LOGO);
  doc._survey = survey;
  header(doc, survey);

  partTitle(doc, 1, 'Site and survey');
  detailsBlock(doc, survey);

  partTitle(doc, 2, 'What was found');
  summaryBlock(doc, survey);

  let part = 3;
  for (const section of SECTIONS) {
    const items = (survey[section.id] || []).filter((item) => section.cards
      ? (item.cards || []).some((c) => c.partNo || c.comments)
      : Object.entries(item).some(([key, value]) => key !== 'label' && String(value || '').trim()));

    if (section.spares) {
      partTitle(doc, part++, section.name, `${items.length} item${items.length === 1 ? '' : 's'}`);
      sparesBlock(doc, survey, survey[section.id] || []);
      continue;
    }

    partTitle(doc, part++, section.name, `${items.length} item${items.length === 1 ? '' : 's'}`);
    if (!items.length) {
      emptyBlock(doc, `Nothing recorded for ${section.name.toLowerCase()}.`);
      continue;
    }

    for (const item of items) {
      if (section.cards) {
        doc.space(30, () => header(doc, survey));
        doc.text(item.label || 'PLC panel', doc.margin, doc.y - 4, { size: 11, bold: true, colour: BLUE });
        doc.y -= 18;
        for (const card of item.cards || []) {
          if (!card.partNo && !card.comments) continue;
          itemBlock(doc, survey, card.title || card.cardType || 'Card', card.status,
            [['Manufacturer', card.manufacturer], ['Part number', card.partNo], ['Card type', card.cardType],
              ['Control voltage', card.voltage], ['Density / I/O', card.density], ['Serial number', card.serialNo]],
            card.comments, card.condition);
        }
        continue;
      }
      itemBlock(doc, survey, item.label || section.name, item.status,
        section.fields.map(([key, label]) => [label, item[key]]), item.comments, item.condition);
    }
  }

  if (survey.notes) {
    partTitle(doc, part++, 'Engineer notes');
    const lines = wrap(survey.notes, 9.5, doc.contentWidth - 28);
    const height = lines.length * 13 + 26;
    doc.space(height + 10, () => header(doc, survey));
    doc.roundRect(doc.margin, doc.y - height, doc.contentWidth, height, 8, { fill: WHITE, stroke: LINE });
    lines.forEach((line, i) => doc.text(line, doc.margin + 14, doc.y - 20 - i * 13, { size: 9.5 }));
    doc.y -= height + 8;
  }

  const total = doc.pages.length;
  doc.pages.forEach((ops, i) => {
    doc.ops = ops;
    doc.line(doc.margin, 52, doc.margin + doc.contentWidth, 52, { colour: LINE });
    doc.text(`Promtek Hub — survey completed ${survey.completedAt || survey.title?.date || ''}`, doc.margin, 40, { size: 8, colour: MUTED });
    doc.text(`${i + 1} / ${total}`, doc.margin, 40, { size: 8, colour: MUTED, align: 'right', width: doc.contentWidth });
  });

  return doc.toBytes();
}
