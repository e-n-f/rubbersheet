// Isolate color: show only the lines of one color from an image, such as
// red pencil contours under black engraved hatching.
//
// Inks laid on paper add up in optical density, the negative log of how much
// light gets through, rather than in RGB. So each pixel is measured as its
// density over the local paper (from paper.js), and that is split into two
// inks: the dark ink of the image's linework, found automatically, and the
// color picked from a line to be shown. With three channels and two inks
// the split is a least-squares fit, and the amount of the picked ink is a
// fixed weighted sum of the pixel's densities. Where a black line crosses a
// red one the black counts as black ink, so the hatching drops out but the
// contour stays whole. The fragment shader in app.js does the same.

const EPS = 1 / 255;
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Density of color c over paper p (both RGB, 0..1): 0 for the paper itself,
// positive for anything darker.
export function density(c, p) {
  return [0, 1, 2].map(n => Math.log(Math.max(p[n], EPS)) - Math.log(Math.max(c[n], EPS)));
}

// The dark ink of an image as RGB 0..1: the mean of the darkest 1% of its
// opaque pixels (RGBA bytes, unassociated alpha). Near-black pixels are left
// out: they are the scanner bed or a mat around the map, not ink, which even
// at its heaviest lets a little light through. Neutral grey if none.
const INK_SHARE = 0.01;
const INK_MIN = 12;  // brightness, of 255
export function estimateInk(rgba) {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let k = 0; k < rgba.length; k += 4) {
    const l = Math.round(lum(rgba[k], rgba[k + 1], rgba[k + 2]));
    if (rgba[k + 3] < 255 || l < INK_MIN) continue;
    hist[l]++;
    total++;
  }
  if (!total) return [0.15, 0.15, 0.15];
  // The darkest pixels, up to the brightness `cut` (not included) that
  // makes up the share.
  let cut = INK_MIN, n = 0;
  while (cut < 256 && n < Math.max(1, total * INK_SHARE)) n += hist[cut++];
  const sum = [0, 0, 0];
  let count = 0;
  for (let k = 0; k < rgba.length; k += 4) {
    const l = Math.round(lum(rgba[k], rgba[k + 1], rgba[k + 2]));
    if (rgba[k + 3] < 255 || l < INK_MIN || l >= cut) continue;
    for (let c = 0; c < 3; c++) sum[c] += rgba[k + c];
    count++;
  }
  return sum.map(s => s / count / 255);
}

const norm = (v) => Math.hypot(...v);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The part of density d that isn't along the ink's density k.
function offInk(d, k) {
  const kk = dot(k, k) || 1;
  const s = dot(d, k) / kk;
  return d.map((x, n) => x - s * k[n]);
}

// From the pixels around a click (RGBA bytes, unassociated alpha) on paper of
// color p (RGB 0..1) in an image whose dark ink has density inkD over that
// paper: the density of the color to show, as the mean of the few pixels
// that stand out most from both paper and dark ink. That way a click need
// not land exactly on a thin line. Null if nothing there has any color.
const PICK_BEST = 4;
const PICK_MIN = 0.15;
export function pickDensity(rgba, p, inkD) {
  const scored = [];
  for (let k = 0; k < rgba.length; k += 4) {
    if (rgba[k + 3] < 255) continue;
    const d = density([rgba[k] / 255, rgba[k + 1] / 255, rgba[k + 2] / 255], p);
    // Not glare or a scuff, brighter than the paper in any channel.
    if (Math.min(...d) < -0.05) continue;
    scored.push({ d, s: norm(offInk(d, inkD)) });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored.slice(0, PICK_BEST);
  if (!best.length || best[0].s < PICK_MIN) return null;
  const d = [0, 0, 0];
  for (const b of best) for (let n = 0; n < 3; n++) d[n] += b.d[n] / best.length;
  return d;
}

// Weights w such that w · d is the amount of the picked ink (density showD)
// in a pixel of density d, split between it and the dark ink (inkD): 1 for
// the picked color itself, 0 for paper and for the dark ink. Null if the
// two inks are too alike to tell apart.
export function isolateWeights(showD, inkD) {
  // Least squares: [a, b] = (MᵀM)⁻¹ Mᵀ d with M = [inkD showD]; w is the
  // second row of (MᵀM)⁻¹ Mᵀ.
  const kk = dot(inkD, inkD), ks = dot(inkD, showD), ss = dot(showD, showD);
  const det = kk * ss - ks * ks;
  if (!(det > 1e-6 * kk * ss)) return null;
  return [0, 1, 2].map(n => (kk * showD[n] - ks * inkD[n]) / det);
}

// The color to draw the isolated lines in, from the picked density: as if
// that ink were laid somewhat heavier on white paper, so that it reads
// clearly over a base map. RGB 0..1.
const DRAW_DENSITY = 1.8;
export function drawColor(showD) {
  const m = Math.max(...showD.map(x => Math.max(x, 0)), 1e-6);
  return showD.map(x => Math.exp(-Math.max(x, 0) * DRAW_DENSITY / m));
}

// The Isolate slider runs from 0 (off) to 1. Returns [clear, solid]: pixels
// with less of the picked ink than `clear` are transparent, those with more
// than `solid` are opaque, with a ramp between. Further right, fainter lines
// show.
export function isolateThresholds(amount) {
  const clear = 0.5 - 0.42 * amount;
  return [clear, clear + 0.3];
}

// What the shader draws for color c (RGBA 0..1, unassociated) over paper p:
// the draw color `col` at the opacity the amount of picked ink gives.
// Returns [r, g, b, a], unassociated.
export function isolateAlpha(c, p, w, col, amount) {
  const [clear, solid] = isolateThresholds(amount);
  const b = dot(w, density(c, p));
  const a = Math.min(1, Math.max(0, (b - clear) / (solid - clear)));
  return [...col, a * c[3]];
}

// '#rrggbb' for RGB 0..1, and back.
export const toHex = (c) => '#' + c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
