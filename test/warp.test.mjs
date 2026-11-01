import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAffine, fitSimilarity, makeWarp, buildMesh, invertMesh,
  worldFileToAffine, affineToWorldFile, similarityAboutPivot,
  lngToMercX, mercXToLng, latToMercY, mercYToLat,
  sampleMesh,
  refineMesh, invertDrawn, meshTriangles, refinedSoup,
} from '../js/warp.js';
import { addChunk, addTextChunk, readChunk, readTextChunks } from '../js/png-text.js';
import { makeZip, readZip } from '../js/zip.js';
import { isTIFF, readGeoTIFF, readTIFFTags, writeGeoTIFF } from '../js/tiff.js';
import { crsFromGeoKeys, ELLIPSOIDS, utm, polyconic, lambertConformalConic } from '../js/proj.js';

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('similarity through two points is exact', () => {
  const S = fitSimilarity([[0, 0], [100, 0]], [[0.5, 0.5], [0.5, 0.5001]]);
  const [x, y] = applyAffine(S, 100, 0);
  close(x, 0.5); close(y, 0.5001);
});

test('MLS warp hits every control point exactly', () => {
  const T = [1e-6, 0, 0.3, 0, 1e-6, 0.4];
  const pts = [[0, 0], [1000, 0], [0, 800], [1000, 800], [500, 400]].map(([u, v], i) => {
    const [x, y] = applyAffine(T, u, v);
    return { u, v, x: x + (i % 2 ? 3e-5 : -2e-5), y: y + (i === 4 ? 5e-5 : 0) };
  });
  const w = makeWarp(T, pts);
  for (const p of pts) {
    const [x, y] = w.map(p.u, p.v);
    close(x, p.x); close(y, p.y);
  }
});

test('unbent points leave the image an exact similarity', () => {
  const S0 = [2e-6, -1e-6, 0.3, 1e-6, 2e-6, 0.4];
  const pts = [[0, 0], [900, 10], [20, 700], [400, 300]].map(([u, v]) => {
    const [x, y] = applyAffine(S0, u, v);
    return { u, v, x, y };
  });
  const w = makeWarp(null, pts);
  const [x, y] = w.map(123, 456);
  const [ex, ey] = applyAffine(S0, 123, 456);
  close(x, ex, 1e-14); close(y, ey, 1e-14);
});

test('mesh inversion round-trips', () => {
  const T = [1e-6, 2e-7, 0.3, -2e-7, 1e-6, 0.4];
  const pts = [[0, 0], [1000, 0], [0, 800], [600, 500]].map(([u, v], i) => {
    const [x, y] = applyAffine(T, u, v);
    return { u, v, x: x + i * 1e-5, y };
  });
  const w = makeWarp(T, pts);
  const mesh = buildMesh(w.map, 1000, 800, 64);
  const [x, y] = w.map(300, 200);
  const uv = invertMesh(mesh, x, y);
  assert.ok(Math.hypot(uv[0] - 300, uv[1] - 200) < 1, `${uv}`);
  assert.equal(invertMesh(mesh, 0.9, 0.9), null);
});

test('sampling a mesh on a grid agrees with inverting it point by point', () => {
  const T = [1e-6, 2e-7, 0.3, -2e-7, 1e-6, 0.4];
  const pts = [[0, 0], [1000, 0], [0, 800], [600, 500]].map(([u, v], i) => {
    const [x, y] = applyAffine(T, u, v);
    return { u, v, x: x + i * 1e-5, y };
  });
  const mesh = buildMesh(makeWarp(T, pts).map, 1000, 800, 32);
  // A screen-like plane: Mercator units scaled up and shifted.
  const k = 2e6, A = [k, 0, -0.3 * k + 50, 0, k, -0.4 * k + 50];
  const nx = 60, ny = 50, step = 40;
  const out = sampleMesh(mesh, A, nx, ny, step);
  let inside = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i * step - A[2]) / k, y = (j * step - A[5]) / k;
      const want = invertMesh(mesh, x, y), u = out[(j * nx + i) * 2], v = out[(j * nx + i) * 2 + 1];
      if (!want) {
        assert.ok(Number.isNaN(u), `node ${i},${j} should be outside`);
        continue;
      }
      inside++;
      assert.ok(Math.hypot(u - want[0], v - want[1]) < 1e-6, `node ${i},${j}: ${u},${v} vs ${want}`);
    }
  }
  assert.ok(inside > 100);
});

