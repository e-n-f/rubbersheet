// Minimal GeoTIFF writing and reading.
//
// Writing produces an 8-bit RGBA, deflate-compressed, stripped GeoTIFF with
// the georeferencing in ModelPixelScale / ModelTiepoint / GeoKeyDirectory.
// Reading handles the common simple cases: 8-bit grey, RGB or RGBA, chunky,
// strips or tiles, uncompressed, LZW or deflate, with or without the horizontal
// predictor. That covers rubbersheet's own files and many GDAL defaults.

const SHORT = 3, LONG = 4, ASCII = 2, DOUBLE = 12;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 6: 1, 7: 1, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };

const TAG = {
  ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, ImageDescription: 270, StripOffsets: 273, SamplesPerPixel: 277,
  RowsPerStrip: 278, StripByteCounts: 279, PlanarConfig: 284, Predictor: 317,
  TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325,
  ExtraSamples: 338, ModelPixelScale: 33550, ModelTiepoint: 33922, GeoKeyDirectory: 34735,
};

// GeoKeys.
const GTModelType = 1024, GTRasterType = 1025, GeographicType = 2048, ProjectedCSType = 3072;

async function pipe(data, stream) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

// TIFF-flavoured LZW: MSB-first codes of 9 to 12 bits, with the code width
// growing one code early.
function lzwDecode(input, expected) {
  const out = new Uint8Array(expected);
  let o = 0;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), length = new Int32Array(4096);
  for (let i = 0; i < 256; i++) { suffix[i] = i; length[i] = 1; prefix[i] = -1; }
  let next = 258, width = 9, prev = -1;
  let bitPos = 0;
  const totalBits = input.length * 8;
  const write = (code) => {
    const len = length[code];
    let c = code;
    for (let k = len - 1; k >= 0; k--) {
      if (o + k < out.length) out[o + k] = suffix[c];
      c = prefix[c];
    }
    o += len;
  };
  const first = (code) => {
    while (prefix[code] >= 0) code = prefix[code];
    return suffix[code];
  };
  while (bitPos + width <= totalBits && o < out.length) {
    let code = 0;
    for (let k = 0; k < width; k++, bitPos++) code = (code << 1) | ((input[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (prev < 0) {
      write(code);
    } else {
      const known = code < next;
      const firstByte = first(known ? code : prev);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = firstByte;
        length[next] = length[prev] + 1;
        next++;
      }
      write(code);
    }
    prev = code;
    if (next + 1 >= (1 << width) && width < 12) width++;
  }
  return out;
}

export function isTIFF(bytes) {
  return bytes.length > 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
     (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42));
}

