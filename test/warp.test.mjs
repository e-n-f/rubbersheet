import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAffine, fitSimilarity, makeWarp, buildMesh, invertMesh,
  worldFileToAffine, affineToWorldFile, similarityAboutPivot,
  lngToMercX, mercXToLng, latToMercY, mercYToLat, geographicRows,
} from '../js/warp.js';
import { addTextChunk, readTextChunks } from '../js/png-text.js';
import { makeZip, readZip } from '../js/zip.js';

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
