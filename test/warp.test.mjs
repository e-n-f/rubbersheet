import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAffine, fitSimilarity, makeWarp, buildMesh, invertMesh,
  worldFileToAffine, affineToWorldFile, similarityAboutPivot,
  lngToMercX, mercXToLng, latToMercY, mercYToLat, geographicRows,
} from '../js/warp.js';
import { addTextChunk, readTextChunks } from '../js/png-text.js';
import { makeZip, readZip } from '../js/zip.js';
import { isTIFF, readGeoTIFF, writeGeoTIFF } from '../js/tiff.js';

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

test('PNG text chunk round-trips', () => {
  // 1x1 transparent PNG
  const png = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const out = addTextChunk(png, 'rubbersheet', '{"a":"é"}');
  assert.deepEqual(JSON.parse(readTextChunks(out).rubbersheet), { a: 'é' });
});

test('lng/lat <-> Mercator round-trips and matches known values', () => {
  close(lngToMercX(0), 0.5);
  close(latToMercY(0), 0.5);
  close(latToMercY(85.0511287798066), 0, 1e-12);
  for (const lat of [-80, -33.3, 0, 12.5, 51.48, 84]) close(mercYToLat(latToMercY(lat)), lat, 1e-9);
  for (const lng of [-180, -73.9, 0, 151.2, 190]) close(mercXToLng(lngToMercX(lng)), lng, 1e-9);
});

test('geographic rows map a 4326 image onto Mercator', () => {
  // 1000×800 image covering 10°E–15°E, 50°N–46°N.
  const W = 1000, H = 800;
  const A = 5 / W, E = -4 / H;
  const rows = geographicRows([A, 0, 0, E, 10 + A / 2, 50 + E / 2], H);
  close(rows.targetV(0), 0, 1e-9);
  close(rows.targetV(H), H, 1e-9);
  for (const v of [0, 123.4, 400, 799]) close(rows.sourceV(rows.targetV(v)), v, 1e-6);
  // A pixel lands at its own lng/lat.
  const [x, y] = applyAffine(rows.T, 250, rows.targetV(200));
  close(x, lngToMercX(11.25), 1e-12);
  close(y, latToMercY(49), 1e-12);
  // Mercator stretches rows towards the pole, so the middle source row
  // moves south of the middle.
  assert.ok(rows.targetV(H / 2) > H / 2);
  assert.equal(geographicRows([A, 0.001, 0, E, 10, 50], H), null);
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
