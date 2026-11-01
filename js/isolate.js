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

// The Isolate slider runs from 0 (off) to 1, as the gain: what the picked
// ink's density (summed over the channels) is multiplied by, doubling every
// quarter of the way. The lines are drawn as ink of that density, in the
// draw color, which multiplies the map under it as ink does the paper. A
// thin line spread over two pixels, or averaged with the paper when zoomed
// out, then shows about as faintly as it does on the image instead of
// dropping out or swelling, and the soft edges of a heavy line stay soft.
// Below `floor`, which is paper grain and stains, nothing shows. Returns
// [floor, gain].
const FLOOR = 0.1;
export function isolateGain(amount) {
  return [FLOOR, amount > 0 ? 3 * 2 ** (4 * amount - 2) : 0];
}

// The density of a draw color (RGB 0..1) as a share of each channel, so
// that ink of total density D drawn in it lets through e^(-D * share) of
// each channel.
export function inkDensity(col) {
  const d = col.map(x => -Math.log(Math.min(1, Math.max(x, EPS))));
  const t = sum(d);
  return t > 0 ? d.map(x => x / t) : [1 / 3, 1 / 3, 1 / 3];
}

// Black ink at its heaviest doesn't quite absorb every color alike: on a
// scan its color bottoms out at different levels in each channel, and over
// yellowed paper it takes on the hue of grey pencil. But it is dark in every
// channel, as no colored ink is, so a pixel fades out once its density in
// its lightest channel passes BLACK[0], and is gone by BLACK[1]. The soft
// edge of a black line, part black and part paper, is lighter than that
// but has a tint of its own, so a pixel also fades out as the lightest
// channel of its neighbourhood's density passes that of the picked ink
// (showD) by NEAR_BLACK in the same way. Returns the thresholds, [lo, hi,
// near lo, near hi].
export const BLACK = [0.7, 1.0];
export const NEAR_BLACK = [0.25, 0.45];
export const blackThresholds = (showD) => [...BLACK, ...NEAR_BLACK.map(x => x + Math.max(0, Math.min(...showD)))];
const ramp = (lo, hi, x) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
export function blackFade(showD, d, near = d) {
  const [lo, hi, nlo, nhi] = blackThresholds(showD);
  return (1 - ramp(lo, hi, Math.min(...d))) * (1 - ramp(nlo, nhi, Math.min(...near)));
}

// The amount of the picked ink in a pixel of density d whose neighbourhood
// has density near, as a density (summed over the channels): the split of
// the neighbourhood, scaled to the pixel. `w` is from isolateWeights and
// showD the picked density. The shader in app.js does the same, with w
// scaled by sum(showD) ahead of time.
const NEAR_MIN = 0.05;
export function inkAmount(w, showD, d, near = d) {
  return dot(w, near) * sum(showD) * Math.max(sum(d), 0) / Math.max(sum(near), NEAR_MIN);
}

// What the shader draws for color c (RGBA 0..1, unassociated) over paper p,
// with `near` the mean density around it: the share of each channel of the
// map under it to let through, as RGB. Black ink (by blackFade) and the
// paper let all through.
export function isolateTransmittance(c, p, w, showD, col, amount, near = null) {
  const [floor, gain] = isolateGain(amount);
  const d = density(c, p);
  const b = inkAmount(w, showD, d, near || d);
  const fade = blackFade(showD, d, near || d);
  const ink = Math.max(0, b - floor) * gain * fade;
  return inkDensity(col).map(k => 1 - (1 - Math.exp(-k * ink)) * c[3]);
}

// '#rrggbb' for RGB 0..1, and back.
export const toHex = (c) => '#' + c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
