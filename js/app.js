import {
  applyAffine, affineScale, affineToWorldFile, buildMesh, invertMesh, makeWarp,
  meshBounds, meshCorners, meshOutline, meshTriangles, mercXToLng, mercYToLat,
  EARTH_CIRCUMFERENCE, mercToMeters, similarityAboutPivot, translateAffine, worldFileToAffine,
  sampleMesh, refineMesh, invertDrawn, refinedSoup,
} from './warp.js';
import { addTextChunk, isPNG, readTextChunks } from './png-text.js';
import { makeZip, readZip } from './zip.js';
import { isTIFF, readGeoTIFF, writeGeoTIFF } from './tiff.js';
import { crsFromGeoKeys } from './proj.js';
import { estimatePaper, paperThresholds } from './paper.js';

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
  fine: null,       // finer patch of it over the part in view (refineMesh)
  origin: [0, 0],   // GPU rebasing origin for the display mesh
  drag: null,
  hover: null,
  opacity: 1,
  hidePaper: 0,     // Hide paper slider, 0 (off) to 1
  streetsOnTop: false,
  ease: null,       // a world anchor's release in progress (easeWorldRelease)
};

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');

// The map writes its own hash, so note whether the link came with a view.
const linkHasView = !!window.location.hash;

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

// With u_hide > 0, the paper (u_paper, a coarse grid of its colour across
// the image) turns transparent: paperToAlpha in paper.js, which has the
// details.
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_paper;
uniform float u_opacity;
uniform vec2 u_hide;  // the clear and solid thresholds, or 0 for off
varying vec2 v_uv;
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  if (u_hide.y > 0.0 && t.a > 0.0) {
    vec3 c = t.rgb / t.a;
    vec3 p = texture2D(u_paper, v_uv).rgb;
    vec3 dark = (p - c) / max(p, 1e-3);
    vec3 light = (c - p) / max(1.0 - p, 0.5);
    vec3 d = mix(light, dark, step(c, p));
    float need = min(max(max(d.r, d.g), d.b), 1.0);
    float a = clamp((need - u_hide.x) / (u_hide.y - u_hide.x), 0.0, 1.0);
    float div = max(a, need);
    vec3 col = div > 0.0 ? clamp(p + (c - p) / div, 0.0, 1.0) : p;
    t = vec4(col, 1.0) * (a * t.a);
  }
  gl_FragColor = t * u_opacity;
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
    this.uPaper = gl.getUniformLocation(p, 'u_paper');
    this.uHide = gl.getUniformLocation(p, 'u_hide');
    this.paperTex = null;
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

  // The paper's colour across the image, from estimatePaper; null for none.
  setPaper(paper) {
    const gl = this.gl;
    if (this.paperTex) gl.deleteTexture(this.paperTex);
    this.paperTex = null;
    if (!paper) return;
    this.paperTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paperTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paper.gw, paper.gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, paper.grid);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  setTriangles({ positions, uvs, count }) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.DYNAMIC_DRAW);
    this.count = count;
  }

  // `hide` is the Hide paper amount, 0 for off.
  draw(matrix, opacity, hide = 0) {
    const gl = this.gl;
    if (!this.tex || !this.count) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform1f(this.uOpacity, opacity);
    gl.uniform1i(this.uTex, 0);
    gl.uniform1i(this.uPaper, 1);
    gl.uniform2fv(this.uHide, hide > 0 && this.paperTex ? paperThresholds(hide) : [0, 0]);
    // The paper texture's unit is bound even when unused: an unbound sampler
    // reads black, but the map's own textures could be sitting there.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paperTex);
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
    if (this.paperTex) gl.deleteTexture(this.paperTex);
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
      this.renderer.setPaper(state.image.paper);
      this.texDirty = false;
    }
    if (this.meshDirty) {
      this.renderer.setTriangles(meshTriangles(state.mesh, state.origin, state.fine));
      this.meshDirty = false;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Half see-through while dragging, except when the streets on top are what
    // moves.
    const see = state.drag && state.drag.kind !== 'world';
    const opacity = see ? Math.min(0.5, state.opacity) : state.opacity;
    this.renderer.draw(rebaseMatrix(matrix, state.origin[0], state.origin[1]), opacity, state.hidePaper);
  },
};

map.on('style.load', () => {
  if (!map.getLayer(imageLayer.id)) map.addLayer(imageLayer);
  raised = null;
  applyStreets();
});

// ---------------------------------------------------------------------------
// Streets on top: the vector base map's road and rail lines lifted above the
// image as thin bright centrelines to align against. Yellow rather than
// magenta, which many colour-blind eyes lose. Points added while they're on
// are anchored to the world rather than the image (see the 'world' drag).

const STREET_COLOUR = '#ffe600';
const STREET_PAINT = ['line-color', 'line-width', 'line-opacity'];
let raised = null;  // {order: [all layer ids], ids: [raised], paint: {id: [...]}}

function applyStreets() {
  if (!state.streetsOnTop) {
    lowerStreets();
    return;
  }
  if (raised || !raiseStreets()) return;
  for (const id of raised.ids) {
    map.setPaintProperty(id, 'line-color', STREET_COLOUR);
    map.setPaintProperty(id, 'line-width', 1.5);
    map.setPaintProperty(id, 'line-opacity', 1);
  }
}

function streetsRaised() {
  return !!raised;
}

// Roads and railways, not their casings, footpaths or ferry routes.
function streetLayerIds() {
  return (map.getStyle()?.layers || []).filter(l => l.type === 'line' &&
    l['source-layer'] === 'transportation' && !/casing|path|pedestrian|ferry|aeroway|pier/.test(l.id)).map(l => l.id);
}

// Hide the raised lines while the overlay draws a bent copy of them.
function hideStreets(hidden) {
  if (!raised) return;
  for (const id of raised.ids) map.setPaintProperty(id, 'line-opacity', hidden ? 0 : 1);
}

function raiseStreets() {
  const layers = map.getStyle()?.layers || [];
  const ids = streetLayerIds();
  if (!ids.length) return false;
  raised = { order: layers.map(l => l.id), ids, paint: {} };
  for (const id of ids) {
    raised.paint[id] = STREET_PAINT.map(k => map.getPaintProperty(id, k));
    map.moveLayer(id);
  }
  return true;
}