// rgba: Uint8Array of width*height*4, unassociated alpha, top row first.
// scale: [x, y] size of a pixel in CRS units; origin: [x, y] of the top-left
// corner of the top-left pixel. epsg: 3857 or 4326.
export async function writeGeoTIFF({ width, height, rgba, scale, origin, epsg, description }) {
  const rowBytes = width * 4;
  const rowsPerStrip = Math.max(1, Math.floor((256 * 1024) / rowBytes));
  const strips = [];
  for (let y = 0; y < height; y += rowsPerStrip) {
    const raw = rgba.slice(y * rowBytes, Math.min(height, y + rowsPerStrip) * rowBytes);
    // Horizontal differencing (Predictor 2) helps deflate a lot on images.
    for (let r = 0; r < raw.length; r += rowBytes) {
      for (let i = r + rowBytes - 1; i >= r + 4; i--) raw[i] -= raw[i - 4];
    }
    strips.push(pipe(raw, new CompressionStream('deflate')));
  }
  const data = await Promise.all(strips);

  const geographic = epsg === 4326;
  const geoKeys = [
    1, 1, 0, 3,
    GTModelType, 0, 1, geographic ? 2 : 1,
    GTRasterType, 0, 1, 1, // PixelIsArea
    geographic ? GeographicType : ProjectedCSType, 0, 1, epsg,
  ];
  const entries = [
    [TAG.ImageWidth, LONG, [width]],
    [TAG.ImageLength, LONG, [height]],
    [TAG.BitsPerSample, SHORT, [8, 8, 8, 8]],
    [TAG.Compression, SHORT, [8]],
    [TAG.Photometric, SHORT, [2]],
    ...(description ? [[TAG.ImageDescription, ASCII, description]] : []),
    [TAG.StripOffsets, LONG, data.map(() => 0)], // filled in below
    [TAG.SamplesPerPixel, SHORT, [4]],
    [TAG.RowsPerStrip, LONG, [rowsPerStrip]],
    [TAG.StripByteCounts, LONG, data.map(d => d.length)],
    [TAG.PlanarConfig, SHORT, [1]],
    [TAG.Predictor, SHORT, [2]],
    [TAG.ExtraSamples, SHORT, [2]], // unassociated alpha
    [TAG.ModelPixelScale, DOUBLE, [scale[0], scale[1], 0]],
    [TAG.ModelTiepoint, DOUBLE, [0, 0, 0, origin[0], origin[1], 0]],
    [TAG.GeoKeyDirectory, SHORT, geoKeys],
  ];

  // Layout: header, strips, IFD, then values too big to sit in the IFD.
  const even = (n) => n + (n & 1);
  let offset = 8;
  const stripOffsets = data.map(d => {
    const o = offset;
    offset = even(offset + d.length);
    return o;
  });
  entries.find(e => e[0] === TAG.StripOffsets)[2] = stripOffsets;
  const ifdOffset = offset;
  let extra = ifdOffset + 2 + entries.length * 12 + 4;
  const enc = new TextEncoder();
  const encoded = entries.map(([tag, type, values]) => {
    const bytes = type === ASCII ? enc.encode(values + '\0') : null;
    const count = bytes ? bytes.length : values.length;
    const size = count * TYPE_SIZE[type];
    let at = null;
    if (size > 4) {
      at = extra;
      extra = even(extra + size);
    }
    return { tag, type, values, bytes, count, size, at };
  });

  const out = new Uint8Array(extra);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, ifdOffset, true);
  data.forEach((d, i) => out.set(d, stripOffsets[i]));
  dv.setUint16(ifdOffset, entries.length, true);
  encoded.forEach((e, i) => {
    const p = ifdOffset + 2 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    const at = e.at ?? p + 8;
    if (e.at !== null) dv.setUint32(p + 8, e.at, true);
    if (e.bytes) out.set(e.bytes, at);
    else {
      e.values.forEach((v, k) => {
        if (e.type === SHORT) dv.setUint16(at + k * 2, v, true);
        else if (e.type === LONG) dv.setUint32(at + k * 4, v, true);
        else dv.setFloat64(at + k * 8, v, true);
      });
    }
  });
  dv.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  return out;
}

