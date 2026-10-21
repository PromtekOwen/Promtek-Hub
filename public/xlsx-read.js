// Reads the first sheet of an Excel file (.xlsx) in the browser: each cell's
// value, and its fill colour, which is how the old form's sheet marks rounds.
// An .xlsx is a ZIP of XML files, opened here without any outside code.

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

async function unzip(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) if (u32(bytes, i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That isn\'t an Excel file. Save it as .xlsx and try again.');
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== 0x02014b50) break;
    const method = u16(bytes, at + 10), size = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28), extraLen = u16(bytes, at + 30), commentLen = u16(bytes, at + 32), local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    files.set(name, { method, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + u16(bytes, f.local + 26) + u16(bytes, f.local + 28);
    const data = bytes.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    if (f.method !== 8) throw new Error('That spreadsheet is saved in a way the hub can\'t open.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
  return { names: [...files.keys()], read };
}

const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
const kids = (el, tag) => [...(el?.children || [])].filter((c) => c.localName === tag);
const all = (el, tag) => [...(el?.getElementsByTagNameNS('*', tag) || [])];

const colOf = (ref) => {
  let n = 0;
  for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// Excel keeps dates as days since 1900, in the sheet's local time (UK here).
function excelDate(serial) {
  const wall = Math.round((Number(serial) - 25569) * 86_400_000);
  const asIf = (ms, tz) => Date.parse(new Date(ms).toLocaleString('en-US', { timeZone: tz }));
  const offset = asIf(wall, 'Europe/London') - asIf(wall, 'UTC');
  return new Date(wall - offset).toISOString();
}
function textDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const serial = (Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 86_400_000) + 25569;
  return excelDate(serial);
}

export async function readSheet(file) {
  const zip = await unzip(new Uint8Array(await file.arrayBuffer()));
  // The first sheet in the workbook, wherever it's kept.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = xml(await zip.read('xl/workbook.xml'));
    const rid = all(wb, 'sheet')[0]?.getAttribute('r:id') || all(wb, 'sheet')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rels = xml(await zip.read('xl/_rels/workbook.xml.rels'));
    const target = all(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  } catch { /* the usual place */ }
  const sheetText = await zip.read(sheetPath) || await zip.read(zip.names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)));
  if (!sheetText) throw new Error('That spreadsheet has no sheets in it.');

  const strings = [];
  const ss = await zip.read('xl/sharedStrings.xml');
  if (ss) for (const si of all(xml(ss), 'si')) strings.push(all(si, 't').map((t) => t.textContent).join(''));

  // Each cell style's fill, as a short key: the same colour gives the same key.
  const fills = [];
  const xfFill = [];
  const st = await zip.read('xl/styles.xml');
  if (st) {
    const doc = xml(st);
    for (const fill of kids(all(doc, 'fills')[0], 'fill')) {
      const pattern = kids(fill, 'patternFill')[0];
      const fg = kids(pattern, 'fgColor')[0];
      const type = pattern?.getAttribute('patternType');
      if (!pattern || !type || type === 'none' || !fg) { fills.push(null); continue; }
      const key = fg.getAttribute('rgb') || (fg.getAttribute('theme') != null ? `theme${fg.getAttribute('theme')}:${fg.getAttribute('tint') || 0}` : fg.getAttribute('indexed') != null ? `indexed${fg.getAttribute('indexed')}` : null);
      fills.push(key && !/^(FF)?FFFFFF$/i.test(key) && key !== 'indexed64' ? key.toUpperCase() : null);
    }
    for (const xf of kids(all(doc, 'cellXfs')[0], 'xf')) xfFill.push(fills[Number(xf.getAttribute('fillId') || 0)] ?? null);
  }

  const rows = [];
  for (const row of all(xml(sheetText), 'row')) {
    const cells = [];
    for (const c of kids(row, 'c')) {
      const type = c.getAttribute('t');
      const v = kids(c, 'v')[0]?.textContent;
      let value = v ?? '';
      if (type === 's') value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = all(c, 't').map((t) => t.textContent).join('');
      const numeric = !type || type === 'n';
      const cell = { value, fill: xfFill[Number(c.getAttribute('s') || 0)] ?? null };
      cell.date = numeric && v && Number(v) > 20000 && Number(v) < 80000 ? excelDate(v) : textDate(value);
      cells[colOf(c.getAttribute('r'))] = cell;
    }
    rows.push(cells);
  }
  return { rows };
}
