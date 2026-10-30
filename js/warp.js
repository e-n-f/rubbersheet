// Geometry for rubbersheeting an image onto Web Mercator.
//
// Image pixel coordinates (u, v) have their origin at the top-left corner of
// the image, v pointing down. Map coordinates (x, y) are MapLibre's
// MercatorCoordinate units: the whole world is [0, 1] x [0, 1], y pointing
// down, so image and map axes share the same handedness.
//
// The warp is:
//   0 or 1 control points: a plain affine placement T.
//   2 control points:      the similarity transform through both points.
//   3+ control points:     the least-squares similarity S through all points,
//                          followed by rigid Moving Least Squares
//                          (Schaefer et al. 2006) to bend the residuals so
//                          that every control point lands exactly.
// Pre-fitting S means MLS only has to absorb the small leftover distortion,
// which keeps the rigid (rotation-only) local frames sensible.

// Affine transforms are [a, b, c, d, e, f]:
//   x = a*u + b*v + c
//   y = d*u + e*v + f
export function applyAffine(T, u, v) {
  return [T[0] * u + T[1] * v + T[2], T[3] * u + T[4] * v + T[5]];
}

export function invertAffine(T) {
  const [a, b, c, d, e, f] = T;
  const det = a * e - b * d;
  if (det === 0) return null;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

// Pixel size of an affine transform (geometric mean of the two axes).
export function affineScale(T) {
  return Math.sqrt(Math.abs(T[0] * T[4] - T[1] * T[3]));
}

// Compose the complex similarity z -> pivot + k * (z - pivot) after T.
export function similarityAboutPivot(T, pivot, kr, ki) {
  const [a, b, c, d, e, f] = T;
  const cx = c - pivot[0], cy = f - pivot[1];
  return [
    kr * a - ki * d, kr * b - ki * e, pivot[0] + kr * cx - ki * cy,
    ki * a + kr * d, ki * b + kr * e, pivot[1] + ki * cx + kr * cy,
  ];
}

export function translateAffine(T, dx, dy) {
  return [T[0], T[1], T[2] + dx, T[3], T[4], T[5] + dy];
}

// Least-squares similarity (scale + rotation + translation) taking
// src[i] = [u, v] to dst[i] = [x, y]. Exact for two distinct points.
export function fitSimilarity(src, dst) {
  const n = src.length;
  let su = 0, sv = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    su += src[i][0]; sv += src[i][1];
    sx += dst[i][0]; sy += dst[i][1];
  }
  su /= n; sv /= n; sx /= n; sy /= n;
  let num_r = 0, num_i = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const pu = src[i][0] - su, pv = src[i][1] - sv;
    const qx = dst[i][0] - sx, qy = dst[i][1] - sy;
    num_r += pu * qx + pv * qy;
    num_i += pu * qy - pv * qx;
    den += pu * pu + pv * pv;
  }
  if (den === 0) return null;
  const a = num_r / den, b = num_i / den;
  return [a, -b, sx - (a * su - b * sv), b, a, sy - (b * su + a * sv)];
}

// Rigid moving least squares. P are the (pre-mapped) source positions, Q the
// targets, both arrays of [x, y]. Returns a function of a pre-mapped point.
export function rigidMLS(P, Q) {
  const n = P.length;
  return function (vx, vy) {
    let sw = 0, psx = 0, psy = 0, qsx = 0, qsy = 0;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dx = P[i][0] - vx, dy = P[i][1] - vy;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-40) return [Q[i][0], Q[i][1]];
      const wi = 1 / d2;
      w[i] = wi;
      sw += wi;
      psx += wi * P[i][0]; psy += wi * P[i][1];
      qsx += wi * Q[i][0]; qsy += wi * Q[i][1];
    }
    psx /= sw; psy /= sw; qsx /= sw; qsy /= sw;
    // mu = sum w * conj(p^) * q^ ; the rigid solution uses only its angle.
    let mr = 0, mi = 0;
    for (let i = 0; i < n; i++) {
      const px = P[i][0] - psx, py = P[i][1] - psy;
      const qx = Q[i][0] - qsx, qy = Q[i][1] - qsy;
      mr += w[i] * (px * qx + py * qy);
      mi += w[i] * (px * qy - py * qx);
    }
    const len = Math.hypot(mr, mi);
    const cr = len > 0 ? mr / len : 1, ci = len > 0 ? mi / len : 0;
    const rx = vx - psx, ry = vy - psy;
    return [rx * cr - ry * ci + qsx, rx * ci + ry * cr + qsy];
  };
}

