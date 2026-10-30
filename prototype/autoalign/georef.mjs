// Print a GeoTIFF's own georeferencing as a grid of pixel -> WGS84 lng/lat,
// using rubbersheet's TIFF reader and projections, so the prototype places
// the image exactly as the app does.
//
//   node georef.mjs image.tif [step]   ->   JSON on stdout

import fs from 'fs';
import { readGeoTIFF } from '../../js/tiff.js';
import { crsFromGeoKeys } from '../../js/proj.js';
import { mercXToLng, mercYToLat } from '../../js/warp.js';

const [file, stepArg] = process.argv.slice(2);
const step = Number(stepArg) || 64;
// Only the tags are wanted, so JPEG tiles decode to nothing.
const noJPEG = async () => ({ width: 0, height: 0, rgba: new Uint8Array(0) });
const tiff = await readGeoTIFF(new Uint8Array(fs.readFileSync(file)), noJPEG);
const { width: W, height: H, toModel: T } = tiff;
if (!T) throw new Error('no georeferencing');
const crs = crsFromGeoKeys(tiff.geoKeys);
const toLngLat = crs.kind === 'mercator'
  ? (X, Y) => [mercXToLng(X / 40075016.68557849 + 0.5), mercYToLat(0.5 - Y / 40075016.68557849)]
  : crs.toLngLat;

const us = [], vs = [];
for (let u = 0; u < W; u += step) us.push(u);
us.push(W);
for (let v = 0; v < H; v += step) vs.push(v);
vs.push(H);
const lngLat = vs.map(v => us.map(u => toLngLat(T[0] * u + T[1] * v + T[2], T[3] * u + T[4] * v + T[5])));
process.stdout.write(JSON.stringify({ width: W, height: H, us, vs, lngLat }));
