// Release notes downloads, made in the browser from what the Release notes tab
// shows: a PDF in the Condor release notes template, and a ZIP with the notes as
// Markdown for the release notes page in Condor's VuePress help, with pictures.
import { Pdf, wrap, widthOf } from '/pdf.js';

const BLUE = [0, 0.553, 0.776];          // #008dc6
const TEXT = [0.2, 0.2, 0.2];             // #333333
const WHITE = [1, 1, 1];
const FOOT = [0.25, 0.25, 0.25];

export const fileBase = (name) => `Condor Release Notes - ${String(name || 'Release').replace(/[\\/:*?"<>|]+/g, ' ').trim()}`;

// ---------- pictures ----------

async function loadBitmap(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* SVG and some others need an <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

// Any picture becomes a JPEG on white, no wider than needed for a printed page.
async function toJpeg(blob, maxWidth = 1500) {
  const bmp = await loadBitmap(blob);
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, maxWidth / w0);
  const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), width, height, bytes };
}

async function fetchBlob(src) {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Picture not available (${res.status})`);
  return res.blob();
}

// Fetches each picture once, a few at a time, reporting progress.
async function gather(doc, srcFor, onProgress, convert) {
  const jobs = [];
  for (const m of doc) for (const f of m.features) for (const b of f.blocks) if (b.type === 'image') jobs.push({ it: f, b });
  const results = new Map();
  let done = 0, failed = 0;
  const run = async () => {
    while (jobs.length) {
      const { it, b } = jobs.shift();
      try { results.set(b, await convert(await fetchBlob(srcFor(it, b)), b)); } catch { failed++; }
      done++; onProgress?.(done, done + jobs.length);
    }
  };
  await Promise.all([run(), run(), run()]);
  return { results, failed };
}

// ---------- shared ----------

// "v2026.07 (Fuji)", as the help pages head each release.
export const versionTitle = (v) => (v.number ? `v${v.number} (${v.displayName || v.name})` : v.displayName || v.name);
// "MicroMan" keeps its capitals in a sentence; "Stock" doesn't.
const inSentence = (h) => (/^[A-Z][a-z]/.test(h) && !/[A-Z]/.test(h.slice(1)) ? h[0].toLowerCase() + h.slice(1) : h);
export const additionalHeading = (name) => `Additional ${inSentence(name)} improvements`;
// A paragraph can hold a list: lines starting "- " are its items.
export function pieces(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-•*]\s+(.*)$/.exec(line);
    const last = out[out.length - 1];
    if (item) { if (last?.list) last.list.push(item[1]); else out.push({ list: [item[1]] }); }
    else if (last?.para != null) last.para += `\n${line}`;
    else out.push({ para: line });
  }
  return out;
}

// ---------- PDF ----------

function footer(pdf, page, total) {
  const W = pdf.size.width, x = 40, y = 34;
  pdf.text('promtek.com', x, y + 8, { size: 7.5, bold: true, colour: FOOT });
  pdf.text('01782 375600', x, y - 1.5, { size: 7.5, bold: true, colour: FOOT });
  const line = (parts, yy) => {
    const total = parts.reduce((t, [s, b]) => t + widthOf(s, 6.5, b), 0);
    let cx = (W - total) / 2;
    for (const [s, b] of parts) { pdf.text(s, cx, yy, { size: 6.5, bold: b, colour: FOOT }); cx += widthOf(s, 6.5, b); }
  };
  line([['Registered in England & Wales ', true], ['Company Registration No: 2275192 ', false], ['VAT Number ', true], ['GB 290012302', false]], y + 8);
  line([['Registered Office ', true], ['Fisher Street, Brindley Ford, Stoke-on-Trent, Staffordshire, ST8 7QJ, United Kingdom', false]], y - 1.5);
  pdf.text('Page', W - x - 40, y + 8, { size: 7, colour: FOOT, align: 'right', width: 40 });
  const num = String(page), of = ` of ${total}`;
  const wNum = widthOf(num, 11, true), wOf = widthOf(of, 7, false);
  pdf.text(num, W - x - wNum - wOf, y - 2, { size: 11, bold: true, colour: FOOT });
  pdf.text(of, W - x - wOf, y - 2, { size: 7, colour: FOOT });
}

export async function makePdf(data, { srcFor, header, onProgress } = {}) {
  const pdf = new Pdf({ margin: 40, title: fileBase(versionTitle(data.version)) });
  const W = pdf.size.width, H = pdf.size.height, left = 40, right = W - 40, width = right - left;
  const bottom = 66;
  let y;
  const ensure = (h) => { if (y - h < bottom) { pdf.newPage(); y = H - 48; return true; } return false; };

  const { results, failed } = await gather(data.document, srcFor, onProgress, (blob) => toJpeg(blob));

  // The blue band with the logo and title, on the first page only.
  if (header) {
    const head = await toJpeg(header, 2048);
    pdf.addJpeg('Head', head);
    const hh = W * head.height / head.width;
    pdf.image('Head', 0, H - hh, W, hh);
    pdf.text(`Condor Release Notes - ${data.version.displayName || data.version.name}`, W * 0.235, H - hh / 2 - 7, { size: 20, bold: true, colour: WHITE });
    y = H - hh - 34;
  } else {
    y = H - 60;
    pdf.text(`Condor Release Notes - ${data.version.displayName || data.version.name}`, left, y, { size: 20, bold: true, colour: BLUE });
    y -= 30;
  }
  if (data.version.releaseDate) {
    pdf.text(`Expected Release Date: ${data.version.releaseDate}`, left, y, { size: 10.5, bold: true, colour: TEXT });
    y -= 34;
  }
  pdf.text(versionTitle(data.version), left, y, { size: 16, bold: true, colour: BLUE });
  y -= 18;
  const para = (text, x, w, size = 10, colour = TEXT) => {
    const lines = wrap(text, size, w);
    ensure(Math.min(lines.length, 2) * (size * 1.5));
    for (const line of lines) { ensure(size * 1.5); pdf.text(line, x, y, { size, colour }); y -= size * 1.5; }
  };
  const bullet = (text, x, w) => {
    const lines = wrap(text, 10, w - 18);
    ensure(Math.min(lines.length, 2) * 15);
    pdf.roundRect(x + 5, y + 2, 4, 4, 2, { fill: TEXT });
    for (const line of lines) { ensure(15); pdf.text(line, x + 18, y, { size: 10, colour: TEXT }); y -= 15; }
    y -= 2;
  };
  const intro = data.intro ?? data.introDefault ?? '';
  if (intro) { para(intro, left, width); y -= 6; }

  let n = 0;
  for (const m of data.document) {
    y -= 16;
    ensure(80);
    pdf.text(m.name, left, y, { size: 16, bold: true, colour: BLUE });
    y -= 10;
    // The bigger changes, each a section of its own.
    for (const f of m.features) {
      y -= 16;
      ensure(60);
      for (const line of wrap(f.title, 12.5, width, true)) { pdf.text(line, left, y, { size: 12.5, bold: true, colour: TEXT }); y -= 17; }
      y -= 2;
      for (const b of f.blocks) {
        if (b.type === 'text') {
          for (const pc of pieces(b.text)) {
            if (pc.list) pc.list.forEach((it) => bullet(it, left + 6, width - 6));
            else para(pc.para, left, width);
            y -= 5;
          }
        } else if (b.type === 'image') {
          const img = results.get(b);
          if (!img) continue;
          const name = `I${++n}`;
          pdf.addJpeg(name, img);
          let w = width, h = w * img.height / img.width;
          const room = H - 48 - bottom - 30;
          if (h > room) { h = room; w = h * img.width / img.height; }
          y -= 4;
          ensure(h + (b.caption ? 18 : 0));
          pdf.image(name, left + (width - w) / 2, y - h, w, h);
          y -= h + 12;
          if (b.caption) {
            for (const line of wrap(b.caption, 8.5, width)) { pdf.text(line, left, y, { size: 8.5, colour: FOOT, align: 'center', width }); y -= 12; }
          }
          y -= 6;
        }
      }
    }
    // Then the one-line changes, as bullets.
    if (m.bullets.length) {
      if (m.features.length) {
        y -= 16; ensure(50);
        pdf.text(additionalHeading(m.name), left, y, { size: 12.5, bold: true, colour: TEXT });
        y -= 18;
      } else y -= 8;
      for (const b of m.bullets) bullet(b.text, left, width);
    }
  }

  // Footers go on last, once the number of pages is known.
  const total = pdf.pages.length;
  const keep = pdf.ops;
  pdf.pages.forEach((ops, i) => { pdf.ops = ops; footer(pdf, i + 1, total); });
  pdf.ops = keep;
  return { bytes: await pdf.toBytes(), failed, pages: total };
}

// ---------- ZIP (stored, no compression needed for pictures) ----------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((t, p) => t + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- Markdown for Condor's VuePress help ----------

// A short, safe name for files and folders: "FUJI" -> "fuji".
export const slug = (name) => String(name || 'release').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'release';

// Words go in as words: nothing in a note can turn into Markdown formatting,
// HTML, or a Vue expression (VuePress would try to run {{ }}).
export function mdText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\\`*_[\]#|~]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Each brace in its own span, so two can never meet as a Vue {{ }}.
    .replace(/\{/g, '<span>&#123;</span>').replace(/\}/g, '<span>&#125;</span>')
    .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(\d+)([.)])(\s)/gm, '$1$2\\$3$4')
    .split('\n').map((l) => l.trimEnd()).join('  \n');
}

