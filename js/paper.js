// Hide paper: find the colour of the paper an image is printed or drawn on,
// and make it transparent in proportion to how close each pixel is to it.
//
// The paper's colour is found on a small copy of the image (a few hundred
// pixels across, where averaging has already smoothed away most ink and
// noise). The most common colour is taken as the paper overall. Then, block
// by block, the brighter paper-coloured pixels give the local paper colour,
// which follows uneven lighting and yellowing across a photographed map.
// Blocks with too little paper (a large colour wash, a dark border) borrow
// from their neighbours. The result is a coarse grid that the GPU stretches
// smoothly over the image.

const GRID_BLOCK = 16;     // block size, in pixels of the small copy
const CHROMA_TOL = 0.035;  // how far a pixel's hue may stray from the paper's
const LUM_MIN = 0.5;       // and how much darker it may be (uneven lighting)
const LUM_MAX = 1.35;
const MIN_PAPER = 0.08;    // share of a block that must be paper to trust it

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// The most common colour among opaque pixels. Colours are binned at 4 bits a
// channel; the paper is the mean of the fullest bin and its neighbours.
export function globalPaper(rgba) {
  const counts = new Uint32Array(4096);
  for (let k = 0; k < rgba.length; k += 4) {
    if (rgba[k + 3] < 255) continue;
    counts[(rgba[k] >> 4) << 8 | (rgba[k + 1] >> 4) << 4 | rgba[k + 2] >> 4]++;
  }
  let best = -1, bestN = 0;
  for (let i = 0; i < 4096; i++) {
    // Score each bin with its neighbours so that a colour straddling a bin
    // boundary isn't split in two.
    if (!counts[i]) continue;
    let n = 0;
    const r = i >> 8, g = (i >> 4) & 15, b = i & 15;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr >= 0 && rr < 16 && gg >= 0 && gg < 16 && bb >= 0 && bb < 16) n += counts[rr << 8 | gg << 4 | bb];
    }
    if (n > bestN) { bestN = n; best = i; }
  }
  if (best < 0) return null;
  const br = best >> 8, bg = (best >> 4) & 15, bb = best & 15;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let k = 0; k < rgba.length; k += 4) {
    if (rgba[k + 3] < 255) continue;
    if (Math.abs((rgba[k] >> 4) - br) > 1 || Math.abs((rgba[k + 1] >> 4) - bg) > 1 ||
      Math.abs((rgba[k + 2] >> 4) - bb) > 1) continue;
    sr += rgba[k]; sg += rgba[k + 1]; sb += rgba[k + 2]; n++;
  }
  return [sr / n, sg / n, sb / n];
}

// Whether a pixel could be the paper, lit differently.
function paperLike(r, g, b, paper, paperLum) {
  const l = lum(r, g, b);
  if (l < LUM_MIN * paperLum || l > LUM_MAX * paperLum + 8) return false;
  const s = r + g + b + 1, ps = paper[0] + paper[1] + paper[2] + 1;
  return Math.abs(r / s - paper[0] / ps) < CHROMA_TOL &&
    Math.abs(g / s - paper[1] / ps) < CHROMA_TOL &&
    Math.abs(b / s - paper[2] / ps) < CHROMA_TOL;
}

