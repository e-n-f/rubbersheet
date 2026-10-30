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
// global affine part (T itself when there are fewer than two points), and
// with a nudge, base(u, v), the point warp alone.
//
// With a `nudge` field (see makeNudge), the result is the point warp plus the
// nudge offset at (u, v). The point warp aims at each target minus the nudge
// there, so control points still land exactly.
export function makeWarp(T, points, nudge = null) {
  if (!nudge) return pointWarp(T, points);
  const base = pointWarp(T, points.map(p => {
    const [dx, dy] = nudgeAt(nudge, p.u, p.v);
    return { ...p, x: p.x - dx, y: p.y - dy };
  }));
  return {
    S: base.S,
    base: base.map,
    map: (u, v) => {
      const [x, y] = base.map(u, v);
      const [dx, dy] = nudgeAt(nudge, u, v);
      return [x + dx, y + dy];
    },
  };
}

function pointWarp(T, points) {
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

// A nudge field: offsets in Mercator units at the nodes of a grid over the
// image, laid out like buildMesh's (cols across, rows to keep cells square),
// so a mesh with the same cols has a vertex at every node.
export function makeNudge(W, H, cols) {
  const nx = Math.max(1, cols);
  const ny = Math.max(1, Math.round(cols * H / W));
  const n = (nx + 1) * (ny + 1);
  return { W, H, nx, ny, dx: new Float64Array(n), dy: new Float64Array(n) };
}

// Bilinear offset at image pixel (u, v).
export function nudgeAt(n, u, v) {
  const fx = Math.min(Math.max(u / n.W * n.nx, 0), n.nx), fy = Math.min(Math.max(v / n.H * n.ny, 0), n.ny);
  const i = Math.min(Math.floor(fx), n.nx - 1), j = Math.min(Math.floor(fy), n.ny - 1);
  const a = fx - i, b = fy - j;
  const k = j * (n.nx + 1) + i, k2 = k + n.nx + 1;
  const w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
  return [
    w00 * n.dx[k] + w10 * n.dx[k + 1] + w01 * n.dx[k2] + w11 * n.dx[k2 + 1],
    w00 * n.dy[k] + w10 * n.dy[k + 1] + w01 * n.dy[k2] + w11 * n.dy[k2 + 1],
  ];
}

export function nudgeIsZero(n) {
  return n.dx.every(v => v === 0) && n.dy.every(v => v === 0);
}

// Push the nodes whose current positions (`pos`, a mesh's vertex positions
// on the same grid) lie within `radius` of (cx, cy) by (ddx, ddy), with a
// smooth falloff: full at the centre, nothing at the rim.
export function brushNudge(n, pos, cx, cy, radius, ddx, ddy) {
  const r2 = radius * radius;
  for (let k = 0; k < n.dx.length; k++) {
    const ex = pos[k * 2] - cx, ey = pos[k * 2 + 1] - cy;
    const d2 = ex * ex + ey * ey;
    if (d2 >= r2) continue;
    const t = 1 - d2 / r2;
    const w = t * t;
    n.dx[k] += w * ddx;
    n.dy[k] += w * ddy;
  }
}

// Evaluate the warp on a grid over the image. `cols` cells across; rows are
// chosen to keep cells roughly square. Positions are absolute Mercator units
// (Float64) so callers can rebase them before handing them to the GPU.
export function buildMesh(map, W, H, cols) {
  const nx = Math.max(1, cols);
  const ny = Math.max(1, Math.round(cols * H / W));
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

// Vertex index of grid node (i, j).
function node(mesh, i, j) {
  return j * (mesh.nx + 1) + i;
}

// Expand the grid into a flat list of triangles, positions relative to
// `origin`, as Float32 for upload.
export function meshTriangles(mesh, origin) {
  const { nx, ny, pos, uv } = mesh;
  const count = nx * ny * 6;
  const p = new Float32Array(count * 2);
  const t = new Float32Array(count * 2);
  let k = 0;
  const push = (n) => {
    p[k] = pos[n * 2] - origin[0];
    p[k + 1] = pos[n * 2 + 1] - origin[1];
    t[k] = uv[n * 2];
    t[k + 1] = uv[n * 2 + 1];
    k += 2;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = node(mesh, i, j), b = node(mesh, i + 1, j);
      const c = node(mesh, i, j + 1), d = node(mesh, i + 1, j + 1);
      push(a); push(b); push(c);
      push(b); push(d); push(c);
    }
  }
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
