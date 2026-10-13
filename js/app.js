import {
  applyAffine, affineScale, affineToWorldFile, buildMesh, invertMesh, makeWarp,
  meshBounds, meshCorners, meshOutline, meshTriangles, similarityAboutPivot,
  translateAffine, worldFileToAffine,
} from './warp.js';
import { addTextChunk, isPNG, readTextChunks } from './png-text.js';

const maplibregl = window.maplibregl;
const META_KEY = 'rubbersheet';
const DISPLAY_CELLS = 64;
const EXPORT_CELLS = 256;
const HIT_RADIUS = 11;

// ---------------------------------------------------------------------------
// Base maps

const STYLES = {
  streets: 'https://tiles.openfreemap.org/styles/liberty',
  satellite: rasterStyle(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'),
  osm: rasterStyle(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
};

function rasterStyle(url, attribution) {
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ---------------------------------------------------------------------------
// State

const state = {
  image: null,      // {name, img, W, H}
  T: null,          // affine placement, image px -> Mercator units
  points: [],       // [{u, v, x, y}] image px -> Mercator target
  warp: null,       // {map, S}
  mesh: null,       // display mesh
  origin: [0, 0],   // GPU rebasing origin for the display mesh
  drag: null,
  hover: null,
  opacity: 1,
};

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES.streets,
  center: [0, 20],
  zoom: 1.5,
  maxPitch: 0,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

// ---------------------------------------------------------------------------
// WebGL: a textured triangle mesh, shared by the map layer and the exporter.

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv) * u_opacity;
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

class MeshRenderer {
  constructor(gl) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    this.aPos = gl.getAttribLocation(p, 'a_pos');
    this.aUv = gl.getAttribLocation(p, 'a_uv');
    this.uMatrix = gl.getUniformLocation(p, 'u_matrix');
    this.uOpacity = gl.getUniformLocation(p, 'u_opacity');
    this.uTex = gl.getUniformLocation(p, 'u_tex');
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.tex = null;
    this.count = 0;
  }

  setTexture(source) {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const pot = (n) => (n & (n - 1)) === 0;
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const mip = isGL2 || (pot(source.width) && pot(source.height));
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso && mip) {
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
  }

  setTriangles({ positions, uvs, count }) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.DYNAMIC_DRAW);
    this.count = count;
  }

  draw(matrix, opacity) {
    const gl = this.gl;
    if (!this.tex || !this.count) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform1f(this.uOpacity, opacity);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }

  destroy() {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.uvBuf);
    gl.deleteProgram(this.program);
  }
}

