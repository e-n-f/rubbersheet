#!/usr/bin/env python3
"""Prototype: find the georeferencing error of a scanned topographic map by
matching its black linework (roads and railroads) against modern vector data
(TIGER/Line shapefiles or OpenStreetMap ways), after Chiang, Knoblock, Duan
et al.'s work on aligning USGS historical topo maps with road vectors.

Steps:
  1. Pixel <-> lng/lat from the GeoTIFF's own georeferencing (via georef.mjs,
     which uses rubbersheet's TIFF reader and projections).
  2. Black linework: pixels darker than their surroundings and grey rather
     than brown (contours) or blue (water), minus small connected components
     (lettering, building dots).
  3. Vector lines sampled every couple of pixels and projected into the image
     with the original georeferencing.
  4. A global transform (translation, then similarity) that best lays the
     vectors on the linework, scored by a truncated (Gaussian) chamfer
     distance: mean exp(-d^2 / 2 sigma^2), d = distance to the nearest ink.
     Modern roads that aren't on the old map score ~0 wherever they go, so
     they add noise but no bias.
  5. Local corrections: a smooth offset field (bilinear on a grid of nodes)
     fitted to all the vector points at once, maximising the same score
     plus a penalty on the field's curvature. Where only one straight road
     passes, it only pins the offset across the road; the smoothness term
     fills in the rest from the neighbours.
  6. Control points (original pixel -> true lng/lat), plus diagnostics, and,
     if given a rubbersheet export with hand-placed control points, an
     evaluation against those.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy import optimize

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
EARTH_R = 6371008.8


# ---------------------------------------------------------------------------
# Georeferencing


class Georef:
    """Original pixel <-> WGS84 lng/lat, interpolated from georef.mjs's grid,
    with the inverse fitted as a cubic polynomial in local metres."""

    def __init__(self, tif):
        out = subprocess.run(['node', os.path.join(HERE, 'georef.mjs'), tif, '64'],
                             check=True, capture_output=True, text=True).stdout
        g = json.loads(out)
        self.W, self.H = g['width'], g['height']
        self.us = np.array(g['us'], float)
        self.vs = np.array(g['vs'], float)
        ll = np.array(g['lngLat'], float)  # [v][u][lng, lat]
        self.lng, self.lat = ll[..., 0], ll[..., 1]
        self.lat0 = float(self.lat.mean())
        self.lng0 = float(self.lng.mean())
        uu, vv = np.meshgrid(self.us, self.vs)
        x, y = self.to_m(self.lng.ravel(), self.lat.ravel())
        self.inv_u = self._fit(x, y, uu.ravel())
        self.inv_v = self._fit(x, y, vv.ravel())
        u2, v2 = self.from_lnglat(self.lng.ravel(), self.lat.ravel())
        err = np.hypot(u2 - uu.ravel(), v2 - vv.ravel()).max()
        if err > 0.25:
            print(f'warning: inverse georeferencing off by up to {err:.2f} px', file=sys.stderr)

    # Local equirectangular metres, for distances and fitting.
    def to_m(self, lng, lat):
        k = math.pi / 180
        return ((np.asarray(lng) - self.lng0) * k * EARTH_R * math.cos(self.lat0 * k),
                (np.asarray(lat) - self.lat0) * k * EARTH_R)

    @staticmethod
    def _terms(x, y):
        x = x / 1e4
        y = y / 1e4
        return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y,
                         x ** 3, x * x * y, x * y * y, y ** 3], -1)

    def _fit(self, x, y, t):
        c, *_ = np.linalg.lstsq(self._terms(x, y), t, rcond=None)
        return c

    def from_lnglat(self, lng, lat):
        x, y = self.to_m(lng, lat)
        A = self._terms(np.asarray(x, float), np.asarray(y, float))
        return A @ self.inv_u, A @ self.inv_v

    def to_lnglat(self, u, v):
        fu = np.interp(u, self.us, np.arange(len(self.us)))
        fv = np.interp(v, self.vs, np.arange(len(self.vs)))
        c = np.stack([fv, fu])
        return (ndi.map_coordinates(self.lng, c, order=1, mode='nearest'),
                ndi.map_coordinates(self.lat, c, order=1, mode='nearest'))

    def metres_per_pixel(self):
        x, y = self.to_m(self.lng, self.lat)
        return float(np.hypot(x[0, -1] - x[0, 0], y[0, -1] - y[0, 0]) / (self.us[-1] - self.us[0]))


# ---------------------------------------------------------------------------
# Linework


def extract_ink(rgb, min_extent):
    """Boolean mask of black linework."""
    a = rgb.astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = a.mean(-1)
    # Darker than the local background (works on faint lines and dark paper).
    tophat = ndi.grey_closing(lum, size=7) - lum
    ink = (tophat > 35) & (r - g < 30) & (b - r < 15)
    # Black ink on yellowed paper still reads redder than green (r - g ~ 15),
    # while faded blue drainage, shorelines and marsh hatching read greener
    # (r - g < 3). Single pixels are noisy, so average over nearby ink.
    f = ink.astype(np.float32)
    hue = ndi.gaussian_filter(f * (r - g), 4) / np.maximum(ndi.gaussian_filter(f, 4), 1e-3)
    ink &= hue >= 6
    # Drop lettering and dots: components smaller than min_extent pixels
    # in both directions.
    lab, n = ndi.label(ink, structure=np.ones((3, 3)))
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is not None and max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) >= min_extent:
            keep[i] = True
    return keep[lab]


def neatline_mask(geo, shape, margin=15):
    """Pixels inside the map's neatline, guessed as the georeferenced extent
    rounded inward to whole 7.5-minute lines (true of USGS quadrangles)."""
    q = 7.5 / 60
    w = math.ceil(geo.lng.min() / q - 0.05) * q
    e = math.floor(geo.lng.max() / q + 0.05) * q
    s = math.ceil(geo.lat.min() / q - 0.05) * q
    n = math.floor(geo.lat.max() / q + 0.05) * q
    # The corners are NAD27, the image WGS84, but a ~100 m difference
    # doesn't matter against the margin when only picking the 7.5' line.
    lng, lat = geo.to_lnglat(*np.meshgrid(np.arange(0, shape[1], 8.0), np.arange(0, shape[0], 8.0)))
    small = (lng > w) & (lng < e) & (lat > s) & (lat < n)
    small = ndi.binary_erosion(small, iterations=max(1, margin // 8))
    m = np.kron(small, np.ones((8, 8), bool))[:shape[0], :shape[1]]
    return m, (w, s, e, n)


# ---------------------------------------------------------------------------
# Vectors

# TIGER MTFCC codes kept: secondary roads, local roads, rail. Freeways
# (S1100), ramps, service drives, trails and walkways are almost all later
# than any historical map they'd be matched against.
TIGER_ROADS = {'S1200', 'S1400', 'S1500'}
OSM_ROADS = {'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
             'track', 'road', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}


def load_tiger(paths, bbox):
    import shapefile
    w, s, e, n = bbox
    lines = []
    for path in paths:
        with shapefile.Reader(path) as sf:
            fields = [f[0] for f in sf.fields[1:]]
            mi = fields.index('MTFCC')
            for sr in sf.iterShapeRecords():
                x0, y0, x1, y1 = sr.shape.bbox
                if x1 < w or x0 > e or y1 < s or y0 > n:
                    continue
                code = sr.record[mi]
                if not (code in TIGER_ROADS or code.startswith('R')):
                    continue
                kind = 'rail' if code.startswith('R') else 'road'
                pts, parts = sr.shape.points, list(sr.shape.parts) + [len(sr.shape.points)]
                for a, b in zip(parts[:-1], parts[1:]):
                    lines.append((kind, np.array(pts[a:b], float)))
    return lines


def load_osm(path, bbox):
    """Ways as written by fetch_osm.py: [{tags, pts: [[lng, lat], ...]}]."""
    w, s, e, n = bbox
    lines = []
    for way in json.load(open(path)):
        t = way['tags']
        rail = 'railway' in t and t['railway'] not in ('platform', 'station') or \
            any(k in t for k in ('abandoned:railway', 'disused:railway', 'historic:railway'))
        if not rail and t.get('highway') not in OSM_ROADS:
            continue
        p = np.array(way['pts'], float)
        if p[:, 0].max() < w or p[:, 0].min() > e or p[:, 1].max() < s or p[:, 1].min() > n:
            continue
        lines.append(('rail' if rail else 'road', p))
    return lines


def sample_lines(lines, geo, spacing):
    """Points every `spacing` px along each line, in original pixel
    coordinates. Returns (pts[N, 2], is_rail[N], line_id[N])."""
    out, rail, ids = [], [], []
    for i, (kind, ll) in enumerate(lines):
        u, v = geo.from_lnglat(ll[:, 0], ll[:, 1])
        p = np.stack([u, v], -1)
        seg = np.diff(p, axis=0)
        length = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.concatenate([[0], np.cumsum(length)])
        if cum[-1] < spacing:
            continue
        t = np.arange(0, cum[-1], spacing)
        q = np.stack([np.interp(t, cum, p[:, 0]), np.interp(t, cum, p[:, 1])], -1)
        out.append(q)
        rail.append(np.full(len(q), kind == 'rail'))
        ids.append(np.full(len(q), i))
    return np.concatenate(out), np.concatenate(rail), np.concatenate(ids)


# ---------------------------------------------------------------------------
# Matching


class Scorer:
    """Gaussian-truncated chamfer score of points against the ink."""

    def __init__(self, ink, sigma):
        self.dist = ndi.distance_transform_edt(~ink).astype(np.float32)
        self.set_sigma(sigma)

    def set_sigma(self, sigma):
        self.sigma = sigma
        self.field = np.exp(-self.dist ** 2 / (2 * sigma * sigma)).astype(np.float32)

    def values(self, p):
        return ndi.map_coordinates(self.field, [p[:, 1], p[:, 0]], order=1, mode='constant', cval=0)

    def score(self, p, w=None):
        s = self.values(p)
        return float(np.average(s, weights=w)) if w is not None else float(s.mean())

    def translation_surface(self, p, radius, step=1, w=None):
        """Score for every integer translation within +-radius (nearest
        lookup into the field, so fast)."""
        ts = np.arange(-radius, radius + 1, step)
        H, Wd = self.field.shape
        iu = np.rint(p[:, 0]).astype(int)
        iv = np.rint(p[:, 1]).astype(int)
        surf = np.zeros((len(ts), len(ts)), np.float32)
        for a, dv in enumerate(ts):
            vv = iv + dv
            okv = (vv >= 0) & (vv < H)
            for b, du in enumerate(ts):
                uu = iu + du
                ok = okv & (uu >= 0) & (uu < Wd)
                s = np.zeros(len(p), np.float32)
                s[ok] = self.field[vv[ok], uu[ok]]
                surf[a, b] = np.average(s, weights=w) if w is not None else s.mean()
        return ts, surf


def similarity_apply(params, p, c):
    """params = (tu, tv, log scale, angle) about centre c."""
    tu, tv, ls, ang = params
    k = math.exp(ls)
    ca, sa = k * math.cos(ang), k * math.sin(ang)
    d = p - c
    return np.stack([c[0] + ca * d[:, 0] - sa * d[:, 1] + tu,
                     c[1] + sa * d[:, 0] + ca * d[:, 1] + tv], -1)


def global_fit(scorer, pts, w, search_px, log):
    rng = np.random.default_rng(0)
    sub = rng.choice(len(pts), min(len(pts), 40000), replace=False)
    p, ws = pts[sub], w[sub]

    # Coarse translation search with a wide kernel, then finer.
    scorer.set_sigma(8)
    ts, surf = scorer.translation_surface(p, search_px, step=3, w=ws)
    a, b = np.unravel_index(np.argmax(surf), surf.shape)
    t0 = np.array([ts[b], ts[a]], float)
    log(f'coarse translation: {t0} px (score {surf.max():.3f}, '
        f'median {np.median(surf):.3f})')
    scorer.set_sigma(4)
    ts, surf = scorer.translation_surface(p + t0, 6, step=1, w=ws)
    a, b = np.unravel_index(np.argmax(surf), surf.shape)
    t0 = t0 + [ts[b], ts[a]]

    c = pts.mean(0)
    best = None
    for sigma in (4, 2.5):
        scorer.set_sigma(sigma)
        x0 = best if best is not None else np.array([t0[0], t0[1], 0.0, 0.0])
        f = lambda x: -scorer.score(similarity_apply(x, p, c), ws)
        res = optimize.minimize(f, x0, method='Powell',
                                options={'xtol': 1e-4, 'ftol': 1e-7, 'maxfev': 4000})
        best = res.x
    log(f'similarity: translation ({best[0]:.1f}, {best[1]:.1f}) px, scale {math.exp(best[2]):.5f}, '
        f'rotation {math.degrees(best[3]):.3f} deg, score {-res.fun:.3f}')
    return best, c


class Field:
    """A smooth offset field: bilinear interpolation of offsets on a grid of
    nodes `spacing` px apart over a W x H image."""

    def __init__(self, W, H, spacing):
        self.spacing = spacing
        self.nx = int(math.ceil(W / spacing)) + 1
        self.ny = int(math.ceil(H / spacing)) + 1
        self.n = self.nx * self.ny

    def basis(self, p):
        """Sparse N x nodes interpolation matrix."""
        from scipy import sparse
        fx = np.clip(p[:, 0] / self.spacing, 0, self.nx - 1.000001)
        fy = np.clip(p[:, 1] / self.spacing, 0, self.ny - 1.000001)
        ix, iy = fx.astype(int), fy.astype(int)
        ax, ay = fx - ix, fy - iy
        rows = np.repeat(np.arange(len(p)), 4)
        cols = np.stack([iy * self.nx + ix, iy * self.nx + ix + 1,
                         (iy + 1) * self.nx + ix, (iy + 1) * self.nx + ix + 1], -1).ravel()
        vals = np.stack([(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay], -1).ravel()
        return sparse.csr_matrix((vals, (rows, cols)), shape=(len(p), self.n))

    def laplacian(self):
        """Discrete Laplacian over the node grid (Neumann edges)."""
        from scipy import sparse
        idx = np.arange(self.n).reshape(self.ny, self.nx)
        r, c, v = [], [], []
        for y in range(self.ny):
            for x in range(self.nx):
                i = idx[y, x]
                nb = [idx[yy, xx] for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1))
                      if 0 <= yy < self.ny and 0 <= xx < self.nx]
                r += [i] * (len(nb) + 1)
                c += [i] + nb
                v += [-len(nb)] + [1] * len(nb)
        return sparse.csr_matrix((v, (r, c)), shape=(self.n, self.n))


def field_fit(scorer, pts, w, spacing, smooth, log, sigmas=(6, 4, 2.5)):
    """Offsets on a node grid that maximise the chamfer score of the points
    plus `smooth` x the squared Laplacian of the offsets (per node, in px)."""
    H, Wd = scorer.field.shape
    F = Field(Wd, H, spacing)
    B = F.basis(pts)
    L = F.laplacian()
    LtL = (L.T @ L).tocsr()
    wn = w / w.sum()
    x = np.zeros(2 * F.n)
    for sigma in sigmas:
        scorer.set_sigma(sigma)
        gy, gx = np.gradient(scorer.field)

        def f(x):
            du, dv = x[:F.n], x[F.n:]
            q = pts + np.stack([B @ du, B @ dv], -1)
            c = [q[:, 1], q[:, 0]]
            s = ndi.map_coordinates(scorer.field, c, order=1, mode='constant')
            su = ndi.map_coordinates(gx, c, order=1, mode='constant')
            sv = ndi.map_coordinates(gy, c, order=1, mode='constant')
            ru, rv = LtL @ du, LtL @ dv
            e = -(wn * s).sum() + smooth * (du @ ru + dv @ rv) / F.n
            g = np.concatenate([-(B.T @ (wn * su)) + 2 * smooth * ru / F.n,
                                -(B.T @ (wn * sv)) + 2 * smooth * rv / F.n])
            return e, g
        res = optimize.minimize(f, x, jac=True, method='L-BFGS-B', options={'maxiter': 500})
        x = res.x
    du, dv = x[:F.n].reshape(F.ny, F.nx), x[F.n:].reshape(F.ny, F.nx)
    mag = np.hypot(du, dv)
    log(f'field: {F.nx}x{F.ny} nodes {spacing} px apart, smoothness {smooth}: '
        f'offsets up to {mag.max():.1f} px (median {np.median(mag):.1f}), score {-res.fun:.3f}')

    def apply(p):
        Bp = F.basis(p)
        return p + np.stack([Bp @ x[:F.n], Bp @ x[F.n:]], -1)
    return apply, F, x


# ---------------------------------------------------------------------------
# Warp model (as rubbersheet: least-squares similarity + rigid MLS)


def fit_similarity(src, dst):
    sc, dc = src.mean(0), dst.mean(0)
    zs = (src - sc) @ [1, 1j]
    zd = (dst - dc) @ [1, 1j]
    k = (np.conj(zs) @ zd) / (np.conj(zs) @ zs)

    def f(p):
        z = ((p - sc) @ [1, 1j]) * k
        return np.stack([z.real, z.imag], -1) + dc
    return f


def make_warp(src, dst):
    """Map src -> dst points: similarity, then rigid MLS (Schaefer 2006)
    so that each control point lands exactly."""
    S = fit_similarity(src, dst)
    P = S(src)

    def f(v):
        v = np.atleast_2d(v)
        out = np.empty_like(v, dtype=float)
        for j, (x, y) in enumerate(S(v)):
            d2 = ((P - [x, y]) ** 2).sum(1)
            if d2.min() < 1e-12:
                out[j] = dst[d2.argmin()]
                continue
            wt = 1 / d2
            ps = (wt[:, None] * P).sum(0) / wt.sum()
            qs = (wt[:, None] * dst).sum(0) / wt.sum()
            ph, qh = P - ps, dst - qs
            mr = (wt * (ph[:, 0] * qh[:, 0] + ph[:, 1] * qh[:, 1])).sum()
            mi = (wt * (ph[:, 0] * qh[:, 1] - ph[:, 1] * qh[:, 0])).sum()
            ln = math.hypot(mr, mi)
            cr, ci = (mr / ln, mi / ln) if ln > 0 else (1, 0)
            rx, ry = x - ps[0], y - ps[1]
            out[j] = [rx * cr - ry * ci + qs[0], rx * ci + ry * cr + qs[1]]
        return out
    return f


# ---------------------------------------------------------------------------
# Evaluation against a rubbersheet export


def load_reference(path, tif, geo):
    """Control points from a rubbersheet GeoTIFF/PNG export's metadata, as
    (original pixel, lng/lat). rubbersheet reprojects non-Mercator GeoTIFFs to
    a Mercator raster first and records sourcePixel in that raster, so the
    pixels are mapped back through the same reprojection (georef.mjs's
    sibling, refpoints.mjs)."""
    out = subprocess.run(['node', os.path.join(HERE, 'refpoints.mjs'), tif, path],
                         check=True, capture_output=True, text=True).stdout
    pts = json.loads(out)
    return np.array([p['pixel'] for p in pts]), np.array([p['lngLat'] for p in pts])


def evaluate(name, predict, ref_px, ref_ll, geo, log):
    lng, lat = predict(ref_px)
    x0, y0 = geo.to_m(lng, lat)
    x1, y1 = geo.to_m(ref_ll[:, 0], ref_ll[:, 1])
    e = np.hypot(x1 - x0, y1 - y0)
    log(f'  {name:<28} rms {math.sqrt((e ** 2).mean()):6.1f} m   median {np.median(e):6.1f} m   max {e.max():6.1f} m')
    log('    per point (m): ' + ' '.join(f'{x:.0f}' for x in e))
    return e


# ---------------------------------------------------------------------------
# Diagnostics


def overlay(rgb, segments, path, box=None, scale=1.0):
    """Draw vector polylines (list of (color, Nx2 px arrays)) over the map."""
    im = Image.fromarray(rgb)
    if box:
        im = im.crop(box)
    off = np.array(box[:2] if box else (0, 0), float)
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    im = im.convert('RGB')
    d = ImageDraw.Draw(im)
    for color, p in segments:
        q = (p - off) * scale
        d.line([tuple(x) for x in q], fill=color, width=2)
    im.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tif', help='georeferenced scan (GeoTIFF)')
    ap.add_argument('--tiger', nargs='*', default=[], help='TIGER/Line road or rail shapefiles (.shp)')
    ap.add_argument('--osm', help='OSM ways JSON from fetch_osm.py')
    ap.add_argument('--reference', help='rubbersheet export with hand-placed control points, to evaluate against')
    ap.add_argument('--out', default='out', help='output directory')
    ap.add_argument('--whole-image', action='store_true',
                    help='match over the whole image, for maps that run past their neatline')
    ap.add_argument('--search', type=float, default=600, help='global search radius, metres')
    ap.add_argument('--spacing', type=float, default=1500, help='node spacing of the local offset field, metres')
    ap.add_argument('--smooth', type=float, default=0.01, help='weight of the local field\'s smoothness')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    report = open(os.path.join(args.out, 'report.txt'), 'w')

    def log(s):
        print(s)
        report.write(s + '\n')

    geo = Georef(args.tif)
    mpp = geo.metres_per_pixel()
    log(f'{os.path.basename(args.tif)}: {geo.W}x{geo.H}, {mpp:.2f} m/px')

    rgb = np.asarray(Image.open(args.tif).convert('RGB'))
    if args.whole_image:
        inside = np.zeros(rgb.shape[:2], bool)
        inside[40:-40, 40:-40] = True
    else:
        inside, quad = neatline_mask(geo, rgb.shape[:2])
        log(f'neatline (guessed): {quad}')
    ink = extract_ink(rgb, min_extent=int(round(500 / mpp))) & inside
    log(f'ink: {ink.mean() * 100:.2f}% of pixels')
    Image.fromarray(np.where(ink, 0, 255).astype(np.uint8)).save(os.path.join(args.out, 'ink.png'))

    bbox = (geo.lng.min() - 0.01, geo.lat.min() - 0.01, geo.lng.max() + 0.01, geo.lat.max() + 0.01)
    lines = load_tiger(args.tiger, bbox) if args.tiger else []
    if args.osm:
        lines += load_osm(args.osm, bbox)
    log(f'vector lines: {len(lines)} ({sum(k == "rail" for k, _ in lines)} rail)')
    pts, is_rail, ids = sample_lines(lines, geo, spacing=2.0)
    # Keep points inside the neatline (with room for the offset).
    keep_in = ndi.binary_erosion(inside, iterations=1)
    iu = np.clip(np.rint(pts[:, 0]).astype(int), 0, geo.W - 1)
    iv = np.clip(np.rint(pts[:, 1]).astype(int), 0, geo.H - 1)
    m = keep_in[iv, iu]
    pts, is_rail, ids = pts[m], is_rail[m], ids[m]
    # Railroads are the most persistent features; weight them up.
    w = np.where(is_rail, 3.0, 1.0)
    log(f'vector samples: {len(pts)} ({is_rail.sum()} rail)')

    scorer = Scorer(ink, 4)
    params, centre = global_fit(scorer, pts, w, int(args.search / mpp), log)
    gpts = similarity_apply(params, pts, centre)
    log(f'support: {(scorer.dist < 2).mean() * 100:.2f}% of pixels within 2 px of ink')
    warp_field, F, _ = field_fit(scorer, gpts, w, spacing=int(args.spacing / mpp), smooth=args.smooth, log=log)

    # The full model takes original pixel p (where a feature's true location
    # falls under the original georeferencing) to map pixel q (where it's
    # drawn): q = field(G(p)). Its inverse gives each map pixel's true place.
    def forward(p):
        return warp_field(similarity_apply(params, p, centre))

    def global_inverse(q):
        tu, tv, ls, ang = params
        return similarity_apply((0, 0, -ls, -ang), q - [tu, tv], centre)

    def inverse(q):
        z = q.astype(float).copy()
        for _ in range(20):
            z = z - (warp_field(z) - q)
        return global_inverse(z)

    # Control points on a grid, where there's linework to support them.
    near = ndi.distance_transform_edt(scorer.dist > 2) * mpp < args.spacing / 2
    step = int(args.spacing / mpp)
    grid = np.array([(u, v) for v in range(step // 2, geo.H, step) for u in range(step // 2, geo.W, step)
                     if inside[v, u] and near[v, u]], float)
    truth = inverse(grid)
    lng, lat = geo.to_lnglat(truth[:, 0], truth[:, 1])
    cps = [dict(pixel=q.tolist(), lngLat=[float(a), float(b)]) for q, a, b in zip(grid, lng, lat)]
    json.dump(dict(source=os.path.basename(args.tif),
                   globalSimilarity=dict(translationPx=params[:2].tolist(), scale=math.exp(params[2]),
                                         rotationDeg=math.degrees(params[3]), centrePx=centre.tolist()),
                   controlPoints=cps), open(os.path.join(args.out, 'controlpoints.json'), 'w'), indent=1)
    log(f'wrote {len(cps)} control points')

    # Diagnostics: vectors before (red), after the global fit (green) and
    # after the local field (blue), over the map; and the offsets.
    segs = {'before': [], 'global': [], 'local': []}
    order = np.argsort(ids, kind='stable')
    splits = np.flatnonzero(np.diff(ids[order])) + 1
    for idx in np.split(order, splits):
        if len(idx) < 2:
            continue
        p = pts[idx]
        segs['before'].append(((230, 0, 0), p))
        segs['global'].append(((0, 170, 0), gpts[idx]))
        segs['local'].append(((0, 90, 255), forward(p)))
    for name, sg in segs.items():
        overlay(rgb, sg, os.path.join(args.out, f'{name}.jpg'), scale=0.25)
    # Detail crops at full resolution.
    for i, (u, v) in enumerate([(2300, 1700), (3800, 4300)]):
        box = (u, v, u + 900, v + 700)
        overlay(rgb, segs['before'] + segs['local'], os.path.join(args.out, f'detail{i}.jpg'), box=box)
    small = 0.25
    im = Image.fromarray(rgb).resize((int(geo.W * small), int(geo.H * small))).convert('RGB')
    d = ImageDraw.Draw(im)
    for q in grid:
        tot = (q - inverse(q[None])[0]) * small * 5
        qs = q * small
        d.line([tuple(qs), tuple(qs - tot)], fill=(0, 90, 255), width=3)
        d.ellipse([qs[0] - 3, qs[1] - 3, qs[0] + 3, qs[1] + 3], fill=(0, 90, 255))
    im.save(os.path.join(args.out, 'offsets.jpg'))

    if args.reference:
        ref_px, ref_ll = load_reference(args.reference, args.tif, geo)
        log(f'evaluation against {len(ref_px)} hand-placed control points:')
        evaluate('original georeferencing', lambda p: geo.to_lnglat(p[:, 0], p[:, 1]), ref_px, ref_ll, geo, log)

        def pred_global(p):
            o = global_inverse(p)
            return geo.to_lnglat(o[:, 0], o[:, 1])
        evaluate('global similarity', pred_global, ref_px, ref_ll, geo, log)

        def pred_local(p):
            o = inverse(p)
            return geo.to_lnglat(o[:, 0], o[:, 1])
        evaluate('similarity + smooth field', pred_local, ref_px, ref_ll, geo, log)
        # Contact sheet: each hand point (red ring) and where the model puts
        # the same true location (blue cross), with the corrected vectors.
        rp = np.stack(geo.from_lnglat(ref_ll[:, 0], ref_ll[:, 1]), -1)
        mp = forward(rp)
        tiles = []
        for k, (h, q) in enumerate(zip(ref_px, mp)):
            box = (int(h[0]) - 150, int(h[1]) - 150, int(h[0]) + 150, int(h[1]) + 150)
            near_segs = [s for s in segs['local'] if np.abs(s[1] - h).max(1).min() < 200]
            t = Image.fromarray(rgb).crop(box).convert('RGB')
            dr = ImageDraw.Draw(t)
            for col, p in near_segs:
                dr.line([tuple(x) for x in (p - box[:2])], fill=col, width=1)
            c = h - box[:2]
            dr.ellipse([c[0] - 6, c[1] - 6, c[0] + 6, c[1] + 6], outline=(255, 0, 0), width=2)
            c = q - box[:2]
            dr.line([c[0] - 7, c[1], c[0] + 7, c[1]], fill=(0, 0, 255), width=2)
            dr.line([c[0], c[1] - 7, c[0], c[1] + 7], fill=(0, 0, 255), width=2)
            dr.text((4, 4), str(k + 1), fill=(255, 0, 0))
            tiles.append(t)
        cols = 6
        sheet = Image.new('RGB', (300 * cols, 300 * ((len(tiles) + cols - 1) // cols)), 'white')
        for k, t in enumerate(tiles):
            sheet.paste(t, (300 * (k % cols), 300 * (k // cols)))
        sheet.save(os.path.join(args.out, 'reference.jpg'))
        # What the hand points imply, for comparison.
        # How well the hand points predict each other (leave one out, through
        # rubbersheet's similarity + rigid MLS warp): the bar to clear.
        loo = []
        for k in range(len(rp)):
            m = np.arange(len(rp)) != k
            o = make_warp(ref_px[m], rp[m])(ref_px[k:k + 1])
            loo.append(geo.to_lnglat(o[:, 0], o[:, 1]))
        evaluate('hand points, leave-one-out', lambda p: (np.concatenate([a for a, _ in loo]),
                                                          np.concatenate([b for _, b in loo])),
                 ref_px, ref_ll, geo, log)
        f = fit_similarity(rp, ref_px)
        r = np.hypot(*(f(rp) - ref_px).T) * mpp
        log(f'  (hand points vs. their own best similarity: rms {math.sqrt((r ** 2).mean()):.1f} m)')
        d = (ref_px - rp) * mpp
        log(f'  (hand points: mean map-vs-truth offset {d[:, 0].mean():.0f} m right, {d[:, 1].mean():.0f} m down)')
    report.close()


if __name__ == '__main__':
    main()