function lowerStreets() {
  if (!raised) return;
  // Back where they were: each before the next layer of the original order.
  const { order, ids, paint } = raised;
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!ids.includes(id)) continue;
    const before = order.slice(i + 1).find(n => map.getLayer(n));
    map.moveLayer(id, before);
    STREET_PAINT.forEach((k, j) => map.setPaintProperty(id, k, paint[id][j]));
  }
  raised = null;
}

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
    // A single image anchor just rides along with the placement; a single
    // world anchor moves the placement to keep its spot on its place.
    const p = state.points[0];
    state.T = placementFor(state.T, p);
    if (!p.world) [p.x, p.y] = applyAffine(state.T, p.u, p.v);
  }
  state.warp = makeWarp(state.T, state.points);
  // Keep the placement in sync, so that removing points back down to one or
  // zero leaves the image where it is.
  if (state.points.length >= 2) state.T = state.warp.S;
  const bent = state.points.length >= 3;
  state.mesh = buildMesh(state.warp.map, W, H, bent ? cellsAcross(W, H, DISPLAY_CELLS) : 1);
  state.fine = refineView(state.mesh);
  const [minX, minY, maxX, maxY] = meshBounds(state.mesh);
  state.origin = [(minX + maxX) / 2, (minY + maxY) / 2];
  imageLayer.meshDirty = true;
  map.triggerRepaint();
  drawOverlay();
  updateUI();
}

// T, shifted if p is a world anchor so that p's spot lands on its place.
function placementFor(T, p) {
  if (!p.world) return T;
  const [x, y] = applyAffine(T, p.u, p.v);
  return translateAffine(T, p.x - x, p.y - y);
}

// The warp for a set of points, as update() would make it.
function warpFor(T, points) {
  if (points.length === 1) T = placementFor(T, points[0]);
  return makeWarp(T, points);
}

// The warp bends sharply near a control point that was moved a long way,
// more sharply than the display grid can follow, so at high zoom the cells
// in view are split into pieces about FINE_PX on screen, evaluated exactly.
// Rebuilt whenever the warp changes or the map stops moving.
const FINE_PX = 16;
const FINE_MAX_CELLS = 40000;

function refineView(mesh) {
  if (!mesh || mesh.nx < 2 || !state.warp) return null;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const A = mercToScreenAffine();
  const { nx, ny, pos } = mesh;
  const sx = (n) => A[0] * pos[n * 2] + A[1] * pos[n * 2 + 1] + A[2];
  const sy = (n) => A[3] * pos[n * 2] + A[4] * pos[n * 2 + 1] + A[5];
  let i0 = Infinity, j0 = Infinity, i1 = -1, j1 = -1, size = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = [j * (nx + 1) + i, j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i, (j + 1) * (nx + 1) + i + 1];
      const xs = c.map(sx), ys = c.map(sy);
      if (Math.max(...xs) < 0 || Math.min(...xs) > w || Math.max(...ys) < 0 || Math.min(...ys) > h) continue;
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      size = Math.max(size, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
  }
  if (i1 < 0) return null;
  // One cell of margin, so the seam with the coarse cells is out of view.
  i0 = Math.max(0, i0 - 1); j0 = Math.max(0, j0 - 1);
  i1 = Math.min(nx, i1 + 2); j1 = Math.min(ny, j1 + 2);
  let s = Math.min(32, Math.ceil(size / FINE_PX));
  while (s > 1 && (i1 - i0) * (j1 - j0) * s * s > FINE_MAX_CELLS) s--;
  if (s < 2) return null;
  return refineMesh(state.warp.map, mesh, i0, j0, i1, j1, s);
}

map.on('moveend', () => {
  if (!state.image || !state.mesh || state.drag || state.ease) return;
  state.fine = refineView(state.mesh);
  imageLayer.meshDirty = true;
  map.triggerRepaint();
});

// Columns for a grid whose longer side has `cells` cells.
function cellsAcross(W, H, cells) {
  return W >= H ? cells : Math.max(1, Math.round(cells * W / H));
}

// ---------------------------------------------------------------------------
// Undo and redo: snapshots of the placement and points, taken before each
// edit.

const MAX_UNDO = 50;
const edits = { undo: [], redo: [] };

function snapshot() {
  return { T: state.T.slice(), points: state.points.map(p => ({ ...p })) };
}

function restore(snap) {
  state.T = snap.T.slice();
  state.points = snap.points.map(p => ({ ...p }));
  update();
}

function sameAsNow(snap) {
  return snap.T.every((v, i) => v === state.T[i]) &&
    snap.points.length === state.points.length &&
    snap.points.every((p, i) => ['u', 'v', 'x', 'y'].every(k => p[k] === state.points[i][k]));
}

// Call before an edit. Returns a token for settle().
function checkpoint() {
  const token = { redo: edits.redo };
  edits.undo.push(snapshot());
  if (edits.undo.length > MAX_UNDO) edits.undo.shift();
  edits.redo = [];
  updateUI();
  return token;
}

// After a drag: drop the checkpoint if the drag was cancelled or changed
// nothing, so it doesn't leave an empty step (or lose the redo history).
function settle(token, cancelled) {
  const snap = edits.undo[edits.undo.length - 1];
  if (snap && (cancelled || sameAsNow(snap))) {
    edits.undo.pop();
    edits.redo = token.redo;
  }
  updateUI();
}

function undo() {
  if (state.drag || state.ease || !edits.undo.length) return;
  edits.redo.push(snapshot());
  restore(edits.undo.pop());
}

function redo() {
  if (state.drag || state.ease || !edits.redo.length) return;
  edits.undo.push(snapshot());
  restore(edits.redo.pop());
}