// Downscale an image so its longest side fits a texture.
function textureSource(img, maxSize) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (Math.max(W, H) <= maxSize) return img;
  const s = maxSize / Math.max(W, H);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * s));
  c.height = Math.max(1, Math.round(H * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Mercator vertices are stored relative to `origin` so they keep float32
// precision at high zoom; fold the offset back into the matrix in float64.
function rebaseMatrix(m, ox, oy) {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) out[i] = m[i];
  for (let r = 0; r < 4; r++) out[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
  return out;
}

const imageLayer = {
  id: 'rubbersheet-image',
  type: 'custom',
  renderingMode: '2d',
  onAdd(_map, gl) {
    this.renderer = new MeshRenderer(gl);
    this.texDirty = true;
    this.meshDirty = true;
  },
  onRemove() {
    this.renderer.destroy();
    this.renderer = null;
  },
  render(gl, matrix) {
    if (!state.image || !state.mesh || !this.renderer) return;
    if (this.texDirty) {
      this.renderer.setTexture(textureSource(state.image.img,
        Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE))));
      this.texDirty = false;
    }
    if (this.meshDirty) {
      this.renderer.setTriangles(meshTriangles(state.mesh, state.origin));
      this.meshDirty = false;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const opacity = state.drag ? Math.min(0.5, state.opacity) : state.opacity;
    this.renderer.draw(rebaseMatrix(matrix, state.origin[0], state.origin[1]), opacity);
  },
};

map.on('style.load', () => {
  if (!map.getLayer(imageLayer.id)) map.addLayer(imageLayer);
});

// ---------------------------------------------------------------------------
// Coordinates

function toMerc(lngLat) {
  const m = maplibregl.MercatorCoordinate.fromLngLat(lngLat);
  return [m.x, m.y];
}

function toLngLat([x, y]) {
  return new maplibregl.MercatorCoordinate(x, y, 0).toLngLat();
}

function screenToMerc(p) {
  return toMerc(map.unproject(p));
}

function mercToScreen(m) {
  const p = map.project(toLngLat(m));
  return [p.x, p.y];
}

function localPoint(e) {
  const r = map.getContainer().getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// ---------------------------------------------------------------------------
// Warp state

function update() {
  if (!state.image) return;
  const { W, H } = state.image;
  if (state.points.length === 1) {
    // A single point just rides along with the placement.
    const p = state.points[0];
    [p.x, p.y] = applyAffine(state.T, p.u, p.v);
  }
  state.warp = makeWarp(state.T, state.points);
  // Keep the placement in sync, so that removing points back down to one or
  // zero leaves the image where it is.
  if (state.points.length >= 2) state.T = state.warp.S;
  const bent = state.points.length >= 3;
  state.mesh = buildMesh(state.warp.map, W, H, bent ? cellsAcross(W, H, DISPLAY_CELLS) : 1);
  const [minX, minY, maxX, maxY] = meshBounds(state.mesh);
  state.origin = [(minX + maxX) / 2, (minY + maxY) / 2];
  imageLayer.meshDirty = true;
  map.triggerRepaint();
  drawOverlay();
  updateUI();
}

// Columns for a grid whose longer side has `cells` cells.
function cellsAcross(W, H, cells) {
  return W >= H ? cells : Math.max(1, Math.round(cells * W / H));
}

// ---------------------------------------------------------------------------
// Overlay: outline, corner handles, control points

function drawOverlay() {
  if (!state.image || !state.mesh) {
    overlay.innerHTML = '';
    return;
  }
  const parts = [];
  const outline = meshOutline(state.mesh).map(mercToScreen);
  parts.push(`<polygon class="outline" points="${outline.map(p => p.join(',')).join(' ')}"/>`);
  if (!state.drag || state.drag.kind === 'corner') {
    meshCorners(state.mesh).map(mercToScreen).forEach(([x, y], i) => {
      const hover = state.hover && state.hover.kind === 'corner' && state.hover.index === i;
      parts.push(`<rect class="handle${hover ? ' hover' : ''}" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`);
    });
  }
  state.points.forEach((p, i) => {
    const [x, y] = mercToScreen([p.x, p.y]);
    const active = state.drag && state.drag.kind === 'point' && state.drag.index === i;
    const hover = state.hover && state.hover.kind === 'point' && state.hover.index === i;
    parts.push(`<g class="cp${active ? ' active' : ''}${hover ? ' hover' : ''}" transform="translate(${x},${y})">` +
      `<circle class="ring" r="7"/>` +
      `<line x1="-4" y1="0" x2="4" y2="0"/><line x1="0" y1="-4" x2="0" y2="4"/>` +
      `<text x="10" y="-8">${i + 1}</text></g>`);
  });
  overlay.innerHTML = parts.join('');
}

map.on('render', drawOverlay);

// ---------------------------------------------------------------------------
// Hit testing and pointer interaction

function hitTest(p) {
  if (!state.image || !state.mesh) return null;
  const near = (q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= HIT_RADIUS;
  for (let i = state.points.length - 1; i >= 0; i--) {
    if (near(mercToScreen([state.points[i].x, state.points[i].y]))) return { kind: 'point', index: i };
  }
  const corners = meshCorners(state.mesh);
  for (let i = 0; i < 4; i++) {
    if (near(mercToScreen(corners[i]))) return { kind: 'corner', index: i };
  }
  const m = screenToMerc(p);
  const uv = invertMesh(state.mesh, m[0], m[1]);
  if (uv) return { kind: 'image', uv, merc: m };
  return null;
}

function cornerUV(i) {
  const { W, H } = state.image;
  return [[0, 0], [W, 0], [W, H], [0, H]][i];
}

const isCommand = (e) => e.metaKey || e.ctrlKey;

function cursorFor(hit, cmd) {
  if (!hit) return '';
  if (hit.kind === 'point') return cmd ? 'pointer' : 'grab';
  if (cmd) return 'copy';
  if (hit.kind === 'corner') return hit.index % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
  return 'move';
}

let lastPointer = null;
let swallowing = false;

function setHover(hit, cmd) {
  const key = (h) => h ? h.kind + (h.index ?? '') : '';
  const changed = key(hit) !== key(state.hover);
  state.hover = hit && hit.kind !== 'image' ? hit : null;
  map.getCanvas().style.cursor = cursorFor(hit, cmd);
  if (changed) drawOverlay();
}

const container = map.getContainer();

container.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary || state.drag) return;
  if (e.target.closest('.maplibregl-ctrl')) return;
  const p = localPoint(e);
  const hit = hitTest(p);
  if (!hit) return;
  // Keep MapLibre from starting a pan/rotate for this gesture.
  e.preventDefault();
  e.stopPropagation();
  swallowing = true;

  if (isCommand(e)) {
    if (hit.kind === 'point') {
      state.points.splice(hit.index, 1);
    } else {
      const uv = hit.kind === 'corner' ? cornerUV(hit.index) : hit.uv;
      const target = hit.kind === 'corner' ? state.warp.map(uv[0], uv[1]) : hit.merc;
      state.points.push({ u: uv[0], v: uv[1], x: target[0], y: target[1] });
    }
    state.hover = null;
    update();
    return;
  }

  const m0 = screenToMerc(p);
  const drag = {
    kind: hit.kind,
    index: hit.index,
    m0,
    T0: state.T.slice(),
    pts0: state.points.map(q => ({ ...q })),
  };
  if (hit.kind === 'point') {
    const q = state.points[hit.index];
    drag.offset = [q.x - m0[0], q.y - m0[1]];
  } else if (hit.kind === 'corner') {
    const { W, H } = state.image;
    drag.pivot = state.warp.map(W / 2, H / 2);
  }
  state.drag = drag;
  document.body.classList.add('dragging');
  map.getCanvas().style.cursor = hit.kind === 'point' ? 'grabbing' : cursorFor(hit, false);
  map.triggerRepaint();
  drawOverlay();
}, true);