// points: [{u, v, x, y}]. Returns {map(u, v) -> [x, y], S} where S is the
// global affine part (T itself when there are fewer than two points).
export function makeWarp(T, points) {
  if (points.length < 2) {
    return { S: T, map: (u, v) => applyAffine(T, u, v) };
  }
  const src = points.map(p => [p.u, p.v]);
  const dst = points.map(p => [p.x, p.y]);
  const S = fitSimilarity(src, dst) || T;
  if (points.length === 2) {
    return { S, map: (u, v) => applyAffine(S, u, v) };
  }
  const P = src.map(([u, v]) => applyAffine(S, u, v));
  const mls = rigidMLS(P, dst);
  return {
    S,
    map: (u, v) => {
      const [x, y] = applyAffine(S, u, v);
      return mls(x, y);
    },
  };
}

// Evaluate the warp on a grid over the image. `cols` cells across; rows are
// chosen to keep cells roughly square unless given. Positions are absolute
// Mercator units (Float64) so callers can rebase them before handing them to
// the GPU.
export function buildMesh(map, W, H, cols, rows = Math.round(cols * H / W)) {
  const nx = Math.max(1, cols);
  const ny = Math.max(1, rows);
  const pos = new Float64Array((nx + 1) * (ny + 1) * 2);
  const uv = new Float32Array((nx + 1) * (ny + 1) * 2);
  let k = 0;
  for (let j = 0; j <= ny; j++) {
    const v = H * j / ny;
    for (let i = 0; i <= nx; i++) {
      const u = W * i / nx;
      const [x, y] = map(u, v);
      pos[k] = x; pos[k + 1] = y;
      uv[k] = i / nx; uv[k + 1] = j / ny;
      k += 2;
    }
  }
  return { pos, uv, nx, ny, W, H };
}

// A finer grid over cells [i0, i1) × [j0, j1) of `mesh`, each split s × s and
// evaluated with `map`, for drawing the part of the image in view exactly
// enough at high zoom. It is a mesh in its own right over that part of the
// image (pixel u0 + u, v0 + v), with texture coordinates for the whole image.
export function refineMesh(map, mesh, i0, j0, i1, j1, s) {
  const { W, H, nx, ny } = mesh;
  const u0 = W * i0 / nx, v0 = H * j0 / ny;
  const sw = W * i1 / nx - u0, sh = H * j1 / ny - v0;
  const sub = buildMesh((u, v) => map(u0 + u, v0 + v), sw, sh, (i1 - i0) * s, (j1 - j0) * s);
  for (let k = 0; k < sub.uv.length; k += 2) {
    sub.uv[k] = (u0 + sub.uv[k] * sw) / W;
    sub.uv[k + 1] = (v0 + sub.uv[k + 1] * sh) / H;
  }
  return { mesh: sub, i0, j0, i1, j1, s, u0, v0 };
}