// Returns {width, height, rgba, scale, origin, epsg, description}. scale,
// origin and epsg are undefined when the file doesn't say.
export async function readGeoTIFF(bytes) {
  if (!isTIFF(bytes)) throw new Error('Not a TIFF');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  if (dv.getUint16(2, le) !== 42) throw new Error('BigTIFF isn’t supported');
  const ifd = dv.getUint32(4, le);
  const tags = {};
  const n = dv.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = dv.getUint16(p, le), type = dv.getUint16(p + 2, le), count = dv.getUint32(p + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    const at = size > 4 ? dv.getUint32(p + 8, le) : p + 8;
    if (type === ASCII) {
      tags[tag] = new TextDecoder('latin1').decode(bytes.subarray(at, at + count)).replace(/\0+$/, '');
      continue;
    }
    const values = [];
    for (let k = 0; k < count; k++) {
      if (type === SHORT) values.push(dv.getUint16(at + k * 2, le));
      else if (type === LONG) values.push(dv.getUint32(at + k * 4, le));
      else if (type === DOUBLE) values.push(dv.getFloat64(at + k * 8, le));
      else if (type === 1 || type === 7) values.push(bytes[at + k]);
    }
    tags[tag] = values;
  }
  const one = (t, d) => (tags[t] ? tags[t][0] : d);
  const width = one(TAG.ImageWidth), height = one(TAG.ImageLength);
  const spp = one(TAG.SamplesPerPixel, 1);
  const compression = one(TAG.Compression, 1);
  const predictor = one(TAG.Predictor, 1);
  const photometric = one(TAG.Photometric, spp >= 3 ? 2 : 1);
  if ((tags[TAG.BitsPerSample] || [1]).some(b => b !== 8)) throw new Error('only 8-bit TIFFs are supported');
  if (one(TAG.PlanarConfig, 1) !== 1) throw new Error('planar TIFFs aren’t supported');
  if (![1, 5, 8, 32946].includes(compression)) throw new Error(`TIFF compression ${compression} isn’t supported`);
  if (![1, 2].includes(predictor)) throw new Error(`TIFF predictor ${predictor} isn’t supported`);
  if (!(photometric === 2 && spp >= 3) && !(photometric <= 1 && spp <= 2)) {
    throw new Error('only greyscale and RGB TIFFs are supported');
  }

  const tiled = !!tags[TAG.TileOffsets];
  const cw = tiled ? one(TAG.TileWidth) : width;
  const ch = tiled ? one(TAG.TileLength) : Math.min(height, one(TAG.RowsPerStrip, height));
  const offsets = tags[tiled ? TAG.TileOffsets : TAG.StripOffsets];
  const counts = tags[tiled ? TAG.TileByteCounts : TAG.StripByteCounts];
  const across = Math.ceil(width / cw);
  const chunks = await Promise.all(offsets.map((o, i) => {
    const raw = bytes.subarray(o, o + counts[i]);
    if (compression === 1) return raw;
    if (compression === 5) return lzwDecode(raw, cw * ch * spp);
    return pipe(raw, new DecompressionStream('deflate'));
  }));

  const rgba = new Uint8ClampedArray(width * height * 4);
  const alpha = spp === 2 || spp >= 4;
  const premultiplied = alpha && (tags[TAG.ExtraSamples] || [])[0] === 1;
  chunks.forEach((chunk, i) => {
    const x0 = (i % across) * cw, y0 = Math.floor(i / across) * ch;
    const rowBytes = cw * spp;
    if (predictor === 2) {
      chunk = chunk.slice();
      for (let r = 0; r + rowBytes <= chunk.length; r += rowBytes) {
        for (let k = r + spp; k < r + rowBytes; k++) chunk[k] += chunk[k - spp];
      }
    }
    for (let y = 0; y < ch && y0 + y < height; y++) {
      for (let x = 0; x < cw && x0 + x < width; x++) {
        const s = y * rowBytes + x * spp, d = ((y0 + y) * width + x0 + x) * 4;
        if (spp >= 3) {
          rgba[d] = chunk[s]; rgba[d + 1] = chunk[s + 1]; rgba[d + 2] = chunk[s + 2];
        } else {
          const g = photometric === 0 ? 255 - chunk[s] : chunk[s];
          rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
        }
        const a = alpha ? chunk[s + spp - 1] : 255;
        rgba[d + 3] = a;
        if (premultiplied && a > 0 && a < 255) {
          for (let c = 0; c < 3; c++) rgba[d + c] = rgba[d + c] * 255 / a;
        }
      }
    }
  });

  const result = { width, height, rgba, description: tags[TAG.ImageDescription] };
  const scale = tags[TAG.ModelPixelScale], tie = tags[TAG.ModelTiepoint];
  if (scale && tie) {
    result.scale = [scale[0], scale[1]];
    // Tiepoint (i, j) -> (X, Y); move it to the top-left corner.
    result.origin = [tie[3] - tie[0] * scale[0], tie[4] + tie[1] * scale[1]];
    const keys = tags[TAG.GeoKeyDirectory] || [];
    const key = (id) => {
      for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === id && keys[k + 1] === 0) return keys[k + 3];
      return undefined;
    };
    result.epsg = key(GTModelType) === 2 ? key(GeographicType) : key(ProjectedCSType);
    if (key(GTRasterType) === 2) {
      // PixelIsPoint: the tiepoint is a pixel centre.
      result.origin = [result.origin[0] - scale[0] / 2, result.origin[1] + scale[1] / 2];
    }
  }
  return result;
}