function resetHistory() {
  edits.undo = [];
  edits.redo = [];
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
  if (imageDraggable() && (!state.drag || state.drag.kind === 'corner')) {
    meshCorners(state.mesh).map(mercToScreen).forEach(([x, y], i) => {
      const hover = state.hover && state.hover.kind === 'corner' && state.hover.index === i;
      parts.push(`<rect class="handle${hover ? ' hover' : ''}" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`);
    });
  }
  const d = state.drag;
  if (d && d.kind === 'world' && d.preview) {
    parts.push(`<path class="bent-streets" d="${polylinePath(bentStreets(d))}"/>`);
  } else if (state.ease) {
    parts.push(`<path class="bent-streets" d="${easedStreetsPath(state.ease)}"/>`);
  }
  state.points.forEach((p, i) => {
    const active = d && ['point', 'world'].includes(d.kind) && d.index === i;
    // A world anchor being dragged rides on its bent street, at the pointer.
    const easing = state.ease && state.ease.index === i;
    const [x, y] = active && d.kind === 'world' && d.cursor ? d.cursor
      : easing ? state.ease.cursor : mercToScreen([p.x, p.y]);
    const hover = state.hover && state.hover.kind === 'point' && state.hover.index === i;
    // World anchors are squares, image anchors circles.
    const ring = p.world ? '<rect class="ring" x="-6.5" y="-6.5" width="13" height="13"/>' : '<circle class="ring" r="7"/>';
    parts.push(`<g class="cp${p.world ? ' world' : ''}${active ? ' active' : ''}${hover ? ' hover' : ''}" ` +
      `transform="translate(${x},${y})">${ring}` +
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
  if (imageDraggable()) {
    const corners = meshCorners(state.mesh);
    for (let i = 0; i < 4; i++) {
      if (near(mercToScreen(corners[i]))) return { kind: 'corner', index: i };
    }
  }
  const m = screenToMerc(p);
  const uv = invertDrawn(state.mesh, state.fine, m[0], m[1]);
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
  return imageMovable() ? 'move' : '';
}

// Once the image is pinned by a control point, its corner handles go away and
// dragging its background pans the map instead of moving the image.
const imageDraggable = () => state.points.length === 0;

// Dragging the image's background moves it only while a corner handle is in
// view; zoomed in past all four, it pans the map instead.
function imageMovable() {
  if (!imageDraggable() || !state.mesh) return false;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const box = map.getContainer().getBoundingClientRect();
  const pr = $('panel').getBoundingClientRect();
  return meshCorners(state.mesh).map(mercToScreen).some(([x, y]) =>
    x >= 0 && x <= w && y >= 0 && y <= h &&
    !(x + box.left >= pr.left && x + box.left <= pr.right && y + box.top >= pr.top && y + box.top <= pr.bottom));
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
  if (e.button !== 0 || !e.isPrimary || state.drag || state.ease) return;
  if (e.target.closest('.maplibregl-ctrl')) return;
  const p = localPoint(e);
  const hit = hitTest(p);
  if (!hit) return;
  if (hit.kind === 'image' && !isCommand(e) && !imageMovable()) return;
  // Keep MapLibre from starting a pan/rotate for this gesture.
  e.preventDefault();
  e.stopPropagation();
  swallowing = true;

  // World anchors: dragging one bends the streets, not the image, and
  // ⌘-clicking the image with the streets on top adds one (and drags it).
  const grabWorld = hit.kind === 'point' && !isCommand(e) && state.points[hit.index].world;
  const addWorld = isCommand(e) && hit.kind === 'image' && streetsRaised();
  if (grabWorld || addWorld) {
    const token = checkpoint();
    let index = hit.index, offset = [0, 0];
    if (addWorld) {
      state.points.push({ u: hit.uv[0], v: hit.uv[1], x: hit.merc[0], y: hit.merc[1], world: true });
      index = state.points.length - 1;
      update();
    } else {
      const q = state.points[index];
      const [sx, sy] = mercToScreen([q.x, q.y]);
      offset = [sx - p[0], sy - p[1]];
    }
    state.drag = startWorldDrag(index, token, offset);
    document.body.classList.add('dragging');
    map.getCanvas().style.cursor = 'grabbing';
    hideStreets(true);
    drawOverlay();
    return;
  }

  if (isCommand(e)) {
    checkpoint();
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
    token: checkpoint(),
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
  lastPointer = localPoint(e);
  const m = screenToMerc(lastPointer);
  if (d.kind === 'world') {
    worldStep(d, [lastPointer[0] + d.offset[0], lastPointer[1] + d.offset[1]]);
    return;
  }
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

// ---------------------------------------------------------------------------
// World anchors. Dragging one keeps the image still and bends the streets:
// a screen grid records which image pixel lies under each node; as the
// anchor moves, each node's offset is how far the new warp would carry that
// pixel, and the streets are drawn shifted back by it, so they show where
// they'll sit against the image once the drag is released.

const PREVIEW_STEP = 24;  // screen px between grid nodes

// Affine from Mercator units to screen pixels (exact: no pitch).
function mercToScreenAffine() {
  const c = screenToMerc([0, 0]);
  const e = 1e-6;
  const [x0, y0] = mercToScreen(c);
  const [x1, y1] = mercToScreen([c[0] + e, c[1]]);
  const [x2, y2] = mercToScreen([c[0], c[1] + e]);
  const a = (x1 - x0) / e, b = (x2 - x0) / e, d = (y1 - y0) / e, f = (y2 - y0) / e;
  return [a, b, x0 - a * c[0] - b * c[1], d, f, y0 - d * c[0] - f * c[1]];
}

function startWorldDrag(index, token, offset) {
  const canvas = map.getCanvas();
  const nx = Math.ceil(canvas.clientWidth / PREVIEW_STEP) + 1;
  const ny = Math.ceil(canvas.clientHeight / PREVIEW_STEP) + 1;
  const A = mercToScreenAffine();
  // The visible streets, as screen polylines.
  const ids = streetLayerIds().filter(id => map.getLayer(id));
  const streets = [];
  for (const f of ids.length ? map.queryRenderedFeatures({ layers: ids }) : []) {
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      const pts = new Float64Array(line.length * 2);
      line.forEach(([lng, lat], k) => {
        const [mx, my] = toMerc({ lng, lat });
        pts[k * 2] = A[0] * mx + A[1] * my + A[2];
        pts[k * 2 + 1] = A[3] * mx + A[4] * my + A[5];
      });
      streets.push(pts);
    }
  }
  return {
    kind: 'world', index, token, offset,
    T0: state.T.slice(),
    pts0: state.points.map(q => ({ ...q })),
    mesh: state.mesh,
    fine: state.fine,
    A, nx, ny,
    under: sampleDrawn(A, nx, ny),
    streets,
    preview: null,
    cursor: null,
  };
}

// The image pixel under each grid node, as drawn: the fine patch where it
// covers, the coarse mesh elsewhere.
function sampleDrawn(A, nx, ny) {
  const under = sampleMesh(state.mesh, A, nx, ny, PREVIEW_STEP);
  const f = state.fine;
  if (f) {
    const fine = sampleMesh(f.mesh, A, nx, ny, PREVIEW_STEP);
    for (let k = 0; k < fine.length; k += 2) {
      if (Number.isNaN(fine[k])) continue;
      under[k] = fine[k] + f.u0;
      under[k + 1] = fine[k + 1] + f.v0;
    }
  }
  return under;
}

function worldStep(d, cursor) {
  d.cursor = cursor;
  const m = screenToMerc(cursor);
  const uv = invertDrawn(d.mesh, d.fine, m[0], m[1]);
  if (!uv) return;  // Off the image: keep the last good preview.
  const pts = d.pts0.map(q => ({ ...q }));
  pts[d.index].u = uv[0];
  pts[d.index].v = uv[1];
  const warp = warpFor(d.T0, pts);
  const { A, nx, ny, under } = d;
  const off = new Float64Array(nx * ny * 2);
  for (let k = 0; k < nx * ny; k++) {
    const u = under[k * 2];
    if (Number.isNaN(u)) continue;
    const [x, y] = warp.map(u, under[k * 2 + 1]);
    off[k * 2] = A[0] * x + A[1] * y + A[2] - (k % nx) * PREVIEW_STEP;
    off[k * 2 + 1] = A[3] * x + A[4] * y + A[5] - Math.floor(k / nx) * PREVIEW_STEP;
  }
  d.preview = { pts, off, cursor };
  drawOverlay();
}

// The streets bent by the preview: a street at screen v is drawn at q with
// q + off(q) = v (the image pixel at q will move to v), found by iterating.
// Returns polylines like d.streets.
function bentStreets(d) {
  const { nx, ny } = d, { off } = d.preview;
  const at = (x, y) => {
    const fx = Math.min(Math.max(x / PREVIEW_STEP, 0), nx - 1.000001);
    const fy = Math.min(Math.max(y / PREVIEW_STEP, 0), ny - 1.000001);
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const k = (j * nx + i) * 2, k2 = k + nx * 2;
    const w = [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b];
    return [
      w[0] * off[k] + w[1] * off[k + 2] + w[2] * off[k2] + w[3] * off[k2 + 2],
      w[0] * off[k + 1] + w[1] * off[k + 3] + w[2] * off[k2 + 1] + w[3] * off[k2 + 3],
    ];
  };
  return d.streets.map(line => {
    const bent = new Float64Array(line.length);
    for (let k = 0; k < line.length; k += 2) {
      const vx = line[k], vy = line[k + 1];
      let qx = vx, qy = vy;
      for (let it = 0; it < 3; it++) {
        const [ox, oy] = at(qx, qy);
        qx = vx - ox;
        qy = vy - oy;
      }
      bent[k] = qx;
      bent[k + 1] = qy;
    }
    return bent;
  });
}

function polylinePath(lines) {
  const out = [];
  for (const line of lines) {
    for (let k = 0; k < line.length; k += 2) out.push(`${k ? 'L' : 'M'}${line[k].toFixed(1)},${line[k + 1].toFixed(1)}`);
  }
  return out.join('');
}

// After a world anchor is released, ease the map so the anchor stays where
// it was let go, easing the image from the old warp to the new and the
// streets from bent to true in step: with the camera moved a fraction e of
// the way, the image blended e of the way and the streets likewise, the
// anchor's spot stays put on screen throughout.
const EASE = { ms: 250 };

function easeWorldRelease(d) {
  const q = state.points[d.index];
  const [sx, sy] = mercToScreen([q.x, q.y]);
  const [cx, cy] = d.preview.cursor;
  const dx = sx - cx, dy = sy - cy;
  if (!dx && !dy) return false;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth / 2, h = canvas.clientHeight / 2;
  const from = d.mesh, to = state.mesh, fineFrom = d.fine;
  const same = (a, b) => a.nx === b.nx && a.ny === b.ny;
  // The new warp's fine patch over the same cells as the old, to blend.
  const fineTo = fineFrom && same(from, to)
    ? refineMesh(state.warp.map, to, fineFrom.i0, fineFrom.j0, fineFrom.i1, fineFrom.j1, fineFrom.s)
    : state.fine;
  const ease = {
    index: d.index, cursor: [cx, cy], dx, dy, e: 0,
    c0: screenToMerc([w, h]), c1: screenToMerc([w + dx, h + dy]),
    blend: same(from, to),
    // The fine patches blend too when they cover the same cells.
    blendFine: !!fineFrom && !!fineTo && same(fineFrom.mesh, fineTo.mesh) &&
      fineFrom.i0 === fineTo.i0 && fineFrom.j0 === fineTo.j0,
    streets: d.streets, bent: bentStreets(d),
  };
  state.ease = ease;
  hideStreets(true);
  const lerp = (a, b, e) => {
    const pos = new Float64Array(b.length);
    for (let k = 0; k < pos.length; k++) pos[k] = a[k] + (b[k] - a[k]) * e;
    return pos;
  };
  const show = (e) => {
    if (ease.blend) state.mesh = { ...to, pos: lerp(from.pos, to.pos, e) };
    state.fine = ease.blendFine ? { ...fineTo, mesh: { ...fineTo.mesh, pos: lerp(fineFrom.mesh.pos, fineTo.mesh.pos, e) } }
      : ease.blend ? null : fineTo;
    imageLayer.meshDirty = true;
  };
  // Start from what was on screen: update() has already made the new mesh.
  show(0);
  let start = null;
  const frame = (now) => {
    // Time from the first frame's own timestamp, which can be earlier than
    // performance.now() when this was scheduled.
    start ??= now;
    const t = Math.min(1, (now - start) / EASE.ms);
    const e = ease.e = 1 - (1 - t) ** 3;
    const { c0, c1 } = ease;
    map.jumpTo({ center: toLngLat([c0[0] + (c1[0] - c0[0]) * e, c0[1] + (c1[1] - c0[1]) * e]) });
    show(e);
    if (t < 1) {
      map.triggerRepaint();
      requestAnimationFrame(frame);
      return;
    }
    state.ease = null;
    state.mesh = to;
    state.fine = refineView(to);
    imageLayer.meshDirty = true;
    hideStreets(false);
    map.triggerRepaint();
    drawOverlay();
  };
  requestAnimationFrame(frame);
  return true;
}

// The streets part way through the ease, at the current camera.
function easedStreetsPath(ease) {
  const { e, dx, dy, streets, bent } = ease;
  return polylinePath(streets.map((line, i) => {
    const b = bent[i], out = new Float64Array(line.length);
    for (let k = 0; k < line.length; k += 2) {
      out[k] = b[k] + (line[k] - b[k]) * e - dx * e;
      out[k + 1] = b[k + 1] + (line[k + 1] - b[k + 1]) * e - dy * e;
    }
    return out;
  }));
}

function endDrag(cancel) {
  const d = state.drag;
  swallowing = false;
  if (!d) return;
  if (d.kind === 'world') {
    hideStreets(false);
    // The image spot under the pointer goes to the anchor's place.
    if (!cancel && d.preview) state.points = d.preview.pts;
  }
  if (cancel) {
    state.T = d.T0;
    state.points = d.pts0;
  }
  settle(d.token, cancel);
  state.drag = null;
  document.body.classList.remove('dragging');
  update();
  if (d.kind === 'world' && !cancel && d.preview) easeWorldRelease(d);
  if (lastPointer) setHover(hitTest(lastPointer), false);
}

window.addEventListener('pointerup', (e) => { if (e.isPrimary) endDrag(false); });
window.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') endDrag(true);
  // ⌘Z / Ctrl-Z undoes, ⇧⌘Z / Ctrl-Shift-Z / Ctrl-Y redoes, outside text fields.
  if (isCommand(e) && !e.target.closest('input[type=text], textarea')) {
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    }
  }
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

const IMAGE_RE = /\.(png|jpe?g|webp|tiff?)$/i;
const WORLD_RE = /\.(wld|pgw|pngw|jgw|jpgw|jpegw|wpw|webpw)$/i;
const KMZ_RE = /\.kmz$/i;
const isImageFile = (f) => IMAGE_RE.test(f.name) || /^image\//.test(f.type);

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

async function loadFiles(files, dropPoint, { keepView = false, fromURL = false } = {}) {
  let imageFile = files.find(isImageFile);
  let kmlText = '';
  const kmzFile = files.find(f => KMZ_RE.test(f.name));
  if (!imageFile && kmzFile) {
    try {
      ({ imageFile, kmlText } = await unpackKMZ(kmzFile));
    } catch (err) {
      console.warn(err);
      setStatus(`Could not read <b>${escapeHTML(kmzFile.name)}</b>: ${escapeHTML(err.message)}`, true);
      return;
    }
  }
  if (!imageFile) {
    setStatus('That doesn’t look like a JPEG, PNG, WebP, GeoTIFF or KMZ file.', true);
    return;
  }
  const worldFile = files.find(f => WORLD_RE.test(f.name));
  const crsFile = files.find(f => /\.(prj|aux\.xml)$/i.test(f.name));
  const bytes = new Uint8Array(await imageFile.arrayBuffer());
  let img, tiff = null;
  try {
    if (isTIFF(bytes)) {
      setStatus(`Reading <b>${escapeHTML(imageFile.name)}</b>…`);
      tiff = await readGeoTIFF(bytes, decodeJPEG);
      img = document.createElement('canvas');
      img.width = tiff.width;
      img.height = tiff.height;
      img.getContext('2d').putImageData(new ImageData(tiff.rgba, tiff.width, tiff.height), 0, 0);
    } else {
      img = await decodeImage(imageFile);
    }
  } catch (err) {
    console.warn(err);
    setStatus(`Could not read <b>${escapeHTML(imageFile.name)}</b>: ${escapeHTML(err.message)}`, true);
    return;
  }
  let source = img;
  let W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;

  let placement = null, how = '', problem = '';
  try {
    if (isPNG(bytes)) placement = placementFromMetadata(readTextChunks(bytes)[META_KEY], W, H);
    if (tiff?.description?.includes('"generator":"rubbersheet"')) {
      placement = placementFromMetadata(tiff.description, W, H);
    }
    if (placement) how = 'placed from embedded metadata';
    if (!placement && tiff?.toModel) {
      try {
        placement = placementFromGeoTIFF(tiff);
        how = 'placed from its GeoTIFF tags';
      } catch (err) {
        problem = `It couldn’t be placed: ${err.message}.`;
      }
    }
    if (!placement && worldFile) {
      placement = placementFromWorldFile(await worldFile.text(),
        crsFile ? await crsFile.text() : '', W, H);
      if (placement) how = `placed from ${worldFile.name}`;
    }
    if (!placement && kmlText) {
      placement = placementFromKML(kmlText, W, H);
      if (placement) how = 'placed from the KML';
    }
    if (placement?.project) {
      setStatus(`Reprojecting <b>${escapeHTML(imageFile.name)}</b>…`);
      const r = await reproject(img, W, H, placement.project, placement.points);
      ({ img: source, W, H } = r);
      placement = r;
    }
  } catch (err) {
    console.warn(err);
    placement = null;
    how = '';
  }
  if (!placement) {
    placement = { T: dropPlacement(dropPoint, W, H), points: [] };
  }

  state.image = { name: imageFile.name, img: source, W, H, paper: findPaper(source) };
  state.T = placement.T;
  state.points = placement.points;
  state.drag = null;
  resetHistory();
  imageLayer.texDirty = true;
  update();
  if ((placement.points.length || how) && !keepView) zoomToImage();
  if (!fromURL) clearImageParam();
  setStatus(`<b>${escapeHTML(imageFile.name)}</b> (${W}×${H})${how ? ', ' + how : ''}.` +
    (problem ? ` ${escapeHTML(problem)}` : ''), !!problem);
}

// The paper's colour across an image (estimatePaper), found on a copy at most
// PAPER_SIDE pixels across. Null if the browser won't share the pixels.
const PAPER_SIDE = 320;
function findPaper(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const s = Math.min(1, PAPER_SIDE / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * s));
  c.height = Math.max(1, Math.round(H * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  try {
    return estimatePaper(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  } catch (err) {
    console.warn(err);
    return null;
  }
}

// ?image=<url> loads an image from the web. The server has to allow
// cross-origin requests.
function clearImageParam() {
  const u = new URL(window.location.href);
  if (!u.searchParams.has('image')) return;
  u.searchParams.delete('image');
  history.replaceState(history.state, '', u);
}

async function loadURL(url, keepView = false) {
  setStatus(`Loading <b>${escapeHTML(url)}</b>…`);
  let blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    console.warn(err);
    setStatus(`Could not load <b>${escapeHTML(url)}</b> (${escapeHTML(err.message)}). ` +
      'The server must allow cross-origin requests.', true);
    return;
  }
  let name = '';
  try {
    name = decodeURIComponent(new URL(url, window.location.href).pathname.split('/').pop());
  } catch { /* keep the fallback */ }
  if (!IMAGE_RE.test(name) && !KMZ_RE.test(name)) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/tiff': 'tif',
      'application/vnd.google-earth.kmz': 'kmz' }[blob.type] || 'png';
    name = `image.${ext}`;
  }
  await loadFiles([new File([blob], name, { type: blob.type })], null, { keepView, fromURL: true });
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
  if (meta.crs === 'EPSG:4326') {
    // Exported for Google Earth: reprojected back to Mercator by the caller.
    const points = (meta.controlPoints || []).map(cp => ({
      u: cp.pixel[0], v: cp.pixel[1], lng: cp.lngLat[0], lat: cp.lngLat[1],
    }));
    return { project: worldFileProject(meta.worldFile), points };
  }
  const T = worldFileToAffine(meta.worldFile);
  const points = (meta.controlPoints || []).map(cp => {
    const [x, y] = toMerc({ lng: cp.lngLat[0], lat: cp.lngLat[1] });
    return { u: cp.pixel[0], v: cp.pixel[1], x, y, ...(cp.anchor === 'world' ? { world: true } : {}) };
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
  return { project: worldFileProject(wf), points: [] };
}

// Pixel -> lng/lat for an EPSG:4326 world file (which references pixel
// centres).
function worldFileProject([A, D, B, E, C, F]) {
  return (u, v) => [A * (u - 0.5) + B * (v - 0.5) + C, D * (u - 0.5) + E * (v - 0.5) + F];
}

// Placement from GeoTIFF tags: exact for Web Mercator, otherwise a pixel ->
// lng/lat function for the caller to reproject. Throws if the CRS isn't
// supported.
function placementFromGeoTIFF(tiff) {
  const crs = crsFromGeoKeys(tiff.geoKeys);
  const [a, b, c, d, e, f] = tiff.toModel;
  if (crs.kind === 'mercator') {
    const k = 1 / EARTH_CIRCUMFERENCE;
    return { T: [a * k, b * k, c * k + 0.5, -d * k, -e * k, 0.5 - f * k], points: [] };
  }
  return { project: (u, v) => crs.toLngLat(a * u + b * v + c, d * u + e * v + f), points: [] };
}

// Redraw an image placed by `project` (pixel -> [lng, lat]) as a north-up
// Web Mercator raster at about the same resolution, through the same mesh
// renderer as the export. `points` ({u, v, lng, lat}) are moved to match.
// Returns {img, W, H, T, points}.
async function reproject(img, W, H, project, points) {
  const merc = (u, v) => {
    const [lng, lat] = project(u, v);
    return toMerc({ lng, lat });
  };
  const mesh = buildMesh(merc, W, H, cellsAcross(W, H, DISPLAY_CELLS));
  // Pixel size from the middle of the image.
  const p = merc(W / 2, H / 2), pu = merc(W / 2 + 1, H / 2), pv = merc(W / 2, H / 2 + 1);
  const ps = Math.sqrt(Math.hypot(pu[0] - p[0], pu[1] - p[1]) * Math.hypot(pv[0] - p[0], pv[1] - p[1]));
  const r = await rasterize(mesh, mesh.pos, ps, ps, Infinity, 'canvas', img);
  return {
    img: r.canvas,
    W: r.ow,
    H: r.oh,
    T: [r.px, 0, r.minX, 0, r.py, r.minY],
    points: points.map(pt => {
      const [mx, my] = merc(pt.u, pt.v);
      const [x, y] = toMerc({ lng: pt.lng, lat: pt.lat });
      return { u: (mx - r.minX) / r.px, v: (my - r.minY) / r.py, x, y };
    }),
  };
}

// Decode one JPEG to RGBA, for JPEG-compressed GeoTIFFs.
async function decodeJPEG(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { width: c.width, height: c.height, rgba: ctx.getImageData(0, 0, c.width, c.height).data };
}

// Placement from a KML GroundOverlay's LatLonBox.
function placementFromKML(text, W, H) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const box = doc.getElementsByTagName('LatLonBox')[0];
  if (!box) return null;
  const get = (tag) => Number(box.getElementsByTagName(tag)[0]?.textContent);
  const north = get('north'), south = get('south'), west = get('west');
  let east = get('east');
  const rotation = get('rotation') || 0;
  if (![north, south, east, west].every(Number.isFinite) || north <= south) return null;
  if (east <= west) east += 360;
  // The box is rotated anticlockwise about its centre, in degrees of lng/lat.
  const cx = (west + east) / 2, cy = (north + south) / 2;
  const cos = Math.cos(rotation * Math.PI / 180), sin = Math.sin(rotation * Math.PI / 180);
  return {
    project: (u, v) => {
      const dx = west + (east - west) * u / W - cx, dy = north + (south - north) * v / H - cy;
      return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    },
    points: [],
  };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// The overlay image and KML from a KMZ. Uses the first GroundOverlay's
// image, or failing that the first image in the archive.
async function unpackKMZ(file) {
  const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
  const kml = entries.find(e => /(^|\/)doc\.kml$/i.test(e.name)) || entries.find(e => /\.kml$/i.test(e.name));
  const kmlText = kml ? new TextDecoder().decode(kml.data) : '';
  let entry = null;
  if (kmlText) {
    const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
    const overlay = doc.getElementsByTagName('GroundOverlay')[0];
    const href = overlay?.getElementsByTagName('href')[0]?.textContent.trim();
    if (href) {
      let path = href;
      try { path = decodeURI(href); } catch { /* use as is */ }
      path = path.replace(/^\.\//, '');
      entry = entries.find(e => e.name === path || e.name === href);
    }
  }
  entry ||= entries.find(e => IMAGE_RE.test(e.name));
  if (!entry) throw new Error('no PNG, JPEG or WebP image inside.');
  const name = entry.name.split('/').pop();
  const type = MIME[name.split('.').pop().toLowerCase()] || '';
  return { imageFile: new File([entry.data], name, { type }), kmlText };
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
const MAX_EXPORT_SIDE = 16384;
// Pixels per WebGL strip, comfortably under the browsers' drawing buffer caps.
const MAX_STRIP_PIXELS = 16e6;
// Google Earth downsamples or refuses larger overlays on many graphics cards.
const MAX_KMZ_SIDE = 8192;

// Draw `mesh` with its positions replaced by `pos` (a y-down plane, x right)
// into a north-up raster whose pixels are px × py units. The pixel size grows
// if needed to stay within `maxSide` and the export limits. Returns
// {bytes, canvas, ow, oh, px, py, minX, minY}: by `output`, bytes is a PNG
// ('png'), or the raw unpremultiplied RGBA pixels, top row first ('rgba'),
// or canvas is a 2D canvas holding the raster ('canvas'). `img` is the
// texture, by default the current image.
//
// Browsers cap a WebGL drawing buffer well below what a large scan needs
// (Chrome at 2^25 pixels), so the raster is drawn in horizontal strips.
// `hide` applies Hide paper with the current image's paper.
async function rasterize(mesh, pos, px, py, maxSide = Infinity, output = 'png', img = state.image.img, hide = 0) {
  const [minX, minY, maxX, maxY] = meshBounds({ pos });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const glOpts = { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: false, alpha: true };
  const gl = canvas.getContext('webgl2', glOpts) || canvas.getContext('webgl', glOpts);
  if (!gl) throw new Error('this needs WebGL.');
  const [maxViewW, maxViewH] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const maxW = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewW);
  maxSide = Math.min(maxSide, MAX_EXPORT_SIDE);

  // Keep roughly the source resolution, within the export limits.
  let ow, oh;
  for (;;) {
    ow = Math.max(1, Math.ceil((maxX - minX) / px));
    oh = Math.max(1, Math.ceil((maxY - minY) / py));
    const shrink = Math.max(1, ow / maxSide, oh / maxSide, ow / maxW, Math.sqrt(ow * oh / MAX_EXPORT_PIXELS));
    if (shrink === 1) break;
    px *= shrink * 1.0001;
    py *= shrink * 1.0001;
  }

  // Find a strip height the browser will actually allocate.
  let sh = Math.max(1, Math.min(oh, maxViewH, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    Math.floor(MAX_STRIP_PIXELS / ow)));
  for (;;) {
    canvas.width = ow;
    canvas.height = sh;
    if (gl.drawingBufferWidth === ow && gl.drawingBufferHeight === sh) break;
    if (sh === 1) throw new Error('the browser could not allocate an image this wide.');
    // Browsers shrink an oversized buffer in both directions; try shorter.
    sh = Math.max(1, Math.min(gl.drawingBufferHeight, Math.floor(sh / 2)));
  }

  const spanX = ow * px;
  const origin = [minX + spanX / 2, minY + oh * py / 2];
  const renderer = new MeshRenderer(gl);
  renderer.setTexture(textureSource(img, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
  if (hide) renderer.setPaper(state.image.paper);
  renderer.setTriangles(meshTriangles({ ...mesh, pos }, origin));
  gl.viewport(0, 0, ow, sh);
  gl.clearColor(0, 0, 0, 0);
  gl.disable(gl.BLEND);

  let out2d = null, ctx = null, rgba = null, strip = null;
  if (output === 'rgba') {
    rgba = new Uint8Array(ow * oh * 4);
    strip = new Uint8Array(ow * sh * 4);
  } else {
    out2d = document.createElement('canvas');
    out2d.width = ow;
    out2d.height = oh;
    ctx = out2d.getContext('2d');
  }
  const row = ow * 4;
  for (let y0 = 0; y0 < oh; y0 += sh) {
    const h = Math.min(sh, oh - y0);
    // This strip's rows, in positions relative to `origin`.
    const centreY = minY + (y0 + sh / 2) * py - origin[1];
    const sy = -2 / (sh * py);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.draw(new Float32Array([2 / spanX, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, -sy * centreY, 0, 1]), 1, hide);
    if (rgba) {
      gl.readPixels(0, 0, ow, sh, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      // GL rows run bottom-up.
      for (let j = 0; j < h; j++) rgba.set(strip.subarray((sh - 1 - j) * row, (sh - j) * row), (y0 + j) * row);
    } else {
      ctx.drawImage(canvas, 0, 0, ow, h, 0, y0, ow, h);
    }
  }
  renderer.destroy();
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  const result = { ow, oh, px, py, minX, minY };
  if (output === 'canvas') return { ...result, canvas: out2d };
  if (output === 'rgba') {
    // The colours are premultiplied.
    for (let k = 0; k < rgba.length; k += 4) {
      const a = rgba[k + 3];
      if (a > 0 && a < 255) {
        rgba[k] = Math.min(255, Math.round(rgba[k] * 255 / a));
        rgba[k + 1] = Math.min(255, Math.round(rgba[k + 1] * 255 / a));
        rgba[k + 2] = Math.min(255, Math.round(rgba[k + 2] * 255 / a));
      }
    }
    return { ...result, bytes: rgba };
  }
  const blob = await new Promise(resolve => out2d.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the browser could not encode the image.');
  return { ...result, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// The export mesh: dense enough for the warp, and for reprojection. A bent
// warp gets cells split where it bends sharply (near a control point moved
// out of line with its neighbours), to stay within a quarter of an output
// pixel everywhere.
function exportMesh(minCells) {
  const { W, H } = state.image;
  if (state.points.length < 3) {
    return buildMesh(state.warp.map, W, H, minCells ? cellsAcross(W, H, minCells) : 1);
  }
  return refinedSoup(state.warp.map, W, H, cellsAcross(W, H, EXPORT_CELLS),
    affineScale(state.warp.S) / 4, state.points.map(p => [p.u, p.v]));
}

// Metadata for an exported raster. `toPixel` maps Mercator units to its
// pixel coordinates.
function exportMetadata(crs, ow, oh, worldFile, bounds, toPixel) {
  const { name, W, H } = state.image;
  return {
    generator: 'rubbersheet',
    version: 1,
    crs,
    width: ow,
    height: oh,
    worldFile,
    bounds,
    source: { name, width: W, height: H },
    controlPoints: state.points.map(p => {
      const ll = toLngLat([p.x, p.y]);
      return {
        pixel: toPixel(p.x, p.y), sourcePixel: [p.u, p.v], lngLat: [ll.lng, ll.lat],
        ...(p.world ? { anchor: 'world' } : {}),
      };
    }),
  };
}

function exportBaseName() {
  return state.image.name.replace(/\.[^.]+$/, '').replace(/-georef$/, '') + '-georef';
}

async function exportImage() {
  if (!state.image) return;
  const mesh = exportMesh(0);
  const r = await rasterize(mesh, mesh.pos, ...Array(2).fill(affineScale(state.warp.S)),
    Infinity, 'png', state.image.img, state.hidePaper);
  const { ow, oh, px: ps, minX, minY } = r;

  // Output pixel (i, j) covers [minX + i*ps, minX + (i+1)*ps) etc.
  const worldFile = affineToWorldFile([ps, 0, minX, 0, ps, minY]);
  const nw = toLngLat([minX, minY]), se = toLngLat([minX + ow * ps, minY + oh * ps]);
  const meta = exportMetadata('EPSG:3857', ow, oh, worldFile, [nw.lng, se.lat, se.lng, nw.lat],
    (x, y) => [(x - minX) / ps, (y - minY) / ps]);
  const bytes = addTextChunk(r.bytes, META_KEY, JSON.stringify(meta));
  const base = exportBaseName();
  download(new Blob([bytes], { type: 'image/png' }), `${base}.png`);
  if ($('worldfile').checked) {
    download(new Blob([worldFile.map(n => n.toPrecision(17)).join('\n') + '\n'], { type: 'text/plain' }), `${base}.pgw`);
    const aux = `<PAMDataset>\n  <SRS>${WKT_3857}</SRS>\n</PAMDataset>\n`;
    download(new Blob([aux], { type: 'application/xml' }), `${base}.png.aux.xml`);
  }
  setStatus(`Exported <b>${escapeHTML(base)}.png</b> (${ow}×${oh}).`);
}

// A Web Mercator GeoTIFF. The rubbersheet metadata goes in ImageDescription.
async function exportGeoTIFF() {
  if (!state.image) return;
  const mesh = exportMesh(0);
  const r = await rasterize(mesh, mesh.pos, ...Array(2).fill(affineScale(state.warp.S)),
    Infinity, 'rgba', state.image.img, state.hidePaper);
  const { ow, oh, px: ps, minX, minY } = r;
  const worldFile = affineToWorldFile([ps, 0, minX, 0, ps, minY]);
  const nw = toLngLat([minX, minY]), se = toLngLat([minX + ow * ps, minY + oh * ps]);
  const meta = exportMetadata('EPSG:3857', ow, oh, worldFile, [nw.lng, se.lat, se.lng, nw.lat],
    (x, y) => [(x - minX) / ps, (y - minY) / ps]);
  const size = ps * EARTH_CIRCUMFERENCE;
  const tiff = await writeGeoTIFF({
    width: ow, height: oh, rgba: r.bytes, epsg: 3857,
    scale: [size, size], origin: mercToMeters(minX, minY),
    description: JSON.stringify(meta).replace(/[^\x20-\x7e]/g,
      ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')),
  });
  const base = exportBaseName();
  download(new Blob([tiff], { type: 'image/tiff' }), `${base}.tif`);
  setStatus(`Exported <b>${escapeHTML(base)}.tif</b> (${ow}×${oh}).`);
}

// Google Earth stretches a GroundOverlay linearly in latitude, so the KMZ
// image is resampled to EPSG:4326 (plate carrée) rather than Mercator.
async function exportKMZ() {
  if (!state.image) return;
  const mesh = exportMesh(DISPLAY_CELLS);
  // Plot longitude right and latitude down (negated), so north is at the top.
  const pos = new Float64Array(mesh.pos.length);
  for (let k = 0; k < pos.length; k += 2) {
    pos[k] = mercXToLng(mesh.pos[k]);
    pos[k + 1] = -mercYToLat(mesh.pos[k + 1]);
  }
  const [, minY, , maxY] = meshBounds({ pos });
  // Same ground resolution as the source, with square pixels at mid-latitude.
  const px = affineScale(state.warp.S) * 360;
  const py = px * Math.cos(-(minY + maxY) / 2 * Math.PI / 180);
  const r = await rasterize(mesh, pos, px, py, MAX_KMZ_SIDE, 'png', state.image.img, state.hidePaper);
  const { ow, oh } = r;
  const west = r.minX, north = -r.minY, east = west + ow * r.px, south = north - oh * r.py;

  const worldFile = [r.px, 0, 0, -r.py, west + r.px / 2, north - r.py / 2];
  const meta = exportMetadata('EPSG:4326', ow, oh, worldFile, [west, south, east, north], (x, y) => {
    const ll = toLngLat([x, y]);
    return [(ll.lng - west) / r.px, (north - ll.lat) / r.py];
  });
  const png = addTextChunk(r.bytes, META_KEY, JSON.stringify(meta));
  const base = exportBaseName();
  const imageName = base.replace(/[^\w.-]+/g, '_') + '.png';
  const wrap = (lng) => (lng < -180 || lng > 180 ? ((lng + 180) % 360 + 360) % 360 - 180 : lng);
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <GroundOverlay>
    <name>${escapeHTML(base)}</name>
    <Icon><href>${imageName}</href></Icon>
    <LatLonBox>
      <north>${north}</north>
      <south>${south}</south>
      <east>${wrap(east)}</east>
      <west>${wrap(west)}</west>
    </LatLonBox>
  </GroundOverlay>
</kml>
`;
  const zip = makeZip([
    { name: 'doc.kml', data: new TextEncoder().encode(kml) },
    { name: imageName, data: png },
  ]);
  download(new Blob([zip], { type: 'application/vnd.google-earth.kmz' }), `${base}.kmz`);
  setStatus(`Exported <b>${escapeHTML(base)}.kmz</b> (${ow}×${oh}).`);
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
  const paper = state.image?.paper;
  $('hide-paper').disabled = !paper;
  $('paper-swatch').style.background = paper ? `rgb(${paper.colour.join(',')})` : 'transparent';
  $('paper-swatch').title = paper ? `Paper colour: rgb(${paper.colour.join(', ')})` : '';
  $('clear').disabled = !state.points.length;
  $('undo').disabled = !has || !edits.undo.length;
  $('redo').disabled = !has || !edits.redo.length;
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

const EXPORTERS = { png: exportImage, tiff: exportGeoTIFF, kmz: exportKMZ };
$('export').addEventListener('click', () => {
  EXPORTERS[$('format').value]().catch(err => {
    console.error(err);
    setStatus(`Export failed: ${escapeHTML(err.message)}`, true);
  });
});
$('format').addEventListener('change', (e) => {
  $('worldfile-row').hidden = e.target.value !== 'png';
});
$('zoom').addEventListener('click', zoomToImage);
$('clear').addEventListener('click', () => {
  checkpoint();
  state.points = [];
  update();
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('remove').addEventListener('click', () => {
  state.image = null;
  state.mesh = null;
  state.fine = null;
  state.points = [];
  resetHistory();
  state.hover = null;
  overlay.innerHTML = '';
  map.getCanvas().style.cursor = '';
  map.triggerRepaint();
  statusBase = '';
  $('status').innerHTML = initialStatus;
  clearImageParam();
  updateUI();
});
$('opacity').addEventListener('input', (e) => {
  state.opacity = Number(e.target.value);
  map.triggerRepaint();
});
$('hide-paper').addEventListener('input', (e) => {
  state.hidePaper = Number(e.target.value);
  map.triggerRepaint();
});
$('basemap').addEventListener('change', (e) => {
  map.setStyle(STYLES[e.target.value], { diff: false });
  // Only the vector street map has separate road layers to lift.
  $('streets-on-top').disabled = e.target.value !== 'streets';
});
$('streets-on-top').addEventListener('change', (e) => {
  state.streetsOnTop = e.target.checked;
  applyStreets();
});

const imageParam = new URLSearchParams(window.location.search).get('image');
if (imageParam) loadURL(imageParam, linkHasView);

// Exposed for debugging and automated tests.
window.rubbersheet = { map, state, update, loadFiles, loadURL, exportImage, exportGeoTIFF, exportKMZ, decodeJPEG, invertDrawn, EASE };