// An export mesh that follows the warp to within `tol` (Mercator units)
// everywhere: a cols-wide grid whose cells are checked against the warp at
// their centres, edge midpoints and any `probes` ([u, v], the control points)
// inside them, and split S × S where they're off by more than tol, along
// with their neighbours. A cell left whole beside split ones takes their
// extra edge vertices and is drawn as a fan from its centre, so the two
// share every vertex along the edge and no hairline gaps open between them.
// Returns a triangle soup {soup: true, pos, uv, W, H, refined}: three
// vertices per triangle, positions absolute.
export function refinedSoup(map, W, H, cols, tol, probes = [], S = 16) {
  const nx = Math.max(1, cols), ny = Math.max(1, Math.round(cols * H / W));
  const cw = W / nx, ch = H / ny;
  const corner = new Float64Array((nx + 1) * (ny + 1) * 2);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const [x, y] = map(i * cw, j * ch);
      corner[(j * (nx + 1) + i) * 2] = x;
      corner[(j * (nx + 1) + i) * 2 + 1] = y;
    }
  }
  const C = (i, j) => [corner[(j * (nx + 1) + i) * 2], corner[(j * (nx + 1) + i) * 2 + 1]];
  // How far the warp is from the cell's bilinear interpolation at (a, b) in
  // its unit square.
  const off = (i, j, a, b) => {
    const [x, y] = map((i + a) * cw, (j + b) * ch);
    const p00 = C(i, j), p10 = C(i + 1, j), p01 = C(i, j + 1), p11 = C(i + 1, j + 1);
    const bx = (1 - a) * (1 - b) * p00[0] + a * (1 - b) * p10[0] + (1 - a) * b * p01[0] + a * b * p11[0];
    const by = (1 - a) * (1 - b) * p00[1] + a * (1 - b) * p10[1] + (1 - a) * b * p01[1] + a * b * p11[1];
    return Math.hypot(x - bx, y - by);
  };
  const bad = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (off(i, j, 0.5, 0.5) > tol || off(i, j, 0.5, 0) > tol || off(i, j, 0, 0.5) > tol ||
          (i === nx - 1 && off(i, j, 1, 0.5) > tol) || (j === ny - 1 && off(i, j, 0.5, 1) > tol)) {
        bad[j * nx + i] = 1;
      }
    }
  }
  for (const [u, v] of probes) {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(u / cw))), j = Math.min(ny - 1, Math.max(0, Math.floor(v / ch)));
    if (off(i, j, u / cw - i, v / ch - j) > tol) bad[j * nx + i] = 1;
  }
  // Split the bad cells and their neighbours.
  const split = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!bad[j * nx + i]) continue;
      for (let jj = Math.max(0, j - 1); jj <= Math.min(ny - 1, j + 1); jj++) {
        for (let ii = Math.max(0, i - 1); ii <= Math.min(nx - 1, i + 1); ii++) split[jj * nx + ii] = 1;
      }
    }
  }
  const isSplit = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && split[j * nx + i] === 1;

  const pos = [], uv = [];
  const vert = (u, v) => {
    const [x, y] = map(u, v);
    return [x, y, u, v];
  };
  const tri = (a, b, c) => {
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1]);
      uv.push(p[2] / W, p[3] / H);
    }
  };
  let refined = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u0 = i * cw, v0 = j * ch;
      if (isSplit(i, j)) {
        refined++;
        const g = [];
        for (let b = 0; b <= S; b++) {
          for (let a = 0; a <= S; a++) {
            // Corners and edges exactly as the neighbours compute them.
            g.push(a === 0 && b === 0 ? [...C(i, j), u0, v0]
              : a === S && b === 0 ? [...C(i + 1, j), u0 + cw, v0]
                : a === 0 && b === S ? [...C(i, j + 1), u0, v0 + ch]
                  : a === S && b === S ? [...C(i + 1, j + 1), u0 + cw, v0 + ch]
                    : vert(u0 + cw * a / S, v0 + ch * b / S));
          }
        }
        const n = (a, b) => g[b * (S + 1) + a];
        for (let b = 0; b < S; b++) {
          for (let a = 0; a < S; a++) {
            tri(n(a, b), n(a + 1, b), n(a, b + 1));
            tri(n(a + 1, b), n(a + 1, b + 1), n(a, b + 1));
          }
        }
        continue;
      }
      const p00 = [...C(i, j), u0, v0], p10 = [...C(i + 1, j), u0 + cw, v0];
      const p01 = [...C(i, j + 1), u0, v0 + ch], p11 = [...C(i + 1, j + 1), u0 + cw, v0 + ch];
      const top = isSplit(i, j - 1), bottom = isSplit(i, j + 1), left = isSplit(i - 1, j), right = isSplit(i + 1, j);
      if (!top && !bottom && !left && !right) {
        tri(p00, p10, p01);
        tri(p10, p11, p01);
        continue;
      }
      // The boundary, clockwise from the top-left corner, with a split
      // neighbour's edge vertices, fanned from the centre.
      const ring = [p00];
      for (let a = 1; top && a < S; a++) ring.push(vert(u0 + cw * a / S, v0));
      ring.push(p10);
      for (let b = 1; right && b < S; b++) ring.push(vert(u0 + cw, v0 + ch * b / S));
      ring.push(p11);
      for (let a = S - 1; bottom && a > 0; a--) ring.push(vert(u0 + cw * a / S, v0 + ch));
      ring.push(p01);
      for (let b = S - 1; left && b > 0; b--) ring.push(vert(u0, v0 + ch * b / S));
      const mid = vert(u0 + cw / 2, v0 + ch / 2);
      for (let k = 0; k < ring.length; k++) tri(mid, ring[k], ring[(k + 1) % ring.length]);
    }
  }
  return { soup: true, pos: Float64Array.from(pos), uv: Float32Array.from(uv), W, H, refined };
}

