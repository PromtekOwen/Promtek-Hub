// The Employee of the Quarter certificate, drawn in the browser in the same style
// as the ones made by hand: blue sweep on the left, the logo, the winner's
// picture and name. Saved as a PDF (A4 landscape) or a picture.
import { Pdf } from '/pdf.js';

// Laid out on a 2000 x 1414 page (A4 landscape), drawn at a higher resolution.
const W = 2000, H = 1414, SCALE = 1.4;
const NAVY = '#0b2b4c';
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700&family=Josefin+Sans:wght@400&family=Lora&display=swap';

let fontsReady = null;
function loadFonts() {
  if (fontsReady) return fontsReady;
  if (!document.querySelector('link[data-cert-fonts]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = FONTS; link.dataset.certFonts = '1';
    document.head.appendChild(link);
  }
  // Without the fonts (offline, say) it still draws, in the nearest the device has.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fontsReady = Promise.race([
    Promise.all(['700 100px "Cormorant Garamond"', '400 50px "Josefin Sans"', '400 30px Lora'].map((f) => document.fonts.load(f).catch(() => null))),
    wait(4000),
  ]);
  return fontsReady;
}

const loadImage = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

// Text with space between the letters, centred on x.
function spaced(ctx, text, x, y, spacing) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let at = x - total / 2;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, at, y); at += widths[i] + spacing; });
  return total;
}

// The largest size, up to `size`, at which the text fits the width.
function fit(ctx, font, text, size, maxWidth, spacing = 0) {
  let s = size;
  for (; s > 12; s -= 2) {
    ctx.font = font(s);
    const w = [...text].reduce((t, c) => t + ctx.measureText(c).width, 0) + spacing(s) * (text.length - 1);
    if (w <= maxWidth) break;
  }
  ctx.font = font(s);
  return s;
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export async function draw(data) {
  await loadFonts();
  const [avatar, logo] = await Promise.all([loadImage(data.avatar), loadImage('/logo-white.png')]);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * SCALE); canvas.height = Math.round(H * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // The sweep: dark blue, then light blue, then bright blue nearest the edge.
  const band = (colour, top, c1, c2, bottom) => {
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(top, 0);
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], bottom, H);
    ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = colour; ctx.fill();
  };
  band('#0f5f91', 262, [222, 640], [440, 1150], 800);
  band('#80b3da', 236, [178, 620], [300, 1160], 612);
  band('#0089c7', 222, [140, 560], [190, 1150], 412);

  if (logo) ctx.drawImage(logo, 38, 1182, 210, 200);

  ctx.fillStyle = NAVY;
  ctx.textBaseline = 'alphabetic';
  // Heading
  ctx.font = '700 150px "Cormorant Garamond", "Times New Roman", serif';
  spaced(ctx, 'CERTIFICATE', 1040, 276, 6);
  ctx.font = '400 54px "Josefin Sans", "Century Gothic", sans-serif';
  spaced(ctx, 'EMPLOYEE OF THE QUARTER', 1031, 366, 15);

  // The picture, or their initials on the same blue.
  const px = 783, py = 400, size = 434;
  const grad = ctx.createLinearGradient(0, py, 0, py + size);
  grad.addColorStop(0, '#0f6293'); grad.addColorStop(1, '#0089c7');
  ctx.fillStyle = grad;
  ctx.fillRect(px, py, size, size + 11);
  if (avatar) {
    const s = Math.min(avatar.width, avatar.height);
    ctx.drawImage(avatar, (avatar.width - s) / 2, (avatar.height - s) / 2, s, s, px, py, size, size + 11);
  } else {
    ctx.fillStyle = '#fff';
    ctx.font = '400 170px "Josefin Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(initialsOf(data.name), px + size / 2, py + size / 2 + 70);
  }

  ctx.fillStyle = NAVY;
  // Name, then what it was for.
  fit(ctx, (s) => `400 ${s}px "Josefin Sans", "Century Gothic", sans-serif`, data.name, 76, 1150, (s) => s * 0.16);
  spaced(ctx, data.name, 1000, 933, parseFloat(ctx.font) * 0.16);
  const award = String(data.award || '').toUpperCase();
  fit(ctx, (s) => `400 ${s}px "Josefin Sans", "Century Gothic", sans-serif`, award, 48, 1150, (s) => s * 0.13);
  spaced(ctx, award, 995, 1016, parseFloat(ctx.font) * 0.13);

  // The words underneath, centred and wrapped.
  ctx.font = '400 33px Lora, Georgia, serif';
  ctx.textAlign = 'center';
  const lines = wrap(ctx, data.citation, 960).slice(0, 4);
  lines.forEach((line, i) => ctx.fillText(line, 1043, 1130 + i * 48));
  return canvas;
}

const fileName = (data, ext) => `Employee of the Quarter ${data.name} ${data.label}.${ext}`.replace(/[\\/:*?"<>|]+/g, '');

export async function pdf(data, canvas) {
  const jpeg = canvas.toDataURL('image/jpeg', 0.92);
  const page = { width: 841.89, height: 595.28 };
  const doc = new Pdf({ size: page, margin: 0, title: `Employee of the Quarter, ${data.name}` });
  doc.addJpeg('C', { base64: jpeg.split(',')[1], width: canvas.width, height: canvas.height });
  doc.image('C', 0, 0, page.width, page.height);
  return { blob: new Blob([await doc.toBytes()], { type: 'application/pdf' }), name: fileName(data, 'pdf') };
}

export async function png(data, canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { blob, name: fileName(data, 'png') };
}