// The paper's colour over a w x h RGBA image (unassociated alpha), as
// { colour: [r, g, b], grid: Uint8Array RGBA, gw, gh }. Grid cell (i, j)
// is the paper's colour around ((i + 0.5) / gw, (j + 0.5) / gh) of the image.
// Null for an image with no opaque pixels.
export function estimatePaper(rgba, w, h, block = GRID_BLOCK) {
  const colour = globalPaper(rgba);
  if (!colour) return null;
  const paperLum = lum(...colour);
  const gw = Math.max(1, Math.round(w / block)), gh = Math.max(1, Math.round(h / block));
  const cells = new Float64Array(gw * gh * 3);
  const have = new Uint8Array(gw * gh);
  const ls = [], px = [];
  for (let j = 0; j < gh; j++) {
    const y0 = Math.floor(j * h / gh), y1 = Math.floor((j + 1) * h / gh);
    for (let i = 0; i < gw; i++) {
      const x0 = Math.floor(i * w / gw), x1 = Math.floor((i + 1) * w / gw);
      ls.length = px.length = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const k = (y * w + x) * 4;
          if (rgba[k + 3] < 255) continue;
          total++;
          const r = rgba[k], g = rgba[k + 1], b = rgba[k + 2];
          if (paperLike(r, g, b, colour, paperLum)) { ls.push(lum(r, g, b)); px.push(k); }
        }
      }
      if (!px.length || px.length < MIN_PAPER * total) continue;
      // Ink, stains and shading are darker than the paper, glare brighter:
      // average the paper pixels between the 50th and 90th percentiles of
      // brightness.
      const order = ls.map((_, n) => n).sort((a, b) => ls[a] - ls[b]);
      const lo = Math.floor(order.length * 0.5), hi = Math.max(lo + 1, Math.ceil(order.length * 0.9));
      let sr = 0, sg = 0, sb = 0;
      for (let n = lo; n < hi; n++) {
        const k = px[order[n]];
        sr += rgba[k]; sg += rgba[k + 1]; sb += rgba[k + 2];
      }
      const c = (j * gw + i) * 3;
      cells[c] = sr / (hi - lo); cells[c + 1] = sg / (hi - lo); cells[c + 2] = sb / (hi - lo);
      have[j * gw + i] = 1;
    }
  }

  // Fill blocks without paper from their neighbours, ring by ring.
  if (!have.some(Boolean)) {
    for (let n = 0; n < gw * gh; n++) cells.set(colour, n * 3);
    have.fill(1);
  }
  for (let missing = have.indexOf(0); missing >= 0; missing = have.indexOf(0)) {
    const next = have.slice();
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (have[j * gw + i]) continue;
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= gw || jj >= gh || !have[jj * gw + ii]) continue;
          const c = (jj * gw + ii) * 3;
          sr += cells[c]; sg += cells[c + 1]; sb += cells[c + 2]; n++;
        }
        if (!n) continue;
        const c = (j * gw + i) * 3;
        cells[c] = sr / n; cells[c + 1] = sg / n; cells[c + 2] = sb / n;
        next[j * gw + i] = 1;
      }
    }
    have.set(next);
  }

  // Smooth out block-to-block jitter.
  const grid = new Uint8Array(gw * gh * 4);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const wgt = (di ? 1 : 2) * (dj ? 1 : 2);
        const c = (jj * gw + ii) * 3;
        sr += wgt * cells[c]; sg += wgt * cells[c + 1]; sb += wgt * cells[c + 2]; n += wgt;
      }
      const o = (j * gw + i) * 4;
      grid[o] = Math.round(sr / n); grid[o + 1] = Math.round(sg / n); grid[o + 2] = Math.round(sb / n);
      grid[o + 3] = 255;
    }
  }
  return { colour: colour.map(Math.round), grid, gw, gh };
}

// The Hide paper slider runs from 0 (off) to 1. At the middle the paper
// alone is cleared; below the middle it fades only partly, and above it
// colours further and further from the paper fade too. Returns
// [clear, solid, floor]: pixels less than `clear` from the paper become
// transparent, those more than `solid` from it stay opaque, with a ramp
// between, and no pixel is fainter than `floor`.
const PAPER_NOISE = 0.04;  // JPEG noise and paper grain, cleared with the paper
const PAPER_RAMP = 0.08;   // antialiased edges between paper and ink
export function paperThresholds(amount) {
  const more = Math.max(0, 2 * amount - 1);
  const clear = PAPER_NOISE + 0.5 * more;
  return [clear, clear + PAPER_RAMP + 0.12 * more, Math.max(0, 1 - 2 * amount)];
}

// Colour to alpha, in the manner of GIMP's: the opacity a pixel needs to be
// its colour composited over the paper, then remapped by the thresholds.
// Colours are 0..1, unassociated alpha; returns [r, g, b, a]. The fragment
// shader in app.js does the same.
export function paperToAlpha(c, p, amount) {
  if (!(amount > 0)) return [...c];
  const [clear, solid, floor] = paperThresholds(amount);
  let need = 0;
  for (let n = 0; n < 3; n++) {
    // Darker than the paper: how far towards black. Brighter: towards white,
    // but measured against at least half the range, so that slight glare
    // on near-white paper doesn't count as ink.
    const d = c[n] < p[n] ? (p[n] - c[n]) / Math.max(p[n], 1e-3) : (c[n] - p[n]) / Math.max(1 - p[n], 0.5);
    need = Math.max(need, d);
  }
  need = Math.min(need, 1);
  const a = Math.max(floor, Math.min(1, Math.max(0, (need - clear) / (solid - clear))));
  // Over the paper, colour c' at opacity a looks like c when
  // c' = p + (c - p) / a. Below `need` that leaves the gamut, so a pixel
  // the thresholds make fainter than that takes the fully unmixed colour.
  const div = Math.max(a, need);
  const out = [0, 0, 0, a * c[3]];
  for (let n = 0; n < 3; n++) {
    out[n] = div > 0 ? Math.min(1, Math.max(0, p[n] + (c[n] - p[n]) / div)) : p[n];
  }
  return out;
}