test('a refined patch follows the warp exactly and replaces the cells it covers', () => {
  const T = [1e-6, 0, 0.3, 0, 1e-6, 0.4];
  const pts = [[0, 0], [1000, 0], [0, 800], [1000, 800], [530, 420]].map(([u, v], i) => {
    const [x, y] = applyAffine(T, u, v);
    return { u, v, x: x + (i === 4 ? 1e-4 : 0), y };  // a 100 px re-pin, between coarse nodes
  });
  const w = makeWarp(T, pts);
  const mesh = buildMesh(w.map, 1000, 800, 10);
  const fine = refineMesh(w.map, mesh, 4, 3, 6, 5, 8);
  assert.equal(fine.mesh.nx, 16); assert.equal(fine.mesh.ny, 16);
  // Close at the re-pinned point (530, 420), where the coarse mesh alone is well off.
  const uv = invertDrawn(mesh, fine, ...w.map(530, 420));
  assert.ok(Math.hypot(uv[0] - 530, uv[1] - 420) < 0.5, `${uv}`);
  const coarse = invertMesh(mesh, ...w.map(530, 420));
  assert.ok(Math.hypot(coarse[0] - 530, coarse[1] - 420) > 2, `coarse ${coarse}`);
  // Texture coordinates are for the whole image.
  close(fine.mesh.uv[0], 0.4, 1e-7); close(fine.mesh.uv[1], 0.375, 1e-7);
  const tris = meshTriangles(mesh, [0, 0], fine);
  assert.equal(tris.count, (10 * 8 - 4 + 256) * 6);
});

test('the refined export mesh follows a sharp warp and leaves no gaps', () => {
  const T = [1e-6, 0, 0.3, 0, 1e-6, 0.4];
  // A point re-pinned 40 px out of line with close neighbours: a sharp spike.
  const pts = [[0, 0], [1000, 0], [0, 800], [1000, 800], [530, 420],
    [470, 420], [590, 420], [530, 360], [530, 480]].map(([u, v], i) => {
    const [x, y] = applyAffine(T, u, v);
    return { u, v, x: x + (i === 4 ? 4e-5 : 0), y };
  });
  const w = makeWarp(T, pts);
  const tol = 0.25e-6;  // a quarter of a pixel
  const soup = refinedSoup(w.map, 1000, 800, 40, tol, pts.map(p => [p.u, p.v]));
  assert.ok(soup.refined > 0 && soup.refined < 1280 / 4, `${soup.refined} of 1280 cells split`);
  // Where a soup puts image pixel (u, v).
  const at = ({ pos, uv }, u, v) => {
    for (let k = 0; k < uv.length; k += 6) {
      const [ax, ay, bx, by, cx, cy] = [uv[k] * 1000, uv[k + 1] * 800, uv[k + 2] * 1000, uv[k + 3] * 800, uv[k + 4] * 1000, uv[k + 5] * 800];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det;
      const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      return [l1 * pos[k] + l2 * pos[k + 2] + l3 * pos[k + 4], l1 * pos[k + 1] + l2 * pos[k + 3] + l3 * pos[k + 5]];
    }
    return null;
  };
  const worstOff = (m) => {
    let worst = 0;
    for (let v = 5; v < 800; v += 13) {
      for (let u = 3; u < 1000; u += 11) {
        const [x, y] = at(m, u, v), [ex, ey] = w.map(u, v);
        worst = Math.max(worst, Math.hypot(x - ex, y - ey));
      }
    }
    return worst;
  };
  // No gaps or overlaps: the triangles tile the image exactly.
  let area = 0;
  for (let k = 0, uv = soup.uv; k < uv.length; k += 6) {
    area += ((uv[k + 2] - uv[k]) * (uv[k + 5] - uv[k + 1]) - (uv[k + 4] - uv[k]) * (uv[k + 3] - uv[k + 1])) / 2;
  }
  close(Math.abs(area), 1, 1e-6);
  // Close to the warp everywhere, where plain cells are well off.
  const worst = worstOff(soup);
  assert.ok(worst < 2 * tol, `worst ${worst / 1e-6} px`);
  const plain = refinedSoup(w.map, 1000, 800, 40, Infinity);
  assert.equal(plain.refined, 0);
  assert.ok(worstOff(plain) > 10 * tol, `plain worst ${worstOff(plain) / 1e-6} px`);
});

