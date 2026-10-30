// Hand-placed control points from a rubbersheet export, mapped back to the
// original GeoTIFF's pixels.
//
// rubbersheet redraws a non-Mercator GeoTIFF as a Mercator raster when it
// loads it (app.js reproject()), and an export's metadata records each
// control point's sourcePixel in that raster. This repeats the same
// reprojection arithmetic to recover pixels in the original file.
//
//   node refpoints.mjs original.tif export.(tif|png)  ->  [{pixel, lngLat}]

import fs from 'fs';
import { readGeoTIFF } from '../../js/tiff.js';
import { readTextChunks, isPNG } from '../../js/png-text.js';
import { crsFromGeoKeys } from '../../js/proj.js';
import { buildMesh, meshBounds, invertMesh, lngToMercX, latToMercY } from '../../js/warp.js';

const [origFile, exportFile] = process.argv.slice(2);
const noJPEG = async () => ({ width: 0, height: 0, rgba: new Uint8Array(0) });
const tiff = await readGeoTIFF(new Uint8Array(fs.readFileSync(origFile)), noJPEG);
const { width: W, height: H, toModel: [a, b, c, d, e, f] } = tiff;
const crs = crsFromGeoKeys(tiff.geoKeys);

const exp = new Uint8Array(fs.readFileSync(exportFile));
const text = isPNG(exp) ? readTextChunks(exp).rubbersheet : tiffDescription(exp);
const meta = JSON.parse(text);

let toOriginal = ([u, v]) => [u, v];
if (crs.kind !== 'mercator') {
  // As app.js: DISPLAY_CELLS = 64 across the longer side.
  const merc = (u, v) => {
    const [lng, lat] = crs.toLngLat(a * u + b * v + c, d * u + e * v + f);
    return [lngToMercX(lng), latToMercY(lat)];
  };
  const cols = W >= H ? 64 : Math.max(1, Math.round(64 * W / H));
  const mesh = buildMesh(merc, W, H, cols);
  const [minX, minY, maxX, maxY] = meshBounds(mesh);
  const p = merc(W / 2, H / 2), pu = merc(W / 2 + 1, H / 2), pv = merc(W / 2, H / 2 + 1);
  const ps = Math.sqrt(Math.hypot(pu[0] - p[0], pu[1] - p[1]) * Math.hypot(pv[0] - p[0], pv[1] - p[1]));
  const ow = Math.ceil((maxX - minX) / ps), oh = Math.ceil((maxY - minY) / ps);
  if (meta.source && (meta.source.width !== ow || meta.source.height !== oh)) {
    console.error(`warning: export's source is ${meta.source.width}x${meta.source.height}, ` +
      `expected the reprojected ${ow}x${oh}`);
  }
  toOriginal = ([u, v]) => invertMesh(mesh, minX + u * ps, minY + v * ps);
}
const out = (meta.controlPoints || []).map(cp => ({ pixel: toOriginal(cp.sourcePixel), lngLat: cp.lngLat }));
process.stdout.write(JSON.stringify(out));

function tiffDescription(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const ifd = dv.getUint32(4, le);
  for (let i = 0, n = dv.getUint16(ifd, le); i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, le) !== 270) continue;
    const count = dv.getUint32(p + 4, le);
    const at = count > 4 ? dv.getUint32(p + 8, le) : p + 8;
    return new TextDecoder().decode(bytes.subarray(at, at + count)).replace(/\0+$/, '');
  }
  throw new Error('no ImageDescription');
}
