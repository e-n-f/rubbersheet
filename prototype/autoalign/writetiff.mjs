// Write a raw RGBA buffer as a Web Mercator GeoTIFF with rubbersheet's own
// writer, so the app reads it back exactly like one of its exports.
//
//   node writetiff.mjs params.json pixels.rgba out.tif
//   params: {width, height, scale: [x, y], origin: [x, y], description}

import fs from 'fs';
import { writeGeoTIFF } from '../../js/tiff.js';

const [paramsFile, rgbaFile, out] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(paramsFile));
const rgba = new Uint8Array(fs.readFileSync(rgbaFile));
const bytes = await writeGeoTIFF({ ...p, rgba, epsg: 3857 });
fs.writeFileSync(out, bytes);