test('world file conversion round-trips', () => {
  const T = [3e-7, 0, 0.51, 0, 3e-7, 0.33];
  const T2 = worldFileToAffine(affineToWorldFile(T));
  T.forEach((v, i) => close(v, T2[i], 1e-15));
});

test('similarity about pivot fixes the pivot', () => {
  const T = [1, 0, 0, 0, 1, 0];
  const T2 = similarityAboutPivot(T, [5, 5], 0, 1);
  const [x, y] = applyAffine(T2, 5, 5);
  close(x, 5); close(y, 5);
  const [x2, y2] = applyAffine(T2, 6, 5);
  close(x2, 5); close(y2, 6);
});

// 1x1 transparent PNG
const MINIMAL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

test('PNG text chunk round-trips', () => {
  const png = MINIMAL_PNG;
  const out = addTextChunk(png, 'rubbersheet', '{"a":"é"}');
  assert.deepEqual(JSON.parse(readTextChunks(out).rubbersheet), { a: 'é' });
});

test('a private PNG chunk round-trips alongside the text chunk', () => {
  const png = addTextChunk(MINIMAL_PNG, 'rubbersheet', '{"a":1}');
  const data = new Uint8Array(5000).map((_, k) => (k * 7) & 255);
  const out = addChunk(png, 'rsOr', data);
  assert.deepEqual([...readChunk(out, 'rsOr')], [...data]);
  assert.equal(readTextChunks(out).rubbersheet, '{"a":1}');
  assert.equal(readChunk(png, 'rsOr'), null);
  // Still ends with IEND.
  assert.equal(String.fromCharCode(...out.subarray(out.length - 8, out.length - 4)), 'IEND');
});

test('lng/lat <-> Mercator round-trips and matches known values', () => {
  close(lngToMercX(0), 0.5);
  close(latToMercY(0), 0.5);
  close(latToMercY(85.0511287798066), 0, 1e-12);
  for (const lat of [-80, -33.3, 0, 12.5, 51.48, 84]) close(mercYToLat(latToMercY(lat)), lat, 1e-9);
  for (const lng of [-180, -73.9, 0, 151.2, 190]) close(mercXToLng(lngToMercX(lng)), lng, 1e-9);
});

test('zip round-trips stored entries', async () => {
  const png = new Uint8Array(300).map((_, i) => i * 7);
  const kml = new TextEncoder().encode('<kml>é</kml>');
  const zip = makeZip([{ name: 'doc.kml', data: kml }, { name: 'map.png', data: png }]);
  const out = await readZip(zip);
  assert.deepEqual(out.map(e => e.name), ['doc.kml', 'map.png']);
  assert.deepEqual([...out[0].data], [...kml]);
  assert.deepEqual([...out[1].data], [...png]);
});