// MapLibre listens to mouse and touch events as well; drop the ones that
// belong to a gesture we have claimed.
for (const type of ['mousedown', 'touchstart', 'dblclick', 'contextmenu']) {
  container.addEventListener(type, (e) => {
    if (swallowing || (type === 'dblclick' && hitTest(localPoint(e)))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

container.addEventListener('pointermove', (e) => {
  lastPointer = localPoint(e);
  if (!state.drag) setHover(hitTest(lastPointer), isCommand(e));
});

window.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d || !e.isPrimary) return;
  const m = screenToMerc(localPoint(e));
  const dx = m[0] - d.m0[0], dy = m[1] - d.m0[1];

  if (d.kind === 'image') {
    state.T = translateAffine(d.T0, dx, dy);
    state.points = d.pts0.map(q => ({ ...q, x: q.x + dx, y: q.y + dy }));
  } else if (d.kind === 'point') {
    const nx = m[0] + d.offset[0], ny = m[1] + d.offset[1];
    if (state.points.length === 1) {
      const q = d.pts0[0];
      state.T = translateAffine(d.T0, nx - q.x, ny - q.y);
    }
    state.points = d.pts0.map(q => ({ ...q }));
    state.points[d.index].x = nx;
    state.points[d.index].y = ny;
  } else if (d.kind === 'corner') {
    // Complex ratio of (pointer - pivot) to (start - pivot).
    const ax = d.m0[0] - d.pivot[0], ay = d.m0[1] - d.pivot[1];
    const bx = m[0] - d.pivot[0], by = m[1] - d.pivot[1];
    const a2 = ax * ax + ay * ay;
    if (a2 === 0) return;
    let kr = (bx * ax + by * ay) / a2, ki = (by * ax - bx * ay) / a2;
    if (e.shiftKey) {
      kr = Math.hypot(kr, ki);
      ki = 0;
    }
    if (kr === 0 && ki === 0) return;
    const [px, py] = d.pivot;
    state.T = similarityAboutPivot(d.T0, d.pivot, kr, ki);
    state.points = d.pts0.map(q => {
      const rx = q.x - px, ry = q.y - py;
      return { ...q, x: px + kr * rx - ki * ry, y: py + ki * rx + kr * ry };
    });
  }
  update();
});

function endDrag(cancel) {
  const d = state.drag;
  swallowing = false;
  if (!d) return;
  if (cancel) {
    state.T = d.T0;
    state.points = d.pts0;
  }
  state.drag = null;
  document.body.classList.remove('dragging');
  update();
  if (lastPointer) setHover(hitTest(lastPointer), false);
}

window.addEventListener('pointerup', (e) => { if (e.isPrimary) endDrag(false); });
window.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') endDrag(true);
  if ((e.key === 'Meta' || e.key === 'Control') && lastPointer && !state.drag) {
    setHover(hitTest(lastPointer), true);
  }
});
window.addEventListener('keyup', (e) => {
  if ((e.key === 'Meta' || e.key === 'Control') && lastPointer && !state.drag) {
    setHover(hitTest(lastPointer), false);
  }
});
window.addEventListener('blur', () => endDrag(false));

