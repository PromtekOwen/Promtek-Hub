// A very small PDF writer: enough for clean, tabular documents, with no
// dependencies, so it runs inside a Worker.

// Widths of Helvetica characters 32-126, in 1/1000 em.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD_W = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

export const A4 = { width: 595.28, height: 841.89 };

const SUBSTITUTIONS = [
  [/[\u2018\u2019\u201B]/g, "'"], [/[\u201C\u201D]/g, '"'], [/[\u2013\u2014]/g, '-'],
  [/\u2026/g, '...'], [/\u00a0/g, ' '], [/\u2022/g, '-'], [/[\u00d7\u2715]/g, 'x'],
];

function clean(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  // Keep to characters the standard font can show.
  return out.replace(/[^\x20-\x7E\u00a3\u00b0\u00e9\u00e8]/g, ' ');
}

export function widthOf(text, size, bold = false) {
  const widths = bold ? BOLD_W : W;
  let total = 0;
  for (const ch of clean(text)) {
    const code = ch.charCodeAt(0);
    total += (code >= 32 && code <= 126 ? widths[code - 32] : 556);
  }
  return (total / 1000) * size;
}

export function wrap(text, size, maxWidth, bold = false) {
  const lines = [];
  for (const paragraph of clean(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, size, bold) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

const escapeText = (text) => clean(text).replace(/([\\()])/g, '\\$1');
const round = (n) => Math.round(n * 100) / 100;

export class Pdf {
  constructor({ size = A4, margin = 36, title = 'Document' } = {}) {
    this.images = new Map();
    this.size = size;
    this.margin = margin;
    this.title = title;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.size.height - this.margin;
    return this;
  }

  get contentWidth() { return this.size.width - this.margin * 2; }

  // Starts a new page when the next block wouldn't fit.
  space(height, onNewPage) {
    if (this.y - height < this.margin + 42) {
      this.newPage();
      if (onNewPage) onNewPage();
    }
    return this.y;
  }

  colour(rgb, stroke = false) {
    const [r, g, b] = rgb;
    this.ops.push(`${round(r)} ${round(g)} ${round(b)} ${stroke ? 'RG' : 'rg'}`);
    return this;
  }

  rect(x, y, width, height, { fill = null, stroke = null, lineWidth = 0.7 } = {}) {
    if (fill) this.colour(fill);
    if (stroke) { this.colour(stroke, true); this.ops.push(`${round(lineWidth)} w`); }
    this.ops.push(`${round(x)} ${round(y)} ${round(width)} ${round(height)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    return this;
  }

  // Rounded rectangle, drawn with four bezier corners.
  roundRect(x, y, width, height, radius, { fill = null, stroke = null, lineWidth = 0.7 } = {}) {
    const r = Math.min(radius, width / 2, height / 2);
    const k = r * 0.5523;
    if (fill) this.colour(fill);
    if (stroke) { this.colour(stroke, true); this.ops.push(`${round(lineWidth)} w`); }
    this.ops.push(
      `${round(x + r)} ${round(y)} m`,
      `${round(x + width - r)} ${round(y)} l`,
      `${round(x + width - r + k)} ${round(y)} ${round(x + width)} ${round(y + r - k)} ${round(x + width)} ${round(y + r)} c`,
      `${round(x + width)} ${round(y + height - r)} l`,
      `${round(x + width)} ${round(y + height - r + k)} ${round(x + width - r + k)} ${round(y + height)} ${round(x + width - r)} ${round(y + height)} c`,
      `${round(x + r)} ${round(y + height)} l`,
      `${round(x + r - k)} ${round(y + height)} ${round(x)} ${round(y + height - r + k)} ${round(x)} ${round(y + height - r)} c`,
      `${round(x)} ${round(y + r)} l`,
      `${round(x)} ${round(y + r - k)} ${round(x + r - k)} ${round(y)} ${round(x + r)} ${round(y)} c`,
      fill && stroke ? 'B' : fill ? 'f' : 'S',
    );
    return this;
  }

  // A rounded label, sized to its text.
  pill(text, x, y, { size = 9, bold = true, fill, textColour = [1, 1, 1], padding = 8, height = 16 } = {}) {
    const width = widthOf(text, size, bold) + padding * 2;
    this.roundRect(x, y, width, height, height / 2, { fill });
    this.text(text, x + padding, y + (height - size) / 2 + 2, { size, bold, colour: textColour });
    return width;
  }

  image(name, x, y, width, height) {
    this.ops.push(`q ${round(width)} 0 0 ${round(height)} ${round(x)} ${round(y)} cm /${name} Do Q`);
    return this;
  }

  line(x1, y1, x2, y2, { colour = [0.8, 0.85, 0.89], lineWidth = 0.7 } = {}) {
    this.colour(colour, true);
    this.ops.push(`${round(lineWidth)} w ${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`);
    return this;
  }

  text(value, x, y, { size = 10, bold = false, colour = [0.08, 0.17, 0.24], align = 'left', width = 0 } = {}) {
    let drawX = x;
    if (align !== 'left' && width) {
      const textWidth = widthOf(value, size, bold);
      drawX = align === 'center' ? x + (width - textWidth) / 2 : x + width - textWidth;
    }
    this.colour(colour);
    this.ops.push(`BT /${bold ? 'FB' : 'FR'} ${size} Tf ${round(drawX)} ${round(y)} Td (${escapeText(value)}) Tj ET`);
    return this;
  }

  // Wrapped paragraph; returns the height used.
  paragraph(value, x, y, width, { size = 10, bold = false, colour, leading = 1.35 } = {}) {
    const lines = wrap(value, size, width, bold);
    lines.forEach((line, i) => this.text(line, x, y - i * size * leading, { size, bold, colour }));
    return lines.length * size * leading;
  }

  // JPEG images go in as-is; the PDF format takes them directly.
  addJpeg(name, { base64, width, height }) {
    const binary = atob(base64);
    this.images.set(name, { binary, width, height });
    return this;
  }

  async toBytes() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const imageIds = [];
    for (const [name, image] of this.images) {
      imageIds.push([name, add(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}`
        + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.binary.length} >>`
        + `\nstream\n${image.binary}\nendstream`
      )]);
    }
    const xobjects = imageIds.length
      ? ` /XObject << ${imageIds.map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >>`
      : '';

    const pagesId = objects.length + 1 + this.pages.length * 2 + 1; // filled in below
    const pageIds = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${round(this.size.width)} ${round(this.size.height)}]`
        + ` /Resources << /Font << /FR ${fontRegular} 0 R /FB ${fontBold} 0 R >>${xobjects} >> /Contents ${contentId} 0 R >>`
      ));
    }
    const realPagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
    const infoId = add(`<< /Title (${escapeText(this.title)}) /Producer (Promtek Hub) >>`);

    // Page objects were written before the Pages object existed; fix the references.
    for (const index of pageIds) {
      objects[index - 1] = objects[index - 1].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);
    }

    let out = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const startxref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
      + `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${startxref}\n%%EOF`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