test('zip reads deflated entries', async () => {
  const zip = Uint8Array.from(Buffer.from('UEsDBBQAAAAIACsrTl3glUN0FQAAADcBAAAHAAAAZG9jLmttbLPJzs2xy0jNyclXGCWJIW30QSEGAFBLAwQUAAAACAArK05dAAAAAAIAAAAAAAAABgAAAGZpbGVzLwMAUEsDBBQAAAAIACsrTl0mTAu3GAEAAAAEAAALAAAAZmlsZXMvYS5wbmdjYGRiZmFlY+fg5OLm4eXjFxAUEhYRFROXkJSSlpGVk1dQVFJWUVVT19DU0tbR1dM3MDQyNjE1M7ewtLK2sbWzd3B0cnZxdXP38PTy9vH18w8IDAoOCQ0Lj4iMio6JjYtPSExKTklNS8/IzMrOyc3LLygsKi4pLSuvqKyqrqmtq29obGpuaW1r7+js6u7p7eufMHHS5ClTp02fMXPW7Dlz581fsHDR4iVLly1fsXLV6jVr163fsHHT5i1bt23fsXPX7j179+0/cPDQ4SNHjx0/cfLU6TNnz52/cPHS5StXr12/cfPW7Tt3791/8PDR4ydPnz1/8fLV6zdv373/8PHT5y9fv33/8fPX7z9///1nGPX/qP9HsP8BUEsBAhQDFAAAAAgAKytOXeCVQ3QVAAAANwEAAAcAAAAAAAAAAAAAAIABAAAAAGRvYy5rbWxQSwECFAMUAAAACAArK05dAAAAAAIAAAAAAAAABgAAAAAAAAAAABAA/UE6AAAAZmlsZXMvUEsBAhQDFAAAAAgAKytOXSZMC7cYAQAAAAQAAAsAAAAAAAAAAAAAAIABYAAAAGZpbGVzL2EucG5nUEsFBgAAAAADAAMAogAAAKEBAAAAAA==', 'base64'));
  const out = await readZip(zip);
  assert.deepEqual(out.map(e => e.name), ['doc.kml', 'files/a.png']);
  assert.equal(new TextDecoder().decode(out[0].data), '<kml>' + 'hello '.repeat(50) + '</kml>');
  assert.equal(out[1].data.length, 1024);
  assert.equal(out[1].data[300], 300 % 256);
});

test('GeoTIFF round-trips pixels and georeferencing', async () => {
  const W = 301, H = 157;
  const rgba = new Uint8Array(W * H * 4).map((_, k) => (k * 37 + (k >> 9)) & 255);
  const tiff = await writeGeoTIFF({
    width: W, height: H, rgba, epsg: 3857, scale: [12.5, 12.5], origin: [-13627000, 4562000],
    description: '{"generator":"rubbersheet"}',
  });
  assert.ok(isTIFF(tiff));
  const t = await readGeoTIFF(tiff);
  assert.equal(t.width, W);
  assert.equal(t.height, H);
  assert.deepEqual([...t.rgba], [...rgba]);
  assert.equal(t.epsg, 3857);
  assert.deepEqual(t.scale, [12.5, 12.5]);
  assert.deepEqual(t.origin, [-13627000, 4562000]);
  assert.equal(t.description, '{"generator":"rubbersheet"}');

  // A private tag holding bytes, readable without decoding the pixels.
  const blob = new Uint8Array(1234).map((_, k) => (k * 11) & 255);
  const withTag = await writeGeoTIFF({
    width: W, height: H, rgba, epsg: 3857, scale: [12.5, 12.5], origin: [-13627000, 4562000],
    description: 'x', extraTags: [{ tag: 65123, bytes: blob }],
  });
  assert.deepEqual([...readTIFFTags(withTag)[65123]], [...blob]);
  assert.deepEqual([...(await readGeoTIFF(withTag)).rgba], [...rgba]);
});

test('GeoTIFF reads a GDAL file: tiled, LZW, predictor 2, EPSG:4326', async () => {
  // 40×24 RGB written by GDAL 3.12: R = 6i, G = 10j, B = ij mod 256.
  const t = await readGeoTIFF(Uint8Array.from(Buffer.from('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', 'base64')));
  assert.equal(t.width, 40);
  assert.equal(t.height, 24);
  assert.equal(t.epsg, 4326);
  close(t.origin[0], -122.5);
  close(t.origin[1], 37.9);
  close(t.scale[0], 0.001);
  close(t.scale[1], 0.0008);
  for (let j = 0; j < 24; j++) for (let i = 0; i < 40; i++) {
    const k = (j * 40 + i) * 4;
    assert.deepEqual([...t.rgba.subarray(k, k + 4)], [i * 6, j * 10, (i * j) & 255, 255]);
  }
});