const extFor = (b, type) => {
  const m = /\.([a-z0-9]{2,4})$/i.exec(b.filename || '');
  if (m) return m[1].toLowerCase();
  return type?.includes('png') ? 'png' : type?.includes('gif') ? 'gif' : type?.includes('svg') ? 'svg' : 'jpg';
};

// A paragraph's words, with any "- " lines kept as a list.
function mdPara(text) {
  return pieces(text).map((pc) => (pc.list ? pc.list.map((it) => `- ${mdText(it)}`).join('\n') : mdText(pc.para))).join('\n\n');
}

// The same layout as the release notes page in Condor's help: the version and
// introduction, then each heading with its bigger changes as sections and the
// one-line changes as bullets.
export function markdown(data, imagePath) {
  const out = [`# ${mdText(versionTitle(data.version))}`, ''];
  const intro = data.intro ?? data.introDefault ?? '';
  if (intro) out.push(mdText(intro), '');
  for (const m of data.document) {
    out.push(`## ${mdText(m.name)}`, '');
    for (const f of m.features) {
      out.push(`### ${mdText(f.title)}`, '');
      for (const b of f.blocks) {
        if (b.type === 'text') out.push(mdPara(b.text), '');
        else if (b.type === 'image' && imagePath(b)) out.push(`![${mdText(b.caption || f.title)}](${imagePath(b)})`, '');
      }
    }
    if (m.bullets.length) {
      if (m.features.length) out.push(`### ${mdText(additionalHeading(m.name))}`, '');
      out.push(...m.bullets.map((b) => `- ${mdText(b.text).replace(/\n/g, ' ')}`), '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// A ZIP holding the release's folder, as the help keeps it: README.md for the
// page and an images folder beside it, so it can be dropped into release-notes/.
export const folderFor = (v) => (v.number || slug(v.displayName || v.name));
export async function makeMarkdownZip(data, { srcFor, onProgress } = {}) {
  const base = folderFor(data.version);
  const names = new Map();
  const { results, failed } = await gather(data.document, srcFor, onProgress, async (blob) => ({ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type }));
  const counts = {};
  for (const m of data.document) for (const f of m.features) for (const b of f.blocks) {
    const got = results.get(b);
    if (!got) continue;
    counts[f.key] = (counts[f.key] || 0) + 1;
    names.set(b, `${f.key.toLowerCase()}-${counts[f.key]}.${extFor(b, got.type)}`);
  }
  const files = [{ name: `${base}/README.md`, data: markdown(data, (b) => names.get(b) && `./images/${names.get(b)}`) }];
  for (const [b, name] of names) files.push({ name: `${base}/images/${name}`, data: results.get(b).bytes });
  return { blob: zip(files), failed, pictures: names.size, name: `${base}.zip` };
}
