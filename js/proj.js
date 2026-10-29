// Map projections for placing GeoTIFFs: enough to turn a file's GeoKeys into
// a function from its model coordinates to WGS84 longitude/latitude.
//
// Supported: geographic (lat/lon), Web Mercator, Transverse Mercator (and
// so UTM), Lambert Conformal Conic (1SP and 2SP) and Polyconic, on WGS84,
// NAD83, ETRS89 or NAD27. Formulas follow Snyder, "Map Projections: A
// Working Manual" (USGS PP 1395, 1987). NAD27 is shifted to WGS84 with the
// mean CONUS 3-parameter shift, good to about 5–10 m.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const ELLIPSOIDS = {
  WGS84: { a: 6378137, rf: 298.257223563 },
  GRS80: { a: 6378137, rf: 298.257222101 },
  Clarke1866: { a: 6378206.4, rf: 294.978698213898 },
};

// Datums: ellipsoid and 3-parameter shift to WGS84 (metres).
export const DATUMS = {
  WGS84: { ellipsoid: ELLIPSOIDS.WGS84, shift: [0, 0, 0] },
  NAD83: { ellipsoid: ELLIPSOIDS.GRS80, shift: [0, 0, 0] },
  ETRS89: { ellipsoid: ELLIPSOIDS.GRS80, shift: [0, 0, 0] },
  NAD27: { ellipsoid: ELLIPSOIDS.Clarke1866, shift: [-8, 160, 176] },
};

function ellipsoid({ a, rf }) {
  const f = rf ? 1 / rf : 0;
  const e2 = f * (2 - f);
  return { a, e2, e: Math.sqrt(e2) };
}

// Meridian arc length from the equator (Snyder 3-21) and its derivative
// with respect to latitude, divided by a.
function meridian({ a, e2 }) {
  const e4 = e2 * e2, e6 = e4 * e2;
  const c0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
  const c2 = 3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024;
  const c4 = 15 * e4 / 256 + 45 * e6 / 1024;
  const c6 = 35 * e6 / 3072;
  return {
    c0,
    M: (p) => a * (c0 * p - c2 * Math.sin(2 * p) + c4 * Math.sin(4 * p) - c6 * Math.sin(6 * p)),
    dM: (p) => c0 - 2 * c2 * Math.cos(2 * p) + 4 * c4 * Math.cos(4 * p) - 6 * c6 * Math.cos(6 * p),
  };
}

// Each projection takes parameters in degrees and metres and returns
// {forward(lng, lat) -> [x, y], inverse(x, y) -> [lng, lat]} on its ellipsoid,
// with x, y in metres including false easting/northing.