// Reference values below are from PROJ (via GDAL 3.12).
const lngLatClose = ([lng, lat], [elng, elat], metres) => {
  close(lng, elng, metres / 111320 / Math.cos(elat * Math.PI / 180));
  close(lat, elat, metres / 110574);
};

test('projections match PROJ and round-trip', () => {
  const cases = [
    [utm(ELLIPSOIDS.WGS84, 17), [-84.3, 33.7]],
    [utm(ELLIPSOIDS.WGS84, 56, true), [151.2, -33.9]],
    [polyconic(ELLIPSOIDS.Clarke1866, { lon0: -87.625 }), [-87.77, 38.48]],
    [lambertConformalConic(ELLIPSOIDS.GRS80, {
      lon0: -120.5, lat0: 36.5, lat1: 38.43333333333333, lat2: 37.06666666666667, x0: 2000000, y0: 500000,
    }), [-122.27, 37.8]],
    [lambertConformalConic(ELLIPSOIDS.Clarke1866, { lon0: -77, lat0: 18, lat1: 18, x0: 250000, y0: 150000 }),
      [-78.3, 18.4]],
  ];
  for (const [proj, ll] of cases) lngLatClose(proj.inverse(...proj.forward(...ll)), ll, 0.005);
  const [x, y] = polyconic(ELLIPSOIDS.Clarke1866, { lon0: -87.625 }).forward(-80, 45);
  // PROJ: +proj=poly +lon_0=-87.625 +ellps=clrk66
  close(x, 600337.9140093253, 0.001);
  close(y, 5012994.681007552, 0.001);
});

test('GeoKeys: USGS polyconic NAD27 quad lands where PROJ puts it', () => {
  // Keys from a USGS Historical Topographic Map Collection GeoTIFF.
  const crs = crsFromGeoKeys({
    1024: 1, 1025: 1, 2048: 4267, 2054: 9102, 2057: 6378206.4, 2059: 294.9786982139006,
    3072: 32767, 3074: 32767, 3075: 22, 3076: 9001, 3080: -87.625, 3081: 0, 3082: 0, 3083: 0, 3092: 1,
  });
  assert.equal(crs.kind, 'projected');
  // PROJ with +towgs84=-8,160,176, the same NAD27 shift.
  lngLatClose(crs.toLngLat(-12920.116139306203, 4292378.991206516), [-87.7736768026703, 38.766491300526496], 0.01);
  lngLatClose(crs.toLngLat(13342.425527360465, 4260718.949539849), [-87.47210220276833, 38.48128012436943], 0.01);
});

test('GeoKeys: EPSG UTM, Lambert in US feet, Mercator, unsupported', () => {
  const utm17 = crsFromGeoKeys({ 1024: 1, 3072: 32617 });
  lngLatClose(utm17.toLngLat(500000, 3700000), [-81, 33.439394672509394], 0.01);
  lngLatClose(utm17.toLngLat(700000, 5000000), [-78.45687651021706, 45.125153847634174], 0.01);
  // California zone 3 (NAD83, US survey feet), spelled out.
  const lcc = crsFromGeoKeys({
    1024: 1, 2048: 4269, 3072: 32767, 3074: 32767, 3075: 8, 3076: 9003,
    3078: 38.43333333333333, 3079: 37.06666666666667, 3084: -120.5, 3085: 36.5,
    3086: 6561666.667, 3087: 1640416.667,
  });
  lngLatClose(lcc.toLngLat(6050000, 2120000), [-122.27113499585046, 37.80383969140445], 0.01);
  assert.equal(crsFromGeoKeys({ 1024: 1, 3072: 3857 }).kind, 'mercator');
  assert.equal(crsFromGeoKeys({ 1024: 2, 2048: 4326 }).toLngLat(-120, 40).join(), '-120,40');
  assert.throws(() => crsFromGeoKeys({ 1024: 1, 3072: 2227 }), /EPSG:2227 isn’t supported/);
});

