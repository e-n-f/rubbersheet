import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAffine, fitSimilarity, makeWarp, buildMesh, invertMesh,
  worldFileToAffine, affineToWorldFile, similarityAboutPivot,
} from '../js/warp.js';
import { addTextChunk, readTextChunks } from '../js/png-text.js';

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