// ---------------------------------------------------------------------------
// Loading images

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const WORLD_RE = /\.(wld|pgw|pngw|jgw|jpgw|jpegw|wpw|webpw)$/i;

window.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragover');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files], localPoint(e));
});

$('file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) loadFiles(files, null);
});

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name}`));
    };
    img.src = url;
  });
}

async function loadFiles(files, dropPoint) {
  const imageFile = files.find(f => IMAGE_RE.test(f.name) || /^image\//.test(f.type));
  if (!imageFile) {
    setStatus('That doesn’t look like a JPEG, PNG or WebP image.', true);
    return;
  }
  const worldFile = files.find(f => WORLD_RE.test(f.name));
  const crsFile = files.find(f => /\.(prj|aux\.xml)$/i.test(f.name));
  let img;
  try {
    img = await decodeImage(imageFile);
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  const W = img.naturalWidth, H = img.naturalHeight;
  const bytes = new Uint8Array(await imageFile.arrayBuffer());

  let placement = null, how = '';
  try {
    if (isPNG(bytes)) placement = placementFromMetadata(readTextChunks(bytes)[META_KEY], W, H);
    if (placement) how = 'placed from embedded metadata';
    if (!placement && worldFile) {
      placement = placementFromWorldFile(await worldFile.text(),
        crsFile ? await crsFile.text() : '', W, H);
      if (placement) how = `placed from ${worldFile.name}`;
    }
  } catch (err) {
    console.warn(err);
    placement = null;
  }
  if (!placement) {
    placement = { T: dropPlacement(dropPoint, W, H), points: [] };
  }

  state.image = { name: imageFile.name, img, W, H };
  state.T = placement.T;
  state.points = placement.points;
  state.drag = null;
  imageLayer.texDirty = true;
  update();
  if (placement.points.length || how) zoomToImage();
  setStatus(`<b>${escapeHTML(imageFile.name)}</b> (${W}×${H})${how ? ', ' + how : ''}.`);
}

// Centre the image on the drop point, upright on screen, at 75% of the view.
function dropPlacement(dropPoint, W, H) {
  const canvas = map.getCanvas();
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const p = dropPoint || [cw / 2, ch / 2];
  const fit = Math.min(0.75 * cw / W, 0.75 * ch / H);
  const m0 = screenToMerc(p);
  const mx = screenToMerc([p[0] + 100, p[1]]);
  const my = screenToMerc([p[0], p[1] + 100]);
  const a = (mx[0] - m0[0]) / 100 * fit, d = (mx[1] - m0[1]) / 100 * fit;
  const b = (my[0] - m0[0]) / 100 * fit, e = (my[1] - m0[1]) / 100 * fit;
  return [a, b, m0[0] - a * W / 2 - b * H / 2, d, e, m0[1] - d * W / 2 - e * H / 2];
}

function placementFromMetadata(text, W, H) {
  if (!text) return null;
  const meta = JSON.parse(text);
  if (!Array.isArray(meta.worldFile) || meta.worldFile.length !== 6) return null;
  if (meta.width && meta.height && (meta.width !== W || meta.height !== H)) {
    // The image was resized since export; scale the world file to match.
    const sx = meta.width / W, sy = meta.height / H;
    const [A, D, B, E, C, F] = meta.worldFile;
    meta.worldFile = [A * sx, D * sx, B * sy, E * sy,
      C - 0.5 * A - 0.5 * B + 0.5 * A * sx + 0.5 * B * sy,
      F - 0.5 * D - 0.5 * E + 0.5 * D * sx + 0.5 * E * sy];
    for (const cp of meta.controlPoints || []) cp.pixel = [cp.pixel[0] / sx, cp.pixel[1] / sy];
  }
  const T = worldFileToAffine(meta.worldFile);
  const points = (meta.controlPoints || []).map(cp => {
    const [x, y] = toMerc({ lng: cp.lngLat[0], lat: cp.lngLat[1] });
    return { u: cp.pixel[0], v: cp.pixel[1], x, y };
  });
  return { T, points };
}

function placementFromWorldFile(text, crsText, W, H) {
  const wf = text.trim().split(/\s+/).map(Number);
  if (wf.length < 6 || wf.some(n => !Number.isFinite(n))) return null;
  const [A, D, B, E, C, F] = wf;
  let geographic;
  if (/3857|3785|900913|pseudo[ _-]?mercator|auxiliary_sphere/i.test(crsText)) geographic = false;
  else if (/GEOGCS|GEOGCRS|EPSG"?,\s*"?4326|EPSG:4326/i.test(crsText) && !/PROJCS|PROJCRS/i.test(crsText)) geographic = true;
  else if (crsText) {
    setStatus('Only EPSG:3857 and EPSG:4326 world files are supported.', true);
    return null;
  } else {
    geographic = Math.abs(C) <= 180 && Math.abs(F) <= 90 && Math.abs(A) < 1 && Math.abs(E) < 1;
  }
  if (!geographic) return { T: worldFileToAffine(wf), points: [] };
  const corner = (u, v) => toMerc({
    lng: A * (u - 0.5) + B * (v - 0.5) + C,
    lat: D * (u - 0.5) + E * (v - 0.5) + F,
  });
  const p0 = corner(0, 0), p1 = corner(W, 0), p2 = corner(0, H);
  return {
    T: [(p1[0] - p0[0]) / W, (p2[0] - p0[0]) / H, p0[0], (p1[1] - p0[1]) / W, (p2[1] - p0[1]) / H, p0[1]],
    points: [],
  };
}

// ---------------------------------------------------------------------------
// Export

const WKT_3857 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],' +
  'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,' +
  'AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],' +
  'PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],' +
  'PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],' +
  'AXIS["Northing",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 ' +
  '+x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]';

const MAX_EXPORT_PIXELS = 64e6;

async function exportImage() {
  if (!state.image) return;
  const { img, W, H, name } = state.image;
  const bent = state.points.length >= 3;
  const mesh = buildMesh(state.warp.map, W, H, bent ? cellsAcross(W, H, EXPORT_CELLS) : 1);
  const [minX, minY, maxX, maxY] = meshBounds(mesh);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const glOpts = { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: false, alpha: true };
  const gl = canvas.getContext('webgl2', glOpts) || canvas.getContext('webgl', glOpts);
  if (!gl) {
    setStatus('Export needs WebGL.', true);
    return;
  }
  const maxSide = Math.min(16384, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));

  // Keep roughly the source resolution, within browser limits.
  let ps = affineScale(state.warp.S);
  let ow, oh;
  for (let attempt = 0; attempt < 8; attempt++) {
    ow = Math.max(1, Math.ceil((maxX - minX) / ps));
    oh = Math.max(1, Math.ceil((maxY - minY) / ps));
    const shrink = Math.max(1, ow / maxSide, oh / maxSide, Math.sqrt(ow * oh / MAX_EXPORT_PIXELS));
    if (shrink > 1) {
      ps *= shrink * 1.0001;
      continue;
    }
    canvas.width = ow;
    canvas.height = oh;
    if (gl.drawingBufferWidth === ow && gl.drawingBufferHeight === oh) break;
    ps *= Math.max(ow / gl.drawingBufferWidth, oh / gl.drawingBufferHeight) * 1.0001;
  }

  const spanX = ow * ps, spanY = oh * ps;
  const origin = [minX + spanX / 2, minY + spanY / 2];
  const renderer = new MeshRenderer(gl);
  renderer.setTexture(textureSource(img, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
  renderer.setTriangles(meshTriangles(mesh, origin));
  gl.viewport(0, 0, ow, oh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.BLEND);
  const matrix = new Float32Array([2 / spanX, 0, 0, 0, 0, -2 / spanY, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  renderer.draw(matrix, 1);
  gl.finish();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  renderer.destroy();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  if (!blob) {
    setStatus('Export failed: the browser could not encode the image.', true);
    return;
  }

  // Output pixel (i, j) covers [minX + i*ps, minX + (i+1)*ps) etc.
  const outT = [ps, 0, minX, 0, ps, minY];
  const worldFile = affineToWorldFile(outT);
  const [west, north] = (({ lng, lat }) => [lng, lat])(toLngLat([minX, minY]));
  const [east, south] = (({ lng, lat }) => [lng, lat])(toLngLat([minX + spanX, minY + spanY]));
  const meta = {
    generator: 'rubbersheet',
    version: 1,
    crs: 'EPSG:3857',
    width: ow,
    height: oh,
    worldFile,
    bounds: [west, south, east, north],
    source: { name, width: W, height: H },
    controlPoints: state.points.map(p => {
      const ll = toLngLat([p.x, p.y]);
      return {
        pixel: [(p.x - minX) / ps, (p.y - minY) / ps],
        sourcePixel: [p.u, p.v],
        lngLat: [ll.lng, ll.lat],
      };
    }),
  };
  const bytes = addTextChunk(new Uint8Array(await blob.arrayBuffer()), META_KEY, JSON.stringify(meta));
  const base = name.replace(/\.[^.]+$/, '').replace(/-georef$/, '') + '-georef';
  download(new Blob([bytes], { type: 'image/png' }), `${base}.png`);
  if ($('worldfile').checked) {
    download(new Blob([worldFile.map(n => n.toPrecision(17)).join('\n') + '\n'], { type: 'text/plain' }), `${base}.pgw`);
    const aux = `<PAMDataset>\n  <SRS>${WKT_3857}</SRS>\n</PAMDataset>\n`;
    download(new Blob([aux], { type: 'application/xml' }), `${base}.png.aux.xml`);
  }
  setStatus(`Exported <b>${escapeHTML(base)}.png</b> (${ow}×${oh}).`);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------------------
// UI

function escapeHTML(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let statusBase = '';
const initialStatus = $('status').innerHTML;
function setStatus(html, error) {
  statusBase = error ? `<span style="color:#c0261b">${html}</span>` : html;
  updateUI();
}

function updateUI() {
  const has = !!state.image;
  $('export').disabled = !has;
  $('zoom').disabled = !has;
  $('remove').disabled = !has;
  $('clear').disabled = !state.points.length;
  const n = state.points.length;
  const pts = has
    ? `<br>${n} control point${n === 1 ? '' : 's'}${n < 2 ? ' — ⌘/Ctrl-click the image to add one.' : '.'}`
    : '';
  if (statusBase || has) $('status').innerHTML = statusBase + pts;
}

function zoomToImage() {
  if (!state.mesh) return;
  const [minX, minY, maxX, maxY] = meshBounds(state.mesh);
  const nw = toLngLat([minX, minY]), se = toLngLat([maxX, maxY]);
  map.fitBounds([[nw.lng, se.lat], [se.lng, nw.lat]], { padding: 60, duration: 600 });
}

$('export').addEventListener('click', () => {
  exportImage().catch(err => {
    console.error(err);
    setStatus(`Export failed: ${escapeHTML(err.message)}`, true);
  });
});
$('zoom').addEventListener('click', zoomToImage);
$('clear').addEventListener('click', () => {
  state.points = [];
  update();
});
$('remove').addEventListener('click', () => {
  state.image = null;
  state.mesh = null;
  state.points = [];
  state.hover = null;
  overlay.innerHTML = '';
  map.getCanvas().style.cursor = '';
  map.triggerRepaint();
  statusBase = '';
  $('status').innerHTML = initialStatus;
  updateUI();
});
$('opacity').addEventListener('input', (e) => {
  state.opacity = Number(e.target.value);
  map.triggerRepaint();
});
$('basemap').addEventListener('change', (e) => {
  map.setStyle(STYLES[e.target.value], { diff: false });
});

// Exposed for debugging and automated tests.
window.rubbersheet = { map, state, update, loadFiles, exportImage };