// ---------------------------------------------------------------------------
// Hide paper

import { estimatePaper, paperToAlpha } from '../js/paper.js';

// Tan paper lit unevenly from left to right, with black lines and a red wash.
function paperImage(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const light = 1 - 0.3 * x / w;
      let c = [230 * light, 205 * light, 160 * light];
      if (x % 20 < 2 || y % 25 < 2) c = [30, 28, 25];
      else if (x > w / 2 && x < w / 2 + 60 && y > 20 && y < 120) c = [200, 90, 80];
      const k = (y * w + x) * 4;
      rgba.set([...c.map(Math.round), 255], k);
    }
  }
  return rgba;
}

test('paper colour follows the lighting and ignores ink and washes', () => {
  const w = 320, h = 200;
  const p = estimatePaper(paperImage(w, h), w, h);
  assert.equal(p.gw, 40);
  assert.equal(p.gh, 25);
  for (let j = 0; j < p.gh; j++) {
    for (let i = 0; i < p.gw; i++) {
      const light = 1 - 0.3 * (i + 0.5) / p.gw;
      const k = (j * p.gw + i) * 4;
      assert.ok(Math.abs(p.grid[k] - 230 * light) < 8, `cell ${i},${j}: ${p.grid[k]} vs ${230 * light}`);
      assert.ok(Math.abs(p.grid[k + 1] - 205 * light) < 8);
      assert.ok(Math.abs(p.grid[k + 2] - 160 * light) < 8);
    }
  }
});

test('an image with no opaque pixels has no paper', () => {
  assert.equal(estimatePaper(new Uint8Array(16), 2, 2), null);
});

test('paper to alpha: the middle of the slider clears the paper alone', () => {
  const p = [0.9, 0.8, 0.6];
  const pale = [0.75, 0.66, 0.48, 1];
  const ink = [0.1, 0.1, 0.1, 1];
  // Off.
  assert.deepEqual(paperToAlpha([...p, 1], p, 0), [...p, 1]);
  // The middle: the paper, with a little noise and glare, clears; ink and a
  // pale line stay as they were.
  assert.equal(paperToAlpha([...p, 1], p, 0.5)[3], 0);
  close(paperToAlpha([0.92, 0.79, 0.61, 1], p, 0.5)[3], 0, 1e-9);
  for (const c of [ink, pale]) {
    const o = paperToAlpha(c, p, 0.5);
    for (let n = 0; n < 4; n++) close(o[n], c[n], 1e-9);
  }
  // Below the middle, the paper only partly fades.
  const half = paperToAlpha([...p, 1], p, 0.25);
  close(half[3], 0.5);
  for (let n = 0; n < 3; n++) close(half[n], p[n]);
  assert.equal(paperToAlpha(pale, p, 0.25)[3], 1);
  // Above it, the pale line fades too, and over the paper looks as it did,
  // while ink stays.
  const o = paperToAlpha(pale, p, 0.6);
  assert.ok(o[3] > 0 && o[3] < 1);
  for (let n = 0; n < 3; n++) close(o[n] * o[3] + p[n] * (1 - o[3]), pale[n], 1e-9);
  assert.ok(paperToAlpha(pale, p, 0.65)[3] < o[3]);
  assert.equal(paperToAlpha(pale, p, 1)[3], 0);
  assert.equal(paperToAlpha(ink, p, 1)[3], 1);
});

// ---------------------------------------------------------------------------
// Isolate color

import { density, pickDensity, isolateWeights, isolateTransmittance, inkAmount, drawColor, toHex, fromHex } from '../js/isolate.js';

// How much of the map a pixel's isolated ink hides, at its most.
const isolateAlpha = (...args) => [0, 0, 0, 1 - Math.min(...isolateTransmittance(...args))];

// RGBA bytes for a list of RGB colors (0..1).
const pixels = (cs) => Uint8Array.from(cs.flatMap(c => [...c.map(x => Math.round(x * 255)), 255]));
// A color as ink of density d over paper p.
const inked = (p, d) => p.map((x, n) => x * Math.exp(-d[n]));