// Invert the drawn mesh: the refined part first, then the rest.
export function invertDrawn(mesh, fine, x, y) {
  if (fine) {
    const r = invertMesh(fine.mesh, x, y);
    if (r) return [r[0] + fine.u0, r[1] + fine.v0];
  }
  return invertMesh(mesh, x, y);
}

// Vertex index of grid node (i, j).
function node(mesh, i, j) {
  return j * (mesh.nx + 1) + i;
}

// Expand the grid into a flat list of triangles, positions relative to
// `origin`, as Float32 for upload. With `fine` (from refineMesh), its cells
// replace the coarse ones they cover.
export function meshTriangles(mesh, origin, fine = null) {
  if (mesh.soup) {
    const positions = new Float32Array(mesh.pos.length);
    for (let k = 0; k < positions.length; k += 2) {
      positions[k] = mesh.pos[k] - origin[0];
      positions[k + 1] = mesh.pos[k + 1] - origin[1];
    }
    return { positions, uvs: mesh.uv, count: mesh.pos.length / 2 };
  }
  const covered = (i, j) => fine && i >= fine.i0 && i < fine.i1 && j >= fine.j0 && j < fine.j1;
  const coarse = mesh.nx * mesh.ny - (fine ? (fine.i1 - fine.i0) * (fine.j1 - fine.j0) : 0);
  const count = (coarse + (fine ? fine.mesh.nx * fine.mesh.ny : 0)) * 6;
  const p = new Float32Array(count * 2);
  const t = new Float32Array(count * 2);
  let k = 0;
  const emit = (m, skip) => {
    const { nx, ny, pos, uv } = m;
    const push = (n) => {
      p[k] = pos[n * 2] - origin[0];
      p[k + 1] = pos[n * 2 + 1] - origin[1];
      t[k] = uv[n * 2];
      t[k + 1] = uv[n * 2 + 1];
      k += 2;
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (skip && skip(i, j)) continue;
        const a = node(m, i, j), b = node(m, i + 1, j);
        const c = node(m, i, j + 1), d = node(m, i + 1, j + 1);
        push(a); push(b); push(c);
        push(b); push(d); push(c);
      }
    }
  };
  emit(mesh, covered);
  if (fine) emit(fine.mesh, null);
  return { positions: p, uvs: t, count };
}

export function meshBounds(mesh) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < mesh.pos.length; k += 2) {
    const x = mesh.pos[k], y = mesh.pos[k + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Outline of the warped image, clockwise from the top-left corner.
export function meshOutline(mesh) {
  const { nx, ny, pos } = mesh;
  const out = [];
  const add = (i, j) => {
    const n = node(mesh, i, j);
    out.push([pos[n * 2], pos[n * 2 + 1]]);
  };
  for (let i = 0; i < nx; i++) add(i, 0);
  for (let j = 0; j < ny; j++) add(nx, j);
  for (let i = nx; i > 0; i--) add(i, ny);
  for (let j = ny; j > 0; j--) add(0, j);
  return out;
}

export function meshCorners(mesh) {
  const { nx, ny, pos } = mesh;
  return [[0, 0], [nx, 0], [nx, ny], [0, ny]].map(([i, j]) => {
    const n = node(mesh, i, j);
    return [pos[n * 2], pos[n * 2 + 1]];
  });
}

// Map a Mercator point back to image pixels by locating it in the warped
// grid. Returns null when the point is outside the image.
export function invertMesh(mesh, x, y) {
  const { nx, ny, pos, W, H } = mesh;
  let best = null;
  const tri = (a, b, c, ua, va, ub, vb, uc, vc) => {
    const ax = pos[a * 2], ay = pos[a * 2 + 1];
    const bx = pos[b * 2], by = pos[b * 2 + 1];
    const cx = pos[c * 2], cy = pos[c * 2 + 1];
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) ||
        y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) return false;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) return false;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    const eps = -1e-9;
    if (l1 < eps || l2 < eps || l3 < eps) return false;
    best = [l1 * ua + l2 * ub + l3 * uc, l1 * va + l2 * vb + l3 * vc];
    return true;
  };
  for (let j = 0; j < ny; j++) {
    const v0 = H * j / ny, v1 = H * (j + 1) / ny;
    for (let i = 0; i < nx; i++) {
      const u0 = W * i / nx, u1 = W * (i + 1) / nx;
      const a = node(mesh, i, j), b = node(mesh, i + 1, j);
      const c = node(mesh, i, j + 1), d = node(mesh, i + 1, j + 1);
      if (tri(a, b, c, u0, v0, u1, v0, u0, v1)) return best;
      if (tri(b, d, c, u1, v0, u1, v1, u0, v1)) return best;
    }
  }
  return null;
}

