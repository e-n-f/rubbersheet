// Read and write PNG tEXt chunks, used to embed georeferencing metadata.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPNG(bytes) {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

// tEXt is Latin-1, so escape anything outside ASCII.
function toAscii(text) {
  return text.replace(/[^\x20-\x7e\n]/g, ch => {
    const code = ch.charCodeAt(0);
    return '\\u' + code.toString(16).padStart(4, '0');
  });
}

// Insert a tEXt chunk right after IHDR. Text is ASCII-escaped, which is
// harmless for JSON payloads.
export function addTextChunk(bytes, keyword, text) {
  if (!isPNG(bytes)) throw new Error('Not a PNG');
  const ihdrLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8);
  const insertAt = 8 + 12 + ihdrLen;
  const enc = new TextEncoder();
  const data = enc.encode(keyword + '\0' + toAscii(text));
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(enc.encode('tEXt'), 4);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + chunk.length);
  return out;
}

// Returns {keyword: text} for every tEXt chunk.
export function readTextChunks(bytes) {
  const out = {};
  if (!isPNG(bytes)) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder('latin1');
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (p + 12 + len > bytes.length) break;
    if (type === 'tEXt') {
      const data = bytes.subarray(p + 8, p + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        out[latin1.decode(data.subarray(0, nul))] = latin1.decode(data.subarray(nul + 1));
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}