test('isolate color: the picked ink shows; paper, black and a hidden ink do not', () => {
  const paper = [0.83, 0.73, 0.49];
  const black = inked(paper, [1.2, 1.2, 1.2]);
  const red = inked(paper, [0.24, 0.41, 0.3]);
  const pencil = inked(paper, [0.38, 0.4, 0.27]);
  // Around the click: mostly paper, and a line of pencil.
  const showD = pickDensity(pixels([...Array(14).fill(paper), ...Array(11).fill(pencil)]), paper);
  for (let n = 0; n < 3; n++) close(showD[n], density(pencil, paper)[n], 0.02);
  const col = drawColor(showD);
  const alpha = (w, c) => isolateAlpha([...c, 1], paper, w, showD, col, 0.5)[3];
  const w2 = isolateWeights(showD);
  assert.equal(alpha(w2, paper), 0);
  assert.equal(alpha(w2, black), 0);
  assert.ok(alpha(w2, pencil) > 0.5);
  // Heavy black whose blue bottoms out, so that it has the pencil's hue
  // (as measured on a scan), is still black.
  assert.equal(alpha(w2, inked(paper, [1.76, 1.67, 1.21])), 0);
  // Pencil only partly over black shows at least partly.
  assert.ok(alpha(w2, inked(paper, [0.58, 0.6, 0.47])) > 0.5);
  // With red hidden as well, red drops out and pencil stays.
  const w3 = isolateWeights(showD, density(red, paper));
  assert.equal(alpha(w3, red), 0);
  assert.equal(alpha(w3, black), 0);
  assert.ok(alpha(w3, pencil) > 0.5);
  close(inkAmount(w3, showD, showD), showD.reduce((a, b) => a + b), 1e-9);
});

test('isolate color: nothing to pick from paper or black ink', () => {
  const paper = [0.83, 0.73, 0.49];
  assert.equal(pickDensity(pixels(Array(9).fill(paper)), paper), null);
  const blackD = pickDensity(pixels(Array(9).fill(inked(paper, [1, 1, 1]))), paper);
  assert.equal(isolateWeights(blackD), null);
});

test('isolate color: a pixel is judged by its neighbourhood\'s hue at its own strength', () => {
  const showD = [0.2, 0.5, 0.3], w = isolateWeights(showD);
  // A faint pixel in a strong red neighbourhood is faintly red.
  close(inkAmount(w, showD, [0.1, 0.25, 0.15], [0.2, 0.5, 0.3]), 0.5, 1e-9);
  assert.equal(toHex(fromHex('#a1b2c3')), '#a1b2c3');
});

test('paper color ignores a black surround larger than the paper', () => {
  const w = 40, h = 40, px = new Uint8Array(w * h * 4);
  for (let k = 0; k < px.length; k += 4) {
    const inside = (k / 4) % w < 15;
    px.set(inside ? [200, 180, 120, 255] : [3, 2, 4, 255], k);
  }
  const p = estimatePaper(px, w, h);
  assert.deepEqual(p.colour, [200, 180, 120]);
});

test('isolate color: opacity follows the amount of ink, wherever it was picked', () => {
  const paper = [1, 0.98, 0.75];
  const heavy = [0.27, 0.6, 0.92], thin = heavy.map(x => x / 4);
  const col = [0, 0, 0];
  const alphaOf = (showD, d) => isolateAlpha([...inked(paper, d), 1], paper, isolateWeights(showD), showD, col, 0.5)[3];
  // A thin line, or a line covering part of a pixel, shows partly.
  const a = alphaOf(heavy, thin);
  assert.ok(a > 0.1 && a < alphaOf(heavy, heavy), `${a}`);
  // Picking a thin line of an ink gives the same as picking a heavy one.
  close(alphaOf(thin, thin), a, 1e-6);
  close(alphaOf(thin, heavy), alphaOf(heavy, heavy), 1e-6);
  // Paper grain doesn't show.
  assert.equal(alphaOf(heavy, heavy.map(x => x / 40)), 0);
});