// The image pixel under each node of a grid of nx × ny nodes, `step` apart
// from the origin, in the plane that affine A ([a, b, c, d, e, f]) takes the
// mesh's positions to (screen pixels, say). Each cell is visited once, so
// this is far quicker than inverting node by node. Returns [u0, v0, u1, ...],
// NaN where the image isn't.
export function sampleMesh(mesh, A, nx, ny, step) {
  const { nx: mx, ny: my, pos, W, H } = mesh;
  const out = new Float64Array(nx * ny * 2).fill(NaN);
  const n = pos.length / 2;
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    sx[k] = A[0] * pos[k * 2] + A[1] * pos[k * 2 + 1] + A[2];
    sy[k] = A[3] * pos[k * 2] + A[4] * pos[k * 2 + 1] + A[5];
  }
  const tri = (a, b, c, ua, va, ub, vb, uc, vc) => {
    const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (det === 0) return;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / step));
    const i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / step));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) / step));
    const j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) / step));
    for (let j = j0; j <= j1; j++) {
      const y = j * step;
      for (let i = i0; i <= i1; i++) {
        const k = (j * nx + i) * 2;
        if (!Number.isNaN(out[k])) continue;
        const x = i * step;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        out[k] = l1 * ua + l2 * ub + l3 * uc;
        out[k + 1] = l1 * va + l2 * vb + l3 * vc;
      }
    }
  };
  for (let j = 0; j < my; j++) {
    const v0 = H * j / my, v1 = H * (j + 1) / my;
    for (let i = 0; i < mx; i++) {
      const u0 = W * i / mx, u1 = W * (i + 1) / mx;
      const a = node(mesh, i, j), b = node(mesh, i + 1, j);
      const c = node(mesh, i, j + 1), d = node(mesh, i + 1, j + 1);
      tri(a, b, c, u0, v0, u1, v0, u0, v1);
      tri(b, d, c, u1, v0, u1, v1, u0, v1);
    }
  }
  return out;
}

// Web Mercator (EPSG:3857) metres <-> MapLibre Mercator units.
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

export function mercToMeters(x, y) {
  return [(x - 0.5) * EARTH_CIRCUMFERENCE, (0.5 - y) * EARTH_CIRCUMFERENCE];
}

export function metersToMerc(mx, my) {
  return [mx / EARTH_CIRCUMFERENCE + 0.5, 0.5 - my / EARTH_CIRCUMFERENCE];
}

// A world file [A, D, B, E, C, F] (in that file order) in EPSG:3857 metres
// to an affine from continuous pixel coordinates to Mercator units. World
// files reference pixel centres, hence the half-pixel shifts.
export function worldFileToAffine(wf) {
  const [A, D, B, E, C, F] = wf;
  const k = 1 / EARTH_CIRCUMFERENCE;
  // mx = A*(u-0.5) + B*(v-0.5) + C ; x = mx*k + 0.5
  // my = D*(u-0.5) + E*(v-0.5) + F ; y = 0.5 - my*k
  return [
    A * k, B * k, (C - 0.5 * A - 0.5 * B) * k + 0.5,
    -D * k, -E * k, 0.5 - (F - 0.5 * D - 0.5 * E) * k,
  ];
}

export function affineToWorldFile(T) {
  const k = EARTH_CIRCUMFERENCE;
  const [a, b, c, d, e, f] = T;
  const A = a * k, B = b * k, D = -d * k, E = -e * k;
  // Centre of the top-left pixel.
  const [C, F] = mercToMeters(c + 0.5 * a + 0.5 * b, f + 0.5 * d + 0.5 * e);
  return [A, D, B, E, C, F];
}

// Longitude/latitude <-> MapLibre Mercator units, without MapLibre, so the
// exporters and tests can share them. No wrapping or clamping.
export function lngToMercX(lng) {
  return (lng + 180) / 360;
}

export function mercXToLng(x) {
  return x * 360 - 180;
}

export function latToMercY(lat) {
  return (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;
}

export function mercYToLat(y) {
  return 360 / Math.PI * Math.atan(Math.exp((180 - y * 360) * Math.PI / 180)) - 90;
}
