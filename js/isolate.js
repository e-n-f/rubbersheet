// Isolate color: show only the lines of one color from an image, such as
// red ink or grey pencil contours among black engraved hatching.
//
// Inks laid on paper add up in optical density, the negative log of how much
// light gets through, rather than in RGB. So each pixel is measured as its
// density over the local paper (from paper.js) and split into inks: black
// ink, which absorbs every color alike, the color picked from a line to be
// shown, and optionally one more picked color to hide. With three channels
// and at most three inks the split is exact (or, with two, a least-squares
// fit), and the amount of the picked ink is a fixed weighted sum of the
// pixel's densities. Where a black line crosses a red one the black counts
// as black ink, so the hatching drops out but the contour stays whole.
//
// Scans, JPEGs above all, keep color at a lower resolution than brightness,
// and the hue of single pixels is noisy. So the shader in app.js weighs the
// inks by the density of a small neighbourhood and scales the result by the
// pixel's own density, which keeps lines sharp.

const EPS = 1 / 255;
export const INK = [1, 1, 1];

const sum = (v) => v[0] + v[1] + v[2];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Density of color c over paper p (both RGB, 0..1): 0 for the paper itself,
// positive for anything darker.
export function density(c, p) {
  return [0, 1, 2].map(n => Math.log(Math.max(p[n], EPS)) - Math.log(Math.max(c[n], EPS)));
}

// The density of the line under a click, from the pixels around it (RGBA
// bytes, unassociated alpha) on paper of color p (RGB 0..1): channel by
// channel, the median of the darkest PICK_SHARE of them. A line covers at
// least that much of a small neighbourhood, so the click needn't land
// exactly on it. Null if that is too faint to be a line.
const PICK_SHARE = 0.4;
const PICK_MIN = 0.2;
export function pickDensity(rgba, p) {
  const ds = [];
  for (let k = 0; k < rgba.length; k += 4) {
    if (rgba[k + 3] < 255) continue;
    ds.push(density([rgba[k] / 255, rgba[k + 1] / 255, rgba[k + 2] / 255], p));
  }
  if (!ds.length) return null;
  ds.sort((a, b) => sum(b) - sum(a));
  const dark = ds.slice(0, Math.max(1, Math.round(ds.length * PICK_SHARE)));
  const median = (n) => {
    const v = dark.map(d => d[n]).sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const d = [0, 1, 2].map(median);
  return sum(d) < PICK_MIN ? null : d;
}

// The angle in degrees between two densities, as colors of ink: 0 for the
// same hue at any strength.
export function inkAngle(a, b) {
  const c = dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));
  return Math.acos(Math.min(1, Math.max(-1, c))) * 180 / Math.PI;
}

// Weights w such that w · d is the amount of the picked ink (density showD)
// in a pixel of density d, split between it, black ink, and if given the
// ink to hide (hideD): 1 for the picked color itself, 0 for paper, black
// and the hidden color. Null if the inks are too alike to tell apart.
const MIN_ANGLE = 2.5;
export function isolateWeights(showD, hideD = null) {
  if (inkAngle(showD, INK) < MIN_ANGLE) return null;
  if (hideD && inkAngle(hideD, INK) >= MIN_ANGLE && inkAngle(hideD, showD) >= MIN_ANGLE) {
    // The middle row of the inverse of M = [INK showD hideD] (as columns):
    // the cross product of the other two columns over the determinant.
    const [k, h] = [INK, hideD];
    const cross = [k[1] * h[2] - k[2] * h[1], k[2] * h[0] - k[0] * h[2], k[0] * h[1] - k[1] * h[0]];
    const det = -dot(showD, cross);
    if (Math.abs(det) > 1e-3 * Math.sqrt(dot(showD, showD) * dot(k, k) * dot(h, h))) {
      return cross.map(x => -x / det);
    }
  }
  // Least squares: [a, b] = (MᵀM)⁻¹ Mᵀ d with M = [INK showD]; w is the
  // second row of (MᵀM)⁻¹ Mᵀ.
  const kk = dot(INK, INK), ks = dot(INK, showD), ss = dot(showD, showD);
  const det = kk * ss - ks * ks;
  return [0, 1, 2].map(n => (kk * showD[n] - ks * INK[n]) / det);
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
  return [clear, clear + 0.35];
}

// Black ink at its heaviest doesn't quite absorb every color alike: on a
// scan its color bottoms out at different levels in each channel, and over
// yellowed paper it takes on the hue of grey pencil. So anything far darker
// than the line picked is taken for black: from CEILING[0] times the
// picked density it fades, and from CEILING[1] times it's gone. Returns
// [lo, hi] as total densities (summed over the channels).
const CEILING = [1.8, 2.6];
export function isolateCeiling(showD) {
  return CEILING.map(f => f * Math.max(sum(showD), 0.1));
}

// The amount of the picked ink in a pixel of density d whose neighbourhood
// has density near: the split of the neighbourhood, scaled to the pixel.
// The shader in app.js does the same.
const NEAR_MIN = 0.05;
export function inkAmount(w, d, near = d) {
  return dot(w, near) * Math.max(sum(d), 0) / Math.max(sum(near), NEAR_MIN);
}

// What the shader draws for color c (RGBA 0..1, unassociated) over paper p,
// with `near` the mean density around it: the draw color `col` at the
// opacity the amount of picked ink gives, faded where it's far darker than
// the picked line (isolateCeiling). Returns [r, g, b, a], unassociated.
export function isolateAlpha(c, p, w, showD, col, amount, near = null) {
  const [clear, solid] = isolateThresholds(amount);
  const d = density(c, p);
  const b = inkAmount(w, d, near || d);
  const [lo, hi] = isolateCeiling(showD);
  const fade = 1 - Math.min(1, Math.max(0, (sum(d) - lo) / (hi - lo)));
  const a = Math.min(1, Math.max(0, (b - clear) / (solid - clear))) * fade;
  return [...col, a * c[3]];
}

// '#rrggbb' for RGB 0..1, and back.
export const toHex = (c) => '#' + c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