export function transverseMercator(ell, { lon0, lat0 = 0, k0 = 1, x0 = 0, y0 = 0 }) {
  const { a, e2 } = ellipsoid(ell);
  const ep2 = e2 / (1 - e2);
  const { M, c0 } = meridian({ a, e2 });
  const M0 = M(lat0 * D2R);
  const l0 = lon0 * D2R;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  return {
    forward(lng, lat) {
      const p = lat * D2R, sp = Math.sin(p), cp = Math.cos(p);
      const N = a / Math.sqrt(1 - e2 * sp * sp);
      const T = Math.tan(p) ** 2, C = ep2 * cp * cp, A = (lng * D2R - l0) * cp;
      const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
      const y = k0 * (M(p) - M0 + N * Math.tan(p) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 +
        (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
      return [x + x0, y + y0];
    },
    inverse(x, y) {
      x -= x0;
      y -= y0;
      const mu = (M0 + y / k0) / (a * c0);
      const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
        (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
        (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const sp = Math.sin(p1), cp = Math.cos(p1), tp = Math.tan(p1);
      const C1 = ep2 * cp * cp, T1 = tp * tp;
      const N1 = a / Math.sqrt(1 - e2 * sp * sp);
      const R1 = a * (1 - e2) / (1 - e2 * sp * sp) ** 1.5;
      const D = x / (N1 * k0);
      const lat = p1 - (N1 * tp / R1) * (D * D / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 +
        (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
      const lng = l0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 +
        (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cp;
      return [lng * R2D, lat * R2D];
    },
  };
}

export function utm(ell, zone, south = false) {
  return transverseMercator(ell, { lon0: zone * 6 - 183, k0: 0.9996, x0: 500000, y0: south ? 10000000 : 0 });
}

// Lambert Conformal Conic. Give lat1 and lat2 for the 2SP form, or k0 (with
// lat1 = lat0) for 1SP.
export function lambertConformalConic(ell, { lon0, lat0, lat1, lat2 = lat1, k0 = 1, x0 = 0, y0 = 0 }) {
  const { a, e } = ellipsoid(ell);
  const m = (p) => Math.cos(p) / Math.sqrt(1 - (e * Math.sin(p)) ** 2);
  const t = (p) => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1)
    : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const aF = a * F * k0;
  const rho0 = aF * t(lat0 * D2R) ** n;
  const l0 = lon0 * D2R;
  return {
    forward(lng, lat) {
      const rho = aF * t(lat * D2R) ** n;
      const theta = n * (lng * D2R - l0);
      return [x0 + rho * Math.sin(theta), y0 + rho0 - rho * Math.cos(theta)];
    },
    inverse(x, y) {
      x -= x0;
      y -= y0;
      const s = Math.sign(n);
      const rho = s * Math.hypot(x, rho0 - y);
      const theta = Math.atan2(s * x, s * (rho0 - y));
      const tt = (rho / aF) ** (1 / n);
      let p = Math.PI / 2 - 2 * Math.atan(tt);
      for (let i = 0; i < 15; i++) {
        const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2));
        if (Math.abs(next - p) < 1e-14) {
          p = next;
          break;
        }
        p = next;
      }
      return [(theta / n + l0) * R2D, p * R2D];
    },
  };
}

// American Polyconic (Snyder 18).
export function polyconic(ell, { lon0, lat0 = 0, x0 = 0, y0 = 0 }) {
  const { a, e2 } = ellipsoid(ell);
  const { M, dM } = meridian({ a, e2 });
  const M0 = M(lat0 * D2R);
  const l0 = lon0 * D2R;
  return {
    forward(lng, lat) {
      const p = lat * D2R, l = lng * D2R - l0;
      if (Math.abs(p) < 1e-12) return [x0 + a * l, y0 - M0];
      const sp = Math.sin(p);
      const N = a / Math.sqrt(1 - e2 * sp * sp);
      const E = l * sp, cot = 1 / Math.tan(p);
      return [x0 + N * cot * Math.sin(E), y0 + M(p) - M0 + N * cot * (1 - Math.cos(E))];
    },
    inverse(x, y) {
      x -= x0;
      y -= y0;
      if (Math.abs(y + M0) < 1e-9) return [(x / a + l0) * R2D, 0];
      const A = (M0 + y) / a, B = x * x / (a * a) + A * A;
      let p = A, C = 0;
      for (let i = 0; i < 20; i++) {
        const sp = Math.sin(p), s2 = Math.sin(2 * p);
        C = Math.sqrt(1 - e2 * sp * sp) * Math.tan(p);
        const Ma = M(p) / a, Mp = dM(p);
        const dp = (A * (C * Ma + 1) - Ma - 0.5 * (Ma * Ma + B) * C) /
          (e2 * s2 * (Ma * Ma + B - 2 * A * Ma) / (4 * C) + (A - Ma) * (C * Mp - 2 / s2) - Mp);
        p -= dp;
        if (Math.abs(dp) < 1e-14) break;
      }
      C = Math.sqrt(1 - e2 * Math.sin(p) ** 2) * Math.tan(p);
      return [(Math.asin(x * C / a) / Math.sin(p) + l0) * R2D, p * R2D];
    },
  };
}

// Shift lng/lat on `datum` to WGS84 through geocentric coordinates.
export function toWGS84(datum, lng, lat) {
  const [dx, dy, dz] = datum.shift;
  if (!dx && !dy && !dz) return [lng, lat];
  const src = ellipsoid(datum.ellipsoid), dst = ellipsoid(ELLIPSOIDS.WGS84);
  const p = lat * D2R, l = lng * D2R;
  const N = src.a / Math.sqrt(1 - src.e2 * Math.sin(p) ** 2);
  const X = N * Math.cos(p) * Math.cos(l) + dx;
  const Y = N * Math.cos(p) * Math.sin(l) + dy;
  const Z = N * (1 - src.e2) * Math.sin(p) + dz;
  const r = Math.hypot(X, Y);
  let q = Math.atan2(Z, r * (1 - dst.e2));
  for (let i = 0; i < 5; i++) {
    const Nq = dst.a / Math.sqrt(1 - dst.e2 * Math.sin(q) ** 2);
    q = Math.atan2(Z + dst.e2 * Nq * Math.sin(q), r);
  }
  return [Math.atan2(Y, X) * R2D, q * R2D];
}

// ---------------------------------------------------------------------------
// GeoKeys

const K = {
  GTModelType: 1024, GeographicType: 2048, GeogGeodeticDatum: 2050, GeogEllipsoid: 2056,
  GeogSemiMajorAxis: 2057, GeogSemiMinorAxis: 2058, GeogInvFlattening: 2059,
  ProjectedCSType: 3072, Projection: 3074, ProjCoordTrans: 3075, ProjLinearUnits: 3076,
  ProjLinearUnitSize: 3077, StdParallel1: 3078, StdParallel2: 3079, NatOriginLong: 3080,
  NatOriginLat: 3081, FalseEasting: 3082, FalseNorthing: 3083, FalseOriginLong: 3084,
  FalseOriginLat: 3085, FalseOriginEasting: 3086, FalseOriginNorthing: 3087, CenterLong: 3088,
  CenterLat: 3089, ScaleAtNatOrigin: 3092, ScaleAtCenter: 3093,
};

const GEOGRAPHIC_CODES = { 4326: 'WGS84', 4269: 'NAD83', 4258: 'ETRS89', 4267: 'NAD27', 4019: 'NAD83' };
const DATUM_CODES = { 6326: 'WGS84', 6269: 'NAD83', 6258: 'ETRS89', 6267: 'NAD27' };
const ELLIPSOID_CODES = { 7030: ELLIPSOIDS.WGS84, 7019: ELLIPSOIDS.GRS80, 7008: ELLIPSOIDS.Clarke1866 };
const UNIT_METRES = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937 };

function datumFromKeys(g) {
  const name = GEOGRAPHIC_CODES[g[K.GeographicType]] || DATUM_CODES[g[K.GeogGeodeticDatum]];
  if (name) return DATUMS[name];
  let ell = ELLIPSOID_CODES[g[K.GeogEllipsoid]];
  if (!ell && g[K.GeogSemiMajorAxis]) {
    const a = g[K.GeogSemiMajorAxis];
    const rf = g[K.GeogInvFlattening] ?? (g[K.GeogSemiMinorAxis] ? a / (a - g[K.GeogSemiMinorAxis]) : 0);
    ell = { a, rf };
  }
  if (!ell) return DATUMS.WGS84;
  // An unnamed datum on Clarke 1866 is NAD27 in practice.
  if (Math.abs(ell.a - 6378206.4) < 1) return DATUMS.NAD27;
  return { ellipsoid: ell, shift: [0, 0, 0] };
}

// The projection for an EPSG projected CRS code, or null.
function projectedFromEPSG(code) {
  if (code >= 32601 && code <= 32660) return { datum: DATUMS.WGS84, proj: utm(ELLIPSOIDS.WGS84, code - 32600) };
  if (code >= 32701 && code <= 32760) return { datum: DATUMS.WGS84, proj: utm(ELLIPSOIDS.WGS84, code - 32700, true) };
  if (code >= 26901 && code <= 26923) return { datum: DATUMS.NAD83, proj: utm(ELLIPSOIDS.GRS80, code - 26900) };
  if (code >= 26701 && code <= 26722) return { datum: DATUMS.NAD27, proj: utm(ELLIPSOIDS.Clarke1866, code - 26700) };
  if (code >= 25828 && code <= 25838) return { datum: DATUMS.ETRS89, proj: utm(ELLIPSOIDS.GRS80, code - 25800) };
  return null;
}

// Turn resolved GeoKeys ({keyId: value}) into {kind, toLngLat(X, Y)}, where
// kind is 'mercator' (X, Y are EPSG:3857 metres, for an exact affine
// placement), or 'geographic' / 'projected'. Throws with a readable reason if
// the CRS isn't supported.
export function crsFromGeoKeys(g) {
  const model = g[K.GTModelType];
  if (model === 2) {
    const datum = datumFromKeys(g);
    return { kind: 'geographic', toLngLat: (X, Y) => toWGS84(datum, X, Y) };
  }
  if (model !== 1) throw new Error('the GeoTIFF has no map projection');
  const code = g[K.ProjectedCSType];
  if ([3857, 3785, 900913, 102100, 102113].includes(code)) {
    return { kind: 'mercator', toLngLat: null };
  }
  let datum, proj;
  const known = code && code !== 32767 ? projectedFromEPSG(code) : null;
  if (known) ({ datum, proj } = known);
  else if (code && code !== 32767) {
    throw new Error(`projection EPSG:${code} isn’t supported (UTM, Lambert conformal conic, ` +
      'polyconic and transverse Mercator are, when the file spells out their parameters)');
  } else {
    datum = datumFromKeys(g);
    const ell = datum.ellipsoid;
    const unit = g[K.ProjLinearUnitSize] || UNIT_METRES[g[K.ProjLinearUnits] ?? 9001];
    if (!unit) throw new Error(`linear unit ${g[K.ProjLinearUnits]} isn’t supported`);
    const projection = g[K.Projection];
    const zone = projection >= 16001 && projection <= 16060 ? projection - 16000
      : projection >= 16101 && projection <= 16160 ? -(projection - 16100) : 0;
    const pick = (...keys) => keys.map(k => g[k]).find(v => v !== undefined);
    const lon0 = pick(K.NatOriginLong, K.FalseOriginLong, K.CenterLong) ?? 0;
    const lat0 = pick(K.NatOriginLat, K.FalseOriginLat, K.CenterLat) ?? 0;
    const x0 = (pick(K.FalseEasting, K.FalseOriginEasting) ?? 0) * unit;
    const y0 = (pick(K.FalseNorthing, K.FalseOriginNorthing) ?? 0) * unit;
    const k0 = pick(K.ScaleAtNatOrigin, K.ScaleAtCenter) ?? 1;
    const trans = g[K.ProjCoordTrans];
    if (zone) proj = utm(ell, Math.abs(zone), zone < 0);
    else if (trans === 1) proj = transverseMercator(ell, { lon0, lat0, k0, x0, y0 });
    else if (trans === 8) {
      proj = lambertConformalConic(ell, {
        lon0: pick(K.FalseOriginLong, K.NatOriginLong) ?? 0, lat0: pick(K.FalseOriginLat, K.NatOriginLat) ?? 0,
        lat1: g[K.StdParallel1], lat2: g[K.StdParallel2], x0, y0,
      });
    } else if (trans === 9) proj = lambertConformalConic(ell, { lon0, lat0, lat1: lat0, k0, x0, y0 });
    else if (trans === 22) proj = polyconic(ell, { lon0, lat0, x0, y0 });
    else if (trans === 7 && ell.a === 6378137 && datum.shift.every(v => !v) && !lat0) {
      return { kind: 'mercator', toLngLat: null };
    } else {
      throw new Error(`map projection type ${trans ?? 'unknown'} isn’t supported ` +
        '(UTM, Lambert conformal conic, polyconic and transverse Mercator are)');
    }
    const p = proj;
    proj = { inverse: (X, Y) => p.inverse(X * unit, Y * unit) };
  }
  return {
    kind: 'projected',
    toLngLat: (X, Y) => {
      const [lng, lat] = proj.inverse(X, Y);
      return toWGS84(datum, lng, lat);
    },
  };
}
