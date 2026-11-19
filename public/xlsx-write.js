// Writes an Excel file (.xlsx) in the browser: sheets of numbers, text, money,
// percentages and dates, with fills, fonts and borders, drop-down lists, links,
// highlighting rules, frozen rows and columns and filters. An .xlsx is a ZIP of
// XML files; this one is stored without compression, which Excel and Google
// Sheets both open.

const enc = new TextEncoder();
const escXml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const head = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(head, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)]), name);
    offset += head.length + name.length + data.length;
  }
  const size = central.reduce((t, p) => t + p.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const serial = (iso) => { const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`); return Number.isNaN(ms) ? null : ms / 86_400_000 + 25569; };
export { colName };

// Number formats by name; anything else is taken as a format code.
const FORMATS = {
  money: '_([$£-809]* #,##0.00_);_([$£-809]* \\(#,##0.00\\);_([$£-809]* "-"??_);_(@_)',
  pct: '0.00%', pct0: '0%', date: 'dd/mm/yyyy', int: '0', number: '#,##0.00',
};
// The old style names, as style objects.
const NAMED = {
  text: {}, bold: { bold: true }, money: { fmt: '#,##0.00' }, pct: { fmt: 'pct0' }, date: { fmt: 'date' },
  boldMoney: { bold: true, fmt: '#,##0.00' }, boldPct: { bold: true, fmt: 'pct0' }, int: { fmt: 'int' }, boldInt: { bold: true, fmt: 'int' },
};

// The fonts, fills, borders and formats used, each kept once, and the cell styles made of them.
function registry() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const fmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const dxfs = [];
  const seen = new Map([['{}', 0]]);
  const add = (list, xml) => { const at = list.indexOf(xml); if (at >= 0) return at; list.push(xml); return list.length - 1; };
  const fontXml = (st) => `<font>${st.bold ? '<b/>' : ''}${st.italic ? '<i/>' : ''}${st.underline ? '<u/>' : ''}<sz val="${st.size || 11}"/>${st.color ? `<color rgb="FF${st.color}"/>` : ''}<name val="Calibri"/></font>`;
  const fillXml = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor rgb="FF${rgb}"/></patternFill></fill>`;
  const side = (on) => (on ? ' style="thin"><color rgb="FF000000"/></' : '/><');
  const borderXml = (b) => {
    const all = b === 'all' || b === true;
    const has = (k) => all || (Array.isArray(b) ? b.includes(k) : b === k);
    return `<border><left${side(has('left'))}left><right${side(has('right'))}right><top${side(has('top'))}top><bottom${side(has('bottom'))}bottom><diagonal/></border>`.replace(/<(\w+)\/><\1>/g, '<$1/>');
  };
  const fmtId = (f) => {
    if (!f) return 0;
    const code = FORMATS[f] || f;
    if (code === '0') return 1;
    const at = fmts.indexOf(code);
    if (at >= 0) return 164 + at;
    fmts.push(code);
    return 164 + fmts.length - 1;
  };
  return {
    style(st) {
      if (!st) return 0;
      if (typeof st === 'string') st = NAMED[st] || {};
      const key = JSON.stringify(st);
      if (seen.has(key)) return seen.get(key);
      const fontId = st.bold || st.italic || st.underline || st.color || st.size ? add(fonts, fontXml(st)) : 0;
      const fillId = st.fill ? add(fills, fillXml(st.fill)) : 0;
      const borderId = st.border ? add(borders, borderXml(st.border)) : 0;
      const numFmtId = fmtId(st.fmt);
      const align = st.align || st.wrap || st.valign ? `<alignment${st.align ? ` horizontal="${st.align}"` : ''}${st.valign ? ` vertical="${st.valign}"` : ''}${st.wrap ? ' wrapText="1"' : ''}/>` : '';
      xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`);
      seen.set(key, xfs.length - 1);
      return xfs.length - 1;
    },
    dxf({ fill, color, bold }) {
      dxfs.push(`<dxf>${color || bold ? `<font>${bold ? '<b/>' : ''}${color ? `<color rgb="FF${color}"/>` : ''}</font>` : ''}${fill ? `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor rgb="FF${fill}"/></patternFill></fill>` : ''}</dxf>`);
      return dxfs.length - 1;
    },
    xml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${fmts.length ? `<numFmts count="${fmts.length}">${fmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escXml(c)}"/>`).join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="${dxfs.length}">${dxfs.join('')}</dxfs></styleSheet>`;
    },
  };
}

function cellXml(ref, cell, reg, base) {
  const c = cell !== null && typeof cell === 'object' ? cell : { v: cell };
  const st = c.s === undefined ? base : typeof c.s === 'string' && NAMED[c.s] ? { ...base, ...NAMED[c.s] } : base ? { ...base, ...c.s } : c.s;
  const style = reg.style(st && Object.keys(st).length ? st : null);
  const sAttr = style ? ` s="${style}"` : '';
  let v = c.v;
  if ((c.s === 'date' || st?.fmt === 'date') && typeof v === 'string') v = serial(v);
  const empty = v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  if (empty) return style ? `<c r="${ref}"${sAttr}/>` : '';
  if (typeof v === 'number') return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"${sAttr}><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
}

// sheet: { name, rows: [[cell]], widths: [number], freeze: true | { rows, cols }, rowStyle: (r) => style for every cell in the row,
//   cols: how many columns rowStyle covers, validations: [{ ref, list }], highlight: [{ ref, equals, fill, color }], filter: 'A1:U40' }
// A cell is a value, or { v, s, link } with s a style ({ bold, italic, color, fill, fmt, border, align, wrap, size }) or one of the old names.
function sheetXml(sheet, reg) {
  const widths = sheet.widths || [];
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const links = [];
  const span = sheet.cols || 0;
  const rows = (sheet.rows || []).map((row, r) => {
    const base = sheet.rowStyle ? sheet.rowStyle(r, row) : null;
    const n = Math.max((row || []).length, base ? span : 0);
    let cells = '';
    for (let c = 0; c < n; c++) {
      const cell = (row || [])[c];
      const ref = `${colName(c)}${r + 1}`;
      if (cell && typeof cell === 'object' && cell.link) links.push({ ref, url: cell.link });
      cells += cellXml(ref, cell ?? null, reg, base);
    }
    const height = sheet.heights?.[r] ? ` ht="${sheet.heights[r]}" customHeight="1"` : '';
    return cells || height ? `<row r="${r + 1}"${height}>${cells}</row>` : '';
  }).join('');
  const fz = sheet.freeze === true ? { rows: 1, cols: 0 } : sheet.freeze || null;
  const top = fz ? `${colName(fz.cols || 0)}${(fz.rows || 0) + 1}` : '';
  const pane = fz ? `<pane${fz.cols ? ` xSplit="${fz.cols}"` : ''}${fz.rows ? ` ySplit="${fz.rows}"` : ''} topLeftCell="${top}" activePane="${fz.cols && fz.rows ? 'bottomRight' : fz.cols ? 'topRight' : 'bottomLeft'}" state="frozen"/>` : '';
  const views = `<sheetViews><sheetView workbookViewId="0"${sheet.selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`;
  const filter = sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : '';
  const highlight = (sheet.highlight || []).map((h, i) => `<conditionalFormatting sqref="${h.ref}"><cfRule type="cellIs" dxfId="${reg.dxf(h)}" priority="${i + 1}" operator="equal"><formula>"${escXml(String(h.equals).replace(/"/g, '""'))}"</formula></cfRule></conditionalFormatting>`).join('');
  const lists = (sheet.validations || []).filter((v) => v.list?.length);
  // A list in the rule itself is limited to 255 characters; a longer one goes on a hidden column of the sheet instead.
  const validations = lists.length ? `<dataValidations count="${lists.length}">${lists.map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${v.ref}"><formula1>${v.source ? escXml(v.source) : `"${escXml(v.list.map((x) => String(x).replace(/[",]/g, ' ')).join(','))}"`}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
  const hyper = links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '';
  return {
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${filter}${highlight}${validations}${hyper}</worksheet>`,
    rels: links.length ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escXml(l.url)}" TargetMode="External"/>`).join('')}</Relationships>` : null,
  };
}

export function writeBook(sheets) {
  const safe = sheets.map((s, i) => ({ ...s, name: String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) }));
  const reg = registry();
  const built = safe.map((s) => sheetXml(s, reg));
  const filters = safe.map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escXml(s.name.replace(/'/g, "''"))}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('');
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    ...built.flatMap((b, i) => [{ name: `xl/worksheets/sheet${i + 1}.xml`, data: b.xml }, ...(b.rels ? [{ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: b.rels }] : [])]),
    { name: 'xl/styles.xml', data: reg.xml() },
  ];
  return zip(files);
}
