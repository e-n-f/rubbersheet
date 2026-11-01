import {
  applyAffine, affineScale, affineToWorldFile, buildMesh, invertMesh, makeWarp,
  meshBounds, meshCorners, meshOutline, meshTriangles, mercXToLng, mercYToLat,
  EARTH_CIRCUMFERENCE, mercToMeters, similarityAboutPivot, translateAffine, worldFileToAffine,
  sampleMesh, refineMesh, invertDrawn, refinedSoup,
} from './warp.js';
import { addChunk, addTextChunk, isPNG, readChunk, readTextChunks } from './png-text.js';
import { makeZip, readZip } from './zip.js';
import { isTIFF, readGeoTIFF, readTIFFTags, writeGeoTIFF } from './tiff.js';
import { crsFromGeoKeys } from './proj.js';
import { estimatePaper, paperThresholds } from './paper.js';
import { pickDensity, isolateWeights, isolateGain, blackThresholds, inkDensity, drawColor, toHex, fromHex } from './isolate.js';

const maplibregl = window.maplibregl;
const META_KEY = 'rubbersheet';
// Where an export keeps the unwarped image, when asked to: a private PNG
// chunk (ancillary, private, safe to copy), a private TIFF tag, or a folder
// in a KMZ.
const ORIGINAL_CHUNK = 'rsOr';
const ORIGINAL_TAG = 65123;
const ORIGINAL_DIR = 'unwarped/';
const DISPLAY_CELLS = 64;
const EXPORT_CELLS = 256;
const HIT_RADIUS = 11;
const SLIDE_PX = 3;  // how far a ⌘-click on a point must move to slide it rather than remove it

// ---------------------------------------------------------------------------
// Base maps

const STYLES = {
  streets: 'https://tiles.openfreemap.org/styles/liberty',
  lines: linesStyle(),
  satellite: rasterStyle(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'),
  osm: rasterStyle(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
};

// A plain base map to align old maps against: white land, pale water whose
// edge is the coastline, roads as blue centrelines and railways as dashed
// lines, with their names, and elevation contours in feet, with nothing filled or extruded.
function linesStyle() {
  const font = ['Noto Sans Regular'];
  const roads = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track'];
  const style = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': '#c6dcee' } },
      { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': '#8fb6d8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 1.5] } },
    ],
  };

  // Contours, from the AWS terrain tiles (if the contour library loaded).
  const mlcontour = window.mlcontour;
  if (mlcontour) {
    const dem = new mlcontour.DemSource({
      url: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
      encoding: 'terrarium',
      maxzoom: 13,
      worker: true,
    });
    dem.setupMaplibre(maplibregl);
    style.sources.contours = {
      type: 'vector',
      tiles: [dem.contourProtocolUrl({
        multiplier: 3.28084,  // feet
        thresholds: { 10: [200, 1000], 12: [100, 500], 13: [50, 250], 14: [20, 100], 15: [10, 50] },
        contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level',
      })],
      minzoom: 10,
      maxzoom: 15,
      attribution: 'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen terrain tiles</a>',
    };
    style.layers.push(
      { id: 'contours', type: 'line', source: 'contours', 'source-layer': 'contours',
        filter: ['>', ['get', 'ele'], 0],
        paint: { 'line-color': '#c8a888', 'line-width': ['match', ['get', 'level'], 1, 1, 0.5] } },
      { id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours',
        filter: ['all', ['>', ['get', 'level'], 0], ['>', ['get', 'ele'], 0]],
        layout: { 'symbol-placement': 'line', 'text-size': 10, 'text-font': font,
          'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' ft'] },
        paint: { 'text-color': '#a07850', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  }

  style.layers.push(
    { id: 'lines_road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
      filter: ['match', ['get', 'class'], roads, true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'brunnel'], 'tunnel', '#9fbbe6', '#1458c8'],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 1.5, 0.7],
          16, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 3.5, ['service', 'track'], 1.2, 2.2],
          19, ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 6, ['service', 'track'], 2, 4]],
      } },
    { id: 'lines_rail', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'rail'],
      paint: { 'line-color': '#7a5a8a', 'line-width': 1, 'line-dasharray': [4, 2] } },
    { id: 'street_names', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name',
      filter: ['match', ['get', 'class'], roads, true, false],
      layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 13] },
      paint: { 'text-color': '#222222', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  return style;
}

function rasterStyle(url, attribution) {
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

// ---------------------------------------------------------------------------
// State

// Each image is a layer: {id, image: {name, img, W, H, paper}, url, T (affine
// placement, image px -> Mercator units), points ([{u, v, x, y, world?}],
// image px -> Mercator target), warp ({map, S}), mesh (display mesh), fine
// (finer patch of it over the part in view, refineMesh), origin (GPU rebasing
// origin for the display mesh), opacity, hidePaper (0 for off to 1), gpu (its
// textures and buffers, made when first drawn), texDirty, meshDirty, card
// (its panel entry)}.
const state = {
  layers: [],       // bottom to top
  selected: null,   // the layer whose handles and points are shown
  drag: null,       // carries its layer as drag.layer
  hover: null,
  streetsOnTop: false,
  ease: null,       // a world anchor's release in progress (easeWorldRelease)
  picking: null,    // the layer whose Isolate color is being picked
  pickHide: false,  // and whether it's the color to hide
};

let nextLayerId = 1;

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');

// The map writes its own hash, so note whether the link came with a view.
const linkHasView = !!window.location.hash;

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES.lines,
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
uniform vec4 u_detailRect;  // the detail texture's corner and 1 / size, in a_uv
varying vec2 v_uv;
varying vec2 v_duv;
void main() {
  v_uv = a_uv;
  // Here rather than in the fragment shader, where mediump can be too coarse
  // for texture coordinates across a large image.
  v_duv = (a_uv - u_detailRect.xy) * u_detailRect.zw;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

// Where u_hasDetail is set, the part of the image inside the detail texture
// (setDetail) is drawn from it instead of u_tex.
// With u_hide > 0, the paper (u_paper, a coarse grid of its colour across
// the image) turns transparent: paperToAlpha in paper.js, which has the
// details. With u_iso.y > 0, only one ink shows instead, as ink that
// multiplies the map under it: isolateTransmittance in isolate.js, which
// has the details. Its hue is judged over a 3 x 3 neighbourhood of taps
// ISO_STEP texels apart.
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_paper;
uniform sampler2D u_detail;
uniform float u_hasDetail;
uniform float u_opacity;
uniform vec3 u_hide;  // paperThresholds, or 0 for off
uniform vec2 u_iso;   // isolateGain, or 0 for off
uniform vec3 u_isoW;  // isolateWeights, times the picked density
uniform vec3 u_isoInk;  // the draw color's density, as a share of each
                         // channel (inkDensity), or 0 for off
uniform vec4 u_black;   // blackThresholds
uniform vec2 u_texel;   // the size of a texel of u_tex, in v_uv
uniform vec2 u_dtexel;  // and of u_detail, in v_duv
uniform vec3 u_lens;    // centre and radius, in framebuffer pixels, of the
                        // preview circle
uniform float u_lensSide;  // 1 to draw only inside it, -1 only outside, 0 all
uniform vec4 u_tint;    // the layer's tint, with a = 1 for on
varying vec2 v_uv;
varying vec2 v_duv;
const vec3 EPS = vec3(1.0 / 255.0);
const float ISO_STEP = 1.0;
// The image's density over paper of log colour lp at offset o (in texels)
// from here, and whether there is image there.
vec4 densityAt(vec2 o, float detail, vec3 lp) {
  vec4 s = mix(texture2D(u_tex, v_uv + o * u_texel), texture2D(u_detail, v_duv + o * u_dtexel), detail);
  return s.a > 0.0 ? vec4(lp - log(max(s.rgb / s.a, EPS)), 1.0) : vec4(0.0);
}
void main() {
  // Both sampled, outside any branch, so the mipmap level stays well defined.
  vec4 t = texture2D(u_tex, v_uv);
  vec4 dt = texture2D(u_detail, v_duv);
  vec2 inside = step(0.0, v_duv) * step(v_duv, vec2(1.0));
  float detail = u_hasDetail * inside.x * inside.y;
  t = mix(t, dt, detail);
  // The neighbourhood, sampled outside the branches on t.a and the lens
  // likewise.
  vec3 lp = vec3(0.0);
  vec4 near = vec4(0.0);
  if (u_iso.y > 0.0) {
    lp = log(max(texture2D(u_paper, v_uv).rgb, EPS));
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) near += densityAt(vec2(float(i), float(j)) * ISO_STEP, detail, lp);
    }
  }
  if (u_lensSide != 0.0 && (distance(gl_FragCoord.xy, u_lens.xy) < u_lens.z) != (u_lensSide > 0.0)) discard;
  if (u_iso.y > 0.0) {
    // Isolated, the lines are drawn as ink that multiplies what's under
    // them (with the blend function set to suit): the transmittance of the
    // picked ink's density.
    float ink = 0.0;
    if (t.a > 0.0) {
      vec3 d = lp - log(max(t.rgb / t.a, EPS));
      vec3 n = near.rgb / max(near.a, 1.0);
      float b = dot(u_isoW, n) * max(d.r + d.g + d.b, 0.0) / max(n.r + n.g + n.b, 0.05);
      float fade = (1.0 - clamp((min(min(d.r, d.g), d.b) - u_black.x) / (u_black.y - u_black.x), 0.0, 1.0)) *
        (1.0 - clamp((min(min(n.r, n.g), n.b) - u_black.z) / (u_black.w - u_black.z), 0.0, 1.0));
      ink = max(b - u_iso.x, 0.0) * u_iso.y * fade;
    }
    gl_FragColor = vec4(1.0 - (1.0 - exp(-u_isoInk * ink)) * (t.a * u_opacity), 1.0);
    return;
  } else if (u_hide.y > 0.0 && t.a > 0.0) {
    vec3 c = t.rgb / t.a;
    vec3 p = texture2D(u_paper, v_uv).rgb;
    vec3 dark = (p - c) / max(p, 1e-3);
    vec3 light = (c - p) / max(1.0 - p, 0.5);
    vec3 d = mix(light, dark, step(c, p));
    float need = min(max(max(d.r, d.g), d.b), 1.0);
    float a = max(u_hide.z, clamp((need - u_hide.x) / (u_hide.y - u_hide.x), 0.0, 1.0));
    float div = max(a, need);
    vec3 col = div > 0.0 ? clamp(p + (c - p) / div, 0.0, 1.0) : p;
    t = vec4(col, 1.0) * (a * t.a);
  }
  if (u_tint.a > 0.0 && t.a > 0.0) {
    // Tinted, the image's darkness, measured from its paper, is drawn in the
    // tint: the paper stays light and the ink takes the tint's color.
    const vec3 LUM = vec3(0.299, 0.587, 0.114);
    float paper = dot(texture2D(u_paper, v_uv).rgb, LUM);
    float dark = clamp(1.0 - dot(t.rgb / t.a, LUM) / max(paper, 0.05), 0.0, 1.0);
    t = vec4(1.0 - dark * (1.0 - u_tint.rgb), 1.0) * t.a;
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

// One shader program, drawing any number of meshes. Each mesh's textures
// and buffers are a separate object, from create().
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
    this.uIso = gl.getUniformLocation(p, 'u_iso');
    this.uIsoW = gl.getUniformLocation(p, 'u_isoW');
    this.uIsoInk = gl.getUniformLocation(p, 'u_isoInk');
    this.uBlack = gl.getUniformLocation(p, 'u_black');
    this.uTexel = gl.getUniformLocation(p, 'u_texel');
    this.uDTexel = gl.getUniformLocation(p, 'u_dtexel');
    this.uLens = gl.getUniformLocation(p, 'u_lens');
    this.uLensSide = gl.getUniformLocation(p, 'u_lensSide');
    this.uTint = gl.getUniformLocation(p, 'u_tint');
    this.uDetail = gl.getUniformLocation(p, 'u_detail');
    this.uDetailRect = gl.getUniformLocation(p, 'u_detailRect');
    this.uHasDetail = gl.getUniformLocation(p, 'u_hasDetail');
  }

  create() {
    const gl = this.gl;
    return { tex: null, paperTex: null, detailTex: null, detailRect: null, posBuf: gl.createBuffer(), uvBuf: gl.createBuffer(), count: 0 };
  }

  // Mipmaps (with anisotropic filtering) only if `mip`: they blur an image
  // drawn at about its own size, where the GPU's estimate of the scale can
  // pick a smaller level, as it can for a rotated image.
  setTexture(m, source, mip = true) {
    const gl = this.gl;
    m.texel = [1 / (source.naturalWidth || source.width), 1 / (source.naturalHeight || source.height)];
    if (m.tex) gl.deleteTexture(m.tex);
    m.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const pot = (n) => (n & (n - 1)) === 0;
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    mip &&= isGL2 || (pot(source.width) && pot(source.height));
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
  setPaper(m, paper) {
    const gl = this.gl;
    if (m.paperTex) gl.deleteTexture(m.paperTex);
    m.paperTex = null;
    if (!paper) return;
    m.paperTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, m.paperTex);
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

  // A sharper texture for part of the image, drawn in place of the main one
  // there: `detail` is {source, rect: [u0, v0, u1, v1]} (texture coordinates
  // of the whole image), or null for none. No mipmaps: it is made at about
  // the screen's resolution.
  setDetail(m, detail) {
    const gl = this.gl;
    if (m.detailTex) gl.deleteTexture(m.detailTex);
    m.detailTex = null;
    m.detailRect = null;
    if (!detail) return;
    m.detailTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, m.detailTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, detail.source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    const [u0, v0, u1, v1] = detail.rect;
    m.detailRect = [u0, v0, 1 / (u1 - u0), 1 / (v1 - v0)];
    m.dtexel = [1 / detail.source.width, 1 / detail.source.height];
  }

  setTriangles(m, { positions, uvs, count }) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.DYNAMIC_DRAW);
    m.count = count;
  }

  // `hide` is the Hide paper amount, 0 for off; `iso` is the Isolate color
  // settings, {amount, w, color}, or null for off, and `lens` the circle
  // [x, y, r] in framebuffer pixels to isolate within, or null for all.
  // `tint` is the layer's tint color, RGB 0..1, or null for none; outside
  // the lens, the image shows untinted.
  draw(m, matrix, opacity, hide = 0, iso = null, lens = null, tint = null) {
    if (!m.tex || !m.count) return;
    const isoOn = iso && iso.amount > 0 && iso.w && m.paperTex;
    if (!isoOn) {
      this.pass(m, matrix, opacity, hide, null, null, 0, lens ? null : tint);
    } else if (lens) {
      this.pass(m, matrix, opacity, hide, null, lens, -1, null);
      this.pass(m, matrix, opacity, hide, iso, lens, 1, tint);
    } else {
      this.pass(m, matrix, opacity, hide, iso, null, 0, tint);
    }
  }

  // One drawing of the mesh: isolated if `iso`, within or outside `lens` by
  // `side` (as u_lensSide), and tinted if `tint`.
  pass(m, matrix, opacity, hide, iso, lens, side, tint) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform1f(this.uOpacity, opacity);
    gl.uniform1i(this.uTex, 0);
    gl.uniform1i(this.uPaper, 1);
    gl.uniform1i(this.uDetail, 2);
    gl.uniform1f(this.uHasDetail, m.detailTex ? 1 : 0);
    gl.uniform4fv(this.uDetailRect, m.detailRect || [0, 0, 1, 1]);
    gl.uniform3fv(this.uHide, hide > 0 && m.paperTex ? paperThresholds(hide) : [0, 0, 0]);
    gl.uniform2fv(this.uIso, iso ? isolateGain(iso.amount) : [0, 0]);
    const scale = iso ? iso.showD.reduce((a, b) => a + b) : 0;
    gl.uniform3fv(this.uIsoW, iso ? iso.w.map(x => x * scale) : [0, 0, 0]);
    gl.uniform3fv(this.uIsoInk, iso ? inkDensity(tint || iso.color) : [0, 0, 0]);
    gl.uniform4fv(this.uTint, tint && !iso ? [...tint, 1] : [0, 0, 0, 0]);
    gl.uniform4fv(this.uBlack, iso ? blackThresholds(iso.showD) : [0, 1, 0, 1]);
    gl.uniform2fv(this.uTexel, m.texel || [0, 0]);
    gl.uniform2fv(this.uDTexel, m.detailTex && m.dtexel ? m.dtexel : [0, 0]);
    gl.uniform3fv(this.uLens, lens || [0, 0, 0]);
    gl.uniform1f(this.uLensSide, side);
    // Isolated ink multiplies what's under it; otherwise premultiplied over.
    if (iso) gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
    // The paper texture's unit is bound even when unused: an unbound sampler
    // reads black, but the map's own textures could be sitting there.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, m.paperTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, m.detailTex || m.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.uvBuf);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
    if (iso) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  free(m) {
    const gl = this.gl;
    if (m.tex) gl.deleteTexture(m.tex);
    if (m.paperTex) gl.deleteTexture(m.paperTex);
    if (m.detailTex) gl.deleteTexture(m.detailTex);
    gl.deleteBuffer(m.posBuf);
    gl.deleteBuffer(m.uvBuf);
  }

  destroy() {
    this.gl.deleteProgram(this.program);
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

// All the image layers, drawn bottom to top in one custom map layer, so that
// the base map is under them all and the raised streets over them all.
const imageLayer = {
  id: 'rubbersheet-image',
  type: 'custom',
  renderingMode: '2d',
  onAdd(_map, gl) {
    this.renderer = new MeshRenderer(gl);
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // Resources from before went with the old layer (and a removed layer's
    // were freed when it was removed).
    for (const L of state.layers) L.gpu = null;
  },
  onRemove() {
    for (const L of state.layers) freeGPU(L);
    this.renderer.destroy();
    this.renderer = null;
  },
  render(gl, matrix) {
    const r = this.renderer;
    if (!r || !state.layers.length) return;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const L of state.layers) {
      if (!L.mesh) continue;
      if (!L.gpu) {
        L.gpu = r.create();
        L.texDirty = L.meshDirty = true;
      }
      if (L.texDirty) {
        const source = textureSource(L.image.img, Math.min(DISPLAY_TEXTURE, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
        L.texScale = (source.naturalWidth || source.width) / L.image.W;
        r.setTexture(L.gpu, source);
        r.setPaper(L.gpu, L.image.paper);
        L.texDirty = false;
      }
      if (L.meshDirty) {
        r.setTriangles(L.gpu, meshTriangles(L.mesh, L.origin, L.fine));
        L.meshDirty = false;
        // The detail is a piece of the source, so it stays right wherever
        // the image is drawn; it may just no longer cover the view.
        scheduleDetail();
      }
      if (L.gpu.detailFor !== L.detail) {
        r.setDetail(L.gpu, L.detail);
        L.gpu.detailFor = L.detail;
      }
      // Half see-through while dragging, except when the streets on top are
      // what moves, or a point is sliding across the image (which stays put).
      const d = state.drag;
      const see = d && d.layer === L && !['world', 'slide'].includes(d.kind);
      const opacity = see ? Math.min(0.5, L.opacity) : L.opacity;
      // While picking, the image shows as it is, but for a preview of the
      // pick around the pointer.
      const picking = state.picking === L;
      r.draw(L.gpu, rebaseMatrix(matrix, L.origin[0], L.origin[1]), opacity, L.hidePaper,
        picking ? L.preview : L.isolate, picking ? lensCircle() : null, L.tint.on ? L.tint.color : null);
    }
  },
};

// ---------------------------------------------------------------------------
// Detail: the display texture is at most DISPLAY_TEXTURE pixels a side, so a
// larger image is drawn from a shrunk copy. Once nothing has changed for
// DETAIL_IDLE_MS, each image gets a second texture, cut from the source at
// the screen's resolution (device pixels, not CSS pixels) for the part in
// view and a margin around it, and is drawn from that wherever it reaches. Being a piece of the source, it
// stays right however the map moves or the image bends; it is only replaced
// when the view outgrows it or needs finer detail, and dropped when zooming
// out leaves it much finer than the screen. It also stands in for the
// mipmaps of an image drawn at about its own size, which blur it.

const DISPLAY_TEXTURE = 4096;
const DETAIL_IDLE_MS = 500;
// Pixels for one layer's detail, and for all of them together: with
// several large layers in view, each gets an even share.
const DETAIL_MAX_PIXELS = 12e6;
const DETAIL_TOTAL_PIXELS = 24e6;
// The margins tried, as fractions of the view's width and height on each
// side, widest first: the widest that fits the layer's pixels at full
// resolution is used. A detail is kept while it covers the view and
// DETAIL_KEEP of this margin.
const DETAIL_MARGINS = [0.5, 0.25, 0];
const DETAIL_KEEP = 0.25;
let detailTimer = 0;

function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(makeDetails, DETAIL_IDLE_MS);
}

function makeDetails() {
  if (state.drag || state.ease || map.isMoving()) {
    scheduleDetail();
    return;
  }
  const maxSize = Math.min(8192, imageLayer.maxTexture || 4096);
  let changed = false;
  const ready = state.layers.filter(L => L.mesh && L.gpu && !L.meshDirty && L.texScale);
  // An invisible layer, or one out of view, needs none.
  const shown = ready.filter(L => L.opacity > 0 && meshInView(L.mesh));
  for (const L of ready) {
    if (shown.includes(L)) continue;
    if (L.detail) changed = true;
    L.detail = null;
  }
  const maxPixels = Math.min(DETAIL_MAX_PIXELS, DETAIL_TOTAL_PIXELS / Math.max(1, shown.length));
  for (const L of shown) {
    const detail = detailFor(L, maxSize, maxPixels);
    if (detail !== L.detail) changed = true;
    L.detail = detail;
  }
  if (changed) map.triggerRepaint();
}

// Zoomed out to where the detail is minified more than twice over, it
// would shimmer without mipmaps: the display texture does better there.
map.on('zoom', () => {
  const z = map.getZoom();
  for (const L of state.layers) {
    if (L.detail && L.detail.s > 2 * L.detail.screenScale * 2 ** (z - L.detail.zoom)) {
      L.detail = null;
      map.triggerRepaint();
    }
  }
});
map.on('resize', scheduleDetail);

// L's detail for the current view: its current one if that still serves,
// a new crop of the source, or null if the display texture already has as
// much detail.
function meshInView(mesh) {
  const canvas = map.getCanvas();
  const [minX, minY, maxX, maxY] = meshBounds(mesh);
  const pts = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(mercToScreen);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return Math.max(...xs) >= 0 && Math.min(...xs) <= canvas.clientWidth &&
    Math.max(...ys) >= 0 && Math.min(...ys) <= canvas.clientHeight;
}

function detailFor(L, maxSize, maxPixels) {
  const { W, H, img } = L.image;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpr = canvas.width / Math.max(1, w);
  const A = mercToScreenAffine();
  const { positions, uvs, count } = meshTriangles(L.mesh, L.origin, L.fine);
  const [ox, oy] = L.origin;
  // Source pixel bounds of the view with each margin, and with DETAIL_KEEP
  // of each.
  const margins = [...DETAIL_MARGINS, ...DETAIL_MARGINS.map(m => m * DETAIL_KEEP)];
  const bounds = margins.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  const views = margins.map(m => [-m * w, -m * h, (1 + m) * w, (1 + m) * h]);
  const [vx0, vy0, vx1, vy1] = views[0];
  let scale = 0;
  const sx = new Float64Array(3), sy = new Float64Array(3);
  for (let t = 0; t < count; t += 3) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = positions[(t + k) * 2] + ox, y = positions[(t + k) * 2 + 1] + oy;
      sx[k] = A[0] * x + A[1] * y + A[2];
      sy[k] = A[3] * x + A[4] * y + A[5];
      minX = Math.min(minX, sx[k]); maxX = Math.max(maxX, sx[k]);
      minY = Math.min(minY, sy[k]); maxY = Math.max(maxY, sy[k]);
    }
    if (maxX < vx0 || minX > vx1 || maxY < vy0 || minY > vy1) continue;
    const i = t * 2;
    const pu = [uvs[i] * W, uvs[i + 2] * W, uvs[i + 4] * W];
    const pv = [uvs[i + 1] * H, uvs[i + 3] * H, uvs[i + 5] * H];
    const tri = [0, 1, 2].map(k => [sx[k], sy[k], pu[k], pv[k]]);
    // Only the part in each view: a single triangle can cover far more.
    margins.forEach((m, n) => {
      const b = bounds[n], [x0, y0, x1, y1] = views[n];
      if (maxX < x0 || minX > x1 || maxY < y0 || minY > y1) return;
      const whole = minX >= x0 && maxX <= x1 && minY >= y0 && maxY <= y1;
      for (const [, , u, v] of whole ? tri : clipToView(tri, views[n])) {
        b[0] = Math.min(b[0], u); b[1] = Math.min(b[1], v);
        b[2] = Math.max(b[2], u); b[3] = Math.max(b[3], v);
      }
    });
    if (maxX < 0 || minX > w || maxY < 0 || minY > h) continue;
    // The triangle's screen pixels per source pixel, at its most stretched,
    // over the view itself.
    const du1 = pu[1] - pu[0], dv1 = pv[1] - pv[0], du2 = pu[2] - pu[0], dv2 = pv[2] - pv[0];
    const det = du1 * dv2 - du2 * dv1;
    if (!det) continue;
    const ex1 = sx[1] - sx[0], ey1 = sy[1] - sy[0], ex2 = sx[2] - sx[0], ey2 = sy[2] - sy[0];
    const a = (ex1 * dv2 - ex2 * dv1) / det, b = (ex2 * du1 - ex1 * du2) / det;
    const c = (ey1 * dv2 - ey2 * dv1) / det, d = (ey2 * du1 - ey1 * du2) / det;
    const q = (a * a + b * b + c * c + d * d) / 2;
    const r = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 / 4 + (a * c + b * d) ** 2);
    scale = Math.max(scale, Math.sqrt(q + r));
  }
  // Whole source pixels, with one to spare for the bilinear filter.
  const crop = ([u0, v0, u1, v1]) => u1 > u0 && v1 > v0 ? [
    Math.max(0, Math.floor(u0) - 1), Math.max(0, Math.floor(v0) - 1),
    Math.min(W, Math.ceil(u1) + 1), Math.min(H, Math.ceil(v1) + 1)] : null;
  const fit = ([u0, v0, u1, v1]) => {
    const cw = u1 - u0, ch = v1 - v0;
    return Math.min(1, maxSize / cw, maxSize / ch, Math.sqrt(maxPixels / (cw * ch)));
  };
  const inView = crop(bounds[DETAIL_MARGINS.length - 1]);
  if (!inView || !scale) return null;
  const want = Math.min(1, scale * dpr);
  // At the display texture's own scale or coarser there's nothing to gain,
  // unless it's being drawn from blurry mipmaps.
  const useful = (s) => !(s <= L.texScale / 2 || (L.texScale >= 1 && s >= 1));
  if (!useful(Math.min(want, fit(inView)))) return null;

  // Keep the current detail if it is fine enough and covers enough.
  const old = L.detail;
  const contains = (r, b) => b && r[0] <= b[0] && r[1] <= b[1] && r[2] >= b[2] && r[3] >= b[3];
  if (old) {
    const keep = crop(bounds[DETAIL_MARGINS.length + old.margin]);
    const pixels = old.source.width * old.source.height;
    if (old.s >= Math.min(want, fit(inView)) * 0.95 && old.s <= 2 * want && contains(old.px, keep) &&
      pixels <= maxPixels * 1.01) return old;
  }

  // The widest margin that fits at the resolution wanted, or else the view
  // alone as fine as it fits.
  let n = DETAIL_MARGINS.findIndex((m, k) => { const c = crop(bounds[k]); return c && fit(c) >= want; });
  if (n < 0) n = DETAIL_MARGINS.length - 1;
  const px = crop(bounds[n]);
  const [u0, v0, u1, v1] = px;
  const cw = u1 - u0, ch = v1 - v0;
  const s = Math.min(want, fit(px));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * s));
  c.height = Math.max(1, Math.round(ch * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, u0, v0, cw, ch, 0, 0, c.width, c.height);
  return {
    source: c, rect: [u0 / W, v0 / H, u1 / W, v1 / H], px, s, margin: n,
    screenScale: scale * dpr, zoom: map.getZoom(),
  };
}

// A polygon of [x, y, u, v] clipped to the screen rectangle [x0, y0, x1, y1],
// with u and v interpolated along with x and y.
function clipToView(poly, [x0, y0, x1, y1]) {
  const edges = [[0, 1, x0], [0, -1, x1], [1, 1, y0], [1, -1, y1]];  // [axis, sign, bound]
  for (const [axis, sign, bound] of edges) {
    const inside = (p) => sign * (p[axis] - bound) >= 0;
    const out = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const f = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push(a.map((x, n) => x + (b[n] - x) * f));
      }
    }
    poly = out;
    if (!poly.length) break;
  }
  return poly;
}

function freeGPU(L) {
  if (L.gpu && imageLayer.renderer) imageLayer.renderer.free(L.gpu);
  L.gpu = null;
}

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

function update(L) {
  if (!L) return;
  const { W, H } = L.image;
  if (L.points.length === 1) {
    // A single image anchor just rides along with the placement; a single
    // world anchor moves the placement to keep its spot on its place.
    const p = L.points[0];
    L.T = placementFor(L.T, p);
    if (!p.world) [p.x, p.y] = applyAffine(L.T, p.u, p.v);
  }
  L.warp = makeWarp(L.T, L.points);
  // Keep the placement in sync, so that removing points back down to one or
  // zero leaves the image where it is.
  if (L.points.length >= 2) L.T = L.warp.S;
  const bent = L.points.length >= 3;
  L.mesh = buildMesh(L.warp.map, W, H, bent ? cellsAcross(W, H, DISPLAY_CELLS) : 1);
  L.fine = refineView(L, L.mesh);
  const [minX, minY, maxX, maxY] = meshBounds(L.mesh);
  L.origin = [(minX + maxX) / 2, (minY + maxY) / 2];
  L.meshDirty = true;
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

function refineView(L, mesh) {
  if (!mesh || mesh.nx < 2 || !L.warp) return null;
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
  return refineMesh(L.warp.map, mesh, i0, j0, i1, j1, s);
}

map.on('moveend', () => {
  scheduleDetail();
  if (state.drag || state.ease) return;
  for (const L of state.layers) {
    if (!L.mesh) continue;
    L.fine = refineView(L, L.mesh);
    L.meshDirty = true;
  }
  map.triggerRepaint();
});

// Columns for a grid whose longer side has `cells` cells.
function cellsAcross(W, H, cells) {
  return W >= H ? cells : Math.max(1, Math.round(cells * W / H));
}

// ---------------------------------------------------------------------------
// Undo and redo: one history for all the layers. A snapshot, taken before
// each edit, holds the list of layers (so adding, removing and reordering
// them can be undone) and, for an edit to one layer, its placement and
// points.

const MAX_UNDO = 50;
const edits = { undo: [], redo: [] };

function snapshot(L = null) {
  return {
    order: state.layers.slice(),
    selected: state.selected,
    edit: L && { layer: L, T: L.T.slice(), points: L.points.map(p => ({ ...p })) },
  };
}

function restore(snap) {
  setLayers(snap.order);
  if (snap.edit) {
    const { layer: L, T, points } = snap.edit;
    L.T = T.slice();
    L.points = points.map(p => ({ ...p }));
    update(L);
    select(L);
  } else {
    select(state.layers.includes(snap.selected) ? snap.selected : null);
  }
}

function sameAsNow(snap) {
  const e = snap.edit;
  if (!e) return false;
  const L = e.layer;
  return e.T.every((v, i) => v === L.T[i]) &&
    e.points.length === L.points.length &&
    e.points.every((p, i) => ['u', 'v', 'x', 'y'].every(k => p[k] === L.points[i][k]));
}

// Call before an edit, to layer L or (with none) to the list of layers.
// Returns a token for settle().
function checkpoint(L = null) {
  const token = { redo: edits.redo };
  edits.undo.push(snapshot(L));
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
  const snap = edits.undo.pop();
  edits.redo.push(snapshot(snap.edit?.layer));
  restore(snap);
}

function redo() {
  if (state.drag || state.ease || !edits.redo.length) return;
  const snap = edits.redo.pop();
  edits.undo.push(snapshot(snap.edit?.layer));
  restore(snap);
}

// ---------------------------------------------------------------------------
// Overlay: outline, corner handles, control points

// The other layers get a faint outline, the selected one its full outline,
// its corner handles while it has no points, and its points.
function drawOverlay() {
  const L = state.selected;
  const parts = [];
  const outline = (layer, cls) => {
    const pts = meshOutline(layer.mesh).map(mercToScreen);
    parts.push(`<polygon class="${cls}" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
  };
  for (const other of state.layers) if (other !== L && other.mesh) outline(other, 'outline other');
  if (state.picking && state.picking.preview && lastPointer) {
    parts.push(`<circle class="lens" cx="${lastPointer[0]}" cy="${lastPointer[1]}" r="${LENS_RADIUS}"/>`);
  }
  if (!L || !L.mesh) {
    overlay.innerHTML = parts.join('');
    return;
  }
  outline(L, 'outline');
  const hovered = (kind, i) => state.hover && state.hover.kind === kind && state.hover.index === i;
  if (imageDraggable(L) && (!state.drag || state.drag.kind === 'corner')) {
    meshCorners(L.mesh).map(mercToScreen).forEach(([x, y], i) => {
      parts.push(`<rect class="handle${hovered('corner', i) ? ' hover' : ''}" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`);
    });
  }
  const d = state.drag;
  if (d && d.kind === 'world' && d.preview) {
    parts.push(`<path class="bent-streets" d="${polylinePath(bentStreets(d))}"/>`);
  } else if (state.ease) {
    parts.push(`<path class="bent-streets" d="${easedStreetsPath(state.ease)}"/>`);
  }
  L.points.forEach((p, i) => {
    const active = d && ['point', 'world', 'slide'].includes(d.kind) && d.index === i;
    // A world anchor being dragged rides on its bent street, at the pointer.
    const easing = state.ease && state.ease.index === i;
    const [x, y] = active && d.kind === 'world' && d.cursor ? d.cursor
      : easing ? state.ease.cursor : mercToScreen([p.x, p.y]);
    // World anchors are squares, image anchors circles.
    const ring = p.world ? '<rect class="ring" x="-6.5" y="-6.5" width="13" height="13"/>' : '<circle class="ring" r="7"/>';
    parts.push(`<g class="cp${p.world ? ' world' : ''}${active ? ' active' : ''}${hovered('point', i) ? ' hover' : ''}" ` +
      `transform="translate(${x},${y})">${ring}` +
      `<line x1="-4" y1="0" x2="4" y2="0"/><line x1="0" y1="-4" x2="0" y2="4"/>` +
      `<text x="10" y="-8">${i + 1}</text></g>`);
  });
  overlay.innerHTML = parts.join('');
}

map.on('render', drawOverlay);

// ---------------------------------------------------------------------------
// Hit testing and pointer interaction

// The selected layer's points and corners come first. Then the image under
// the pointer: the selected one if it's there, so that it can be worked on
// through a layer above it, otherwise the topmost.
function hitTest(p) {
  const near = (q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= HIT_RADIUS;
  const S = state.selected;
  if (S && S.mesh) {
    for (let i = S.points.length - 1; i >= 0; i--) {
      if (near(mercToScreen([S.points[i].x, S.points[i].y]))) return { kind: 'point', index: i, layer: S };
    }
    if (imageDraggable(S)) {
      const corners = meshCorners(S.mesh);
      for (let i = 0; i < 4; i++) {
        if (near(mercToScreen(corners[i]))) return { kind: 'corner', index: i, layer: S };
      }
    }
  }
  const m = screenToMerc(p);
  const order = state.layers.slice().reverse();
  if (S) order.unshift(S);
  for (const L of order) {
    if (!L.mesh) continue;
    const uv = invertDrawn(L.mesh, L.fine, m[0], m[1]);
    if (uv) return { kind: 'image', uv, merc: m, layer: L };
  }
  return null;
}

function cornerUV(L, i) {
  const { W, H } = L.image;
  return [[0, 0], [W, 0], [W, H], [0, H]][i];
}

const isCommand = (e) => e.metaKey || e.ctrlKey;

function cursorFor(hit, cmd) {
  if (state.picking) return 'crosshair';
  if (!hit) return '';
  if (hit.layer !== state.selected) return 'pointer';
  if (hit.kind === 'point') return cmd ? 'move' : 'grab';
  if (cmd) return 'copy';
  if (hit.kind === 'corner') return hit.index % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
  return imageMovable(hit.layer) ? 'move' : '';
}

// Once an image is pinned by a control point, its corner handles go away and
// dragging its background pans the map instead of moving the image.
const imageDraggable = (L) => L.points.length === 0;

// Dragging the image's background moves it only while a corner handle is in
// view; zoomed in past all four, it pans the map instead.
function imageMovable(L) {
  if (!imageDraggable(L) || !L.mesh) return false;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const box = map.getContainer().getBoundingClientRect();
  const pr = $('panel').getBoundingClientRect();
  return meshCorners(L.mesh).map(mercToScreen).some(([x, y]) =>
    x >= 0 && x <= w && y >= 0 && y <= h &&
    !(x + box.left >= pr.left && x + box.left <= pr.right && y + box.top >= pr.top && y + box.top <= pr.bottom));
}

let lastPointer = null;
let swallowing = false;

function setHover(hit, cmd) {
  const key = (h) => h ? `${h.layer.id}:${h.kind}${h.index ?? ''}` : '';
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
  if (state.picking) {
    e.preventDefault();
    e.stopPropagation();
    swallowing = true;
    pickIsolate(state.picking, p, state.pickHide);
    return;
  }
  const hit = hitTest(p);
  if (!hit) return;
  const L = hit.layer;
  // Clicking another image selects it, and goes on to act on it.
  if (L !== state.selected) select(L);
  if (hit.kind === 'image' && !isCommand(e) && !imageMovable(L)) return;
  // Keep MapLibre from starting a pan/rotate for this gesture.
  e.preventDefault();
  e.stopPropagation();
  swallowing = true;

  // World anchors: dragging one bends the streets, not the image, and
  // ⌘-clicking the image with the streets on top adds one (and drags it).
  const grabWorld = hit.kind === 'point' && !isCommand(e) && L.points[hit.index].world;
  const addWorld = isCommand(e) && hit.kind === 'image' && streetsRaised();
  if (grabWorld || addWorld) {
    const token = checkpoint(L);
    let index = hit.index, offset = [0, 0];
    if (addWorld) {
      L.points.push({ u: hit.uv[0], v: hit.uv[1], x: hit.merc[0], y: hit.merc[1], world: true });
      index = L.points.length - 1;
      update(L);
    } else {
      const q = L.points[index];
      const [sx, sy] = mercToScreen([q.x, q.y]);
      offset = [sx - p[0], sy - p[1]];
    }
    state.drag = startWorldDrag(L, index, token, offset);
    document.body.classList.add('dragging');
    map.getCanvas().style.cursor = 'grabbing';
    hideStreets(true);
    drawOverlay();
    return;
  }

  // ⌘-dragging a point slides it: the image spot and the map place move
  // together, so the image stays where it is. A ⌘-click without a drag
  // removes the point (in endDrag).
  if (isCommand(e) && hit.kind === 'point') {
    const q = L.points[hit.index];
    const [sx, sy] = mercToScreen([q.x, q.y]);
    state.drag = {
      layer: L,
      token: checkpoint(L),
      kind: 'slide',
      index: hit.index,
      p0: p,
      offset: [sx - p[0], sy - p[1]],
      moved: false,
      mesh: L.mesh,
      fine: L.fine,
      pts0: L.points.map(q => ({ ...q })),
      T0: L.T.slice(),
    };
    document.body.classList.add('dragging');
    map.getCanvas().style.cursor = 'grabbing';
    drawOverlay();
    return;
  }

  if (isCommand(e)) {
    checkpoint(L);
    const uv = hit.kind === 'corner' ? cornerUV(L, hit.index) : hit.uv;
    const target = hit.kind === 'corner' ? L.warp.map(uv[0], uv[1]) : hit.merc;
    L.points.push({ u: uv[0], v: uv[1], x: target[0], y: target[1] });
    state.hover = null;
    update(L);
    return;
  }

  const m0 = screenToMerc(p);
  const drag = {
    layer: L,
    token: checkpoint(L),
    kind: hit.kind,
    index: hit.index,
    m0,
    T0: L.T.slice(),
    pts0: L.points.map(q => ({ ...q })),
  };
  if (hit.kind === 'point') {
    const q = L.points[hit.index];
    drag.offset = [q.x - m0[0], q.y - m0[1]];
  } else if (hit.kind === 'corner') {
    const { W, H } = L.image;
    drag.pivot = L.warp.map(W / 2, H / 2);
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
  if (state.picking) previewPick();
});

window.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d || !e.isPrimary) return;
  const L = d.layer;
  lastPointer = localPoint(e);
  const m = screenToMerc(lastPointer);
  if (d.kind === 'world') {
    worldStep(d, [lastPointer[0] + d.offset[0], lastPointer[1] + d.offset[1]]);
    return;
  }
  if (d.kind === 'slide') {
    if (!d.moved && Math.hypot(lastPointer[0] - d.p0[0], lastPointer[1] - d.p0[1]) < SLIDE_PX) return;
    d.moved = true;
    // The point goes to the map place under it, and to the image spot drawn
    // there when the drag began.
    const target = screenToMerc([lastPointer[0] + d.offset[0], lastPointer[1] + d.offset[1]]);
    const uv = invertDrawn(d.mesh, d.fine, target[0], target[1]);
    if (!uv) return;  // Off the image: stay at the last spot on it.
    L.points = d.pts0.map(q => ({ ...q }));
    Object.assign(L.points[d.index], { u: uv[0], v: uv[1], x: target[0], y: target[1] });
    update(L);
    return;
  }
  const dx = m[0] - d.m0[0], dy = m[1] - d.m0[1];

  if (d.kind === 'image') {
    L.T = translateAffine(d.T0, dx, dy);
    L.points = d.pts0.map(q => ({ ...q, x: q.x + dx, y: q.y + dy }));
  } else if (d.kind === 'point') {
    const nx = m[0] + d.offset[0], ny = m[1] + d.offset[1];
    if (L.points.length === 1) {
      const q = d.pts0[0];
      L.T = translateAffine(d.T0, nx - q.x, ny - q.y);
    }
    L.points = d.pts0.map(q => ({ ...q }));
    L.points[d.index].x = nx;
    L.points[d.index].y = ny;
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
    L.T = similarityAboutPivot(d.T0, d.pivot, kr, ki);
    L.points = d.pts0.map(q => {
      const rx = q.x - px, ry = q.y - py;
      return { ...q, x: px + kr * rx - ki * ry, y: py + ki * rx + kr * ry };
    });
  }
  update(L);
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

function startWorldDrag(L, index, token, offset) {
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
    kind: 'world', layer: L, index, token, offset,
    T0: L.T.slice(),
    pts0: L.points.map(q => ({ ...q })),
    mesh: L.mesh,
    fine: L.fine,
    A, nx, ny,
    under: sampleDrawn(L, A, nx, ny),
    streets,
    preview: null,
    cursor: null,
  };
}

// The image pixel under each grid node, as drawn: the fine patch where it
// covers, the coarse mesh elsewhere.
function sampleDrawn(L, A, nx, ny) {
  const under = sampleMesh(L.mesh, A, nx, ny, PREVIEW_STEP);
  const f = L.fine;
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
  const L = d.layer;
  const q = L.points[d.index];
  const [sx, sy] = mercToScreen([q.x, q.y]);
  const [cx, cy] = d.preview.cursor;
  const dx = sx - cx, dy = sy - cy;
  if (!dx && !dy) return false;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth / 2, h = canvas.clientHeight / 2;
  const from = d.mesh, to = L.mesh, fineFrom = d.fine;
  const same = (a, b) => a.nx === b.nx && a.ny === b.ny;
  // The new warp's fine patch over the same cells as the old, to blend.
  const fineTo = fineFrom && same(from, to)
    ? refineMesh(L.warp.map, to, fineFrom.i0, fineFrom.j0, fineFrom.i1, fineFrom.j1, fineFrom.s)
    : L.fine;
  const ease = {
    layer: L, index: d.index, cursor: [cx, cy], dx, dy, e: 0,
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
    if (ease.blend) L.mesh = { ...to, pos: lerp(from.pos, to.pos, e) };
    L.fine = ease.blendFine ? { ...fineTo, mesh: { ...fineTo.mesh, pos: lerp(fineFrom.mesh.pos, fineTo.mesh.pos, e) } }
      : ease.blend ? null : fineTo;
    L.meshDirty = true;
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
    L.mesh = to;
    L.fine = refineView(L, to);
    L.meshDirty = true;
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

// `released`: the pointer was let go (rather than the window losing focus).
function endDrag(cancel, released = false) {
  const d = state.drag;
  swallowing = false;
  if (!d) return;
  const L = d.layer;
  // A ⌘-click on a point, not dragged, removes it.
  if (d.kind === 'slide' && !d.moved && !cancel && released) L.points.splice(d.index, 1);
  if (d.kind === 'world') {
    hideStreets(false);
    // The image spot under the pointer goes to the anchor's place.
    if (!cancel && d.preview) L.points = d.preview.pts;
  }
  if (cancel) {
    L.T = d.T0;
    L.points = d.pts0;
  }
  settle(d.token, cancel);
  state.drag = null;
  document.body.classList.remove('dragging');
  update(L);
  if (d.kind === 'world' && !cancel && d.preview) easeWorldRelease(d);
  if (lastPointer) setHover(hitTest(lastPointer), false);
}

window.addEventListener('pointerup', (e) => { if (e.isPrimary) endDrag(false, true); });
window.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    endDrag(true);
    if (state.picking) setPicking(null);
  }
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

// 'png', 'jpg' or 'webp' from a file's first bytes, or null.
function imageType(b) {
  if (isPNG(b)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

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

// Each image dropped or chosen becomes a new layer on top, along with the
// world file and CRS file named after it. (With a single image, any world
// file and CRS file go with it.) `url` is where a single image came from.
// Unless quiet, zooms to the new layers that were placed (unless keepView)
// and reports on them in the status line. Returns {added, placed, messages,
// failed}.
async function loadFiles(files, dropPoint, { keepView = false, url = null, quiet = false } = {}) {
  const images = files.filter(f => isImageFile(f) || KMZ_RE.test(f.name));
  if (!images.length) {
    const message = 'That doesn’t look like a JPEG, PNG, WebP, GeoTIFF or KMZ file.';
    if (!quiet) setStatus(message, true);
    return { added: [], placed: [], messages: [message], failed: true };
  }
  const sidecars = files.filter(f => !images.includes(f));
  const stem = (name) => name.replace(/\.aux\.xml$/i, '').replace(/\.[^.]+$/, '');
  const added = [], placed = [], messages = [];
  let failed = false;
  for (const image of images) {
    const group = images.length === 1 ? files
      : [image, ...sidecars.filter(f => [stem(image.name), image.name].includes(f.name.replace(/\.aux\.xml$/i, '')) ||
        stem(f.name) === stem(image.name))];
    const r = await loadImage(group, dropPoint);
    messages.push(r.message);
    failed ||= r.error;
    if (!r.layer) continue;
    r.layer.url = url;
    addLayer(r.layer);
    added.push(r.layer);
    if (r.placed) placed.push(r.layer);
  }
  if (!quiet) {
    if (placed.length && !keepView) zoomToLayers(placed);
    setStatus(messages.join('<br>'), failed);
  }
  return { added, placed, messages, failed };
}

// One image and its sidecar files, as a layer: {layer, placed, message,
// error}, with no layer if it couldn't be read.
async function loadImage(files, dropPoint) {
  let imageFile = files.find(isImageFile);
  let kmlText = '';
  const kmzFile = files.find(f => KMZ_RE.test(f.name));
  let kmzOriginal = null;
  if (!imageFile && kmzFile) {
    try {
      ({ imageFile, kmlText, original: kmzOriginal } = await unpackKMZ(kmzFile));
    } catch (err) {
      console.warn(err);
      return { message: `Could not read <b>${escapeHTML(kmzFile.name)}</b>: ${escapeHTML(err.message)}`, error: true };
    }
  }
  if (!imageFile) return { message: `There’s no image in <b>${escapeHTML(kmzFile.name)}</b>.`, error: true };
  const worldFile = files.find(f => WORLD_RE.test(f.name));
  const crsFile = files.find(f => /\.(prj|aux\.xml)$/i.test(f.name));
  const bytes = new Uint8Array(await imageFile.arrayBuffer());

  // An export with its unwarped image inside: work from that instead.
  const unwarped = await loadUnwarped(bytes, kmzOriginal);
  if (unwarped) return unwarped;

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
    return { message: `Could not read <b>${escapeHTML(imageFile.name)}</b>: ${escapeHTML(err.message)}`, error: true };
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

  // `bytes`: the file, for embedding as the unwarped image, if the browser
  // decodes it as it is and the layer shows it as it is.
  const layer = newLayer({
    name: imageFile.name, img: source, W, H, paper: findPaper(source),
    bytes: source === img && imageType(bytes) ? bytes : null,
  }, placement.T, placement.points);
  return {
    layer,
    placed: !!(placement.points.length || how),
    message: `<b>${escapeHTML(imageFile.name)}</b> (${W}×${H})${how ? ', ' + how : ''}.` +
      (problem ? ` ${escapeHTML(problem)}` : ''),
    error: !!problem,
  };
}

// Magenta: unlike the black, blue and brown of base maps and old maps.
const TINT_DEFAULT = [0.85, 0, 0.5];

function newLayer(image, T, points) {
  return {
    id: nextLayerId++,
    image,
    url: null,
    T,
    points,
    warp: null, mesh: null, fine: null, origin: [0, 0],
    opacity: 1,
    hidePaper: 0,
    // Tint: the image's ink drawn in one color, to tell it from the map.
    tint: { on: false, color: TINT_DEFAULT },
    // Isolate color: {amount (0 for off), w (isolateWeights), showD and hideD
    // (the densities picked to show and hide), color (to draw in), picked
    // and hidden (the colors picked)}, and while picking, the same for the
    // line under the pointer.
    isolate: { amount: 0, w: null, showD: null, hideD: null, color: null, picked: null, hidden: null },
    preview: null,
    gpu: null, texDirty: true, meshDirty: true,
    card: null,
  };
}

// The layer for an export that has its unwarped image embedded (see
// ORIGINAL_CHUNK), placed and with its control points as when it was
// exported; null if there isn't one, or it can't be used.
async function loadUnwarped(bytes, kmzOriginal) {
  let text = null, original = null;
  try {
    if (isPNG(bytes)) {
      text = readTextChunks(bytes)[META_KEY];
      original = kmzOriginal || readChunk(bytes, ORIGINAL_CHUNK);
    } else if (isTIFF(bytes)) {
      const tags = readTIFFTags(bytes);
      text = tags[270];
      original = tags[ORIGINAL_TAG];
    }
    if (!text || !original || !imageType(original)) return null;
    const meta = JSON.parse(text);
    const { source, sourceWorldFile } = meta;
    if (meta.generator !== 'rubbersheet' || !source || !Array.isArray(sourceWorldFile)) return null;
    const name = source.name || `image.${imageType(original)}`;
    // A copy, so the layer doesn't keep the whole export alive.
    const own = original.slice();
    const img = await decodeImage(new File([own], name));
    const W = img.naturalWidth, H = img.naturalHeight;
    if (W !== source.width || H !== source.height) return null;
    const points = (meta.controlPoints || []).map(cp => {
      const [x, y] = toMerc({ lng: cp.lngLat[0], lat: cp.lngLat[1] });
      return { u: cp.sourcePixel[0], v: cp.sourcePixel[1], x, y, ...(cp.anchor === 'world' ? { world: true } : {}) };
    });
    const layer = newLayer({ name, img, W, H, paper: findPaper(img), bytes: own },
      worldFileToAffine(sourceWorldFile), points);
    return {
      layer,
      placed: true,
      message: `<b>${escapeHTML(name)}</b> (${W}×${H}), from the unwarped image inside the export, placed as it was.`,
      error: false,
    };
  } catch (err) {
    console.warn(err);
    return null;
  }
}

// The paper's colour across an image (estimatePaper), found on a copy at most
// PAPER_SIDE pixels across. Null if the browser won't share the pixels.
const PAPER_SIDE = 1600;
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

// ?image=<url> loads an image from the web, and ?image=<url>&image=<url>…
// several, bottom to top. The servers have to allow cross-origin requests.
// The parameter follows the layers: it lists those loaded from URLs.
let loadingURLs = false;
function syncImageParam() {
  // Left alone while loading them, and (so that a link survives a failed
  // load) after a failure, until the layers next change.
  if (loadingURLs) return;
  const u = new URL(window.location.href);
  const urls = state.layers.map(L => L.url).filter(Boolean);
  const now = u.searchParams.getAll('image');
  if (urls.length === now.length && urls.every((x, i) => x === now[i])) return;
  u.searchParams.delete('image');
  for (const x of urls) u.searchParams.append('image', x);
  history.replaceState(history.state, '', u);
}

async function fetchImage(url) {
  let blob;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    console.warn(err);
    return { error: `Could not load <b>${escapeHTML(url)}</b> (${escapeHTML(err.message)}). ` +
      'The server must allow cross-origin requests.' };
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
  return { file: new File([blob], name, { type: blob.type }) };
}

// Load images from URLs, each as a layer, in order. Unless keepView, zoom to
// those that were placed.
async function loadURLs(urls, keepView = false) {
  setStatus(urls.map(url => `Loading <b>${escapeHTML(url)}</b>…`).join('<br>'));
  const fetched = await Promise.all(urls.map(fetchImage));
  const placed = [], messages = [];
  let failed = false;
  loadingURLs = true;
  for (let i = 0; i < urls.length; i++) {
    if (fetched[i].error) {
      messages.push(fetched[i].error);
      failed = true;
      continue;
    }
    const r = await loadFiles([fetched[i].file], null, { url: urls[i], quiet: true });
    placed.push(...r.placed);
    messages.push(...r.messages);
    failed ||= r.failed;
  }
  loadingURLs = false;
  if (!failed) syncImageParam();
  if (placed.length && !keepView) zoomToLayers(placed);
  setStatus(messages.join('<br>'), failed);
}

const loadURL = (url, keepView) => loadURLs([url], keepView);

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
  entry ||= entries.find(e => IMAGE_RE.test(e.name) && !e.name.startsWith(ORIGINAL_DIR));
  if (!entry) throw new Error('no PNG, JPEG or WebP image inside.');
  const name = entry.name.split('/').pop();
  const type = MIME[name.split('.').pop().toLowerCase()] || '';
  const original = entries.find(e => e.name.startsWith(ORIGINAL_DIR))?.data || null;
  return { imageFile: new File([entry.data], name, { type }), kmlText, original };
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
async function rasterize(mesh, pos, px, py, maxSide = Infinity, output = 'png', img) {
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
  const px0 = px, py0 = py;
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
  const gpu = renderer.create();
  // Mipmaps only when the image is shrunk to fit the limits: at the source's
  // own resolution they'd only blur it.
  const shrunk = px > px0 * 1.01 || py > py0 * 1.01;
  renderer.setTexture(gpu, textureSource(img, gl.getParameter(gl.MAX_TEXTURE_SIZE)), shrunk);
  renderer.setTriangles(gpu, meshTriangles({ ...mesh, pos }, origin));
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
    renderer.draw(gpu, new Float32Array([2 / spanX, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, -sy * centreY, 0, 1]), 1);
    if (rgba) {
      gl.readPixels(0, 0, ow, sh, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      // GL rows run bottom-up.
      for (let j = 0; j < h; j++) rgba.set(strip.subarray((sh - 1 - j) * row, (sh - j) * row), (y0 + j) * row);
    } else {
      ctx.drawImage(canvas, 0, 0, ow, h, 0, y0, ow, h);
    }
    await exportProgress('Drawing', (y0 + h) / oh);
  }
  renderer.free(gpu);
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
  await exportProgress('Encoding PNG');
  const blob = await new Promise(resolve => out2d.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the browser could not encode the image.');
  return { ...result, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// The export mesh: dense enough for the warp, and for reprojection. A bent
// warp gets cells split where it bends sharply (near a control point moved
// out of line with its neighbours), to stay within a quarter of an output
// pixel everywhere.
function exportMesh(snap, minCells) {
  const { W, H } = snap.image;
  if (snap.points.length < 3) {
    return buildMesh(snap.warp.map, W, H, minCells ? cellsAcross(W, H, minCells) : 1);
  }
  return refinedSoup(snap.warp.map, W, H, cellsAcross(W, H, EXPORT_CELLS),
    affineScale(snap.warp.S) / 4, snap.points.map(p => [p.u, p.v]));
}

// What an export works from, copied when it starts: the export yields to the
// browser to show its progress, and the image may be edited meanwhile.
function exportSnapshot(L) {
  return {
    image: L.image, warp: L.warp, T: L.T.slice(), points: L.points.map(p => ({ ...p })),
    embed: $('include-original').checked,
  };
}

// The unwarped image's file, to embed: the bytes it was loaded from when the
// browser can decode them as they are, otherwise the image as a PNG.
async function unwarpedBytes(image) {
  if (image.bytes) return image.bytes;
  await exportProgress('Encoding unwarped image');
  const { img, W, H } = image;
  let c = img;
  if (!(img instanceof HTMLCanvasElement)) {
    c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(img, 0, 0);
  }
  const blob = await new Promise((resolve, reject) =>
    c.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode the unwarped image'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// Metadata for an exported raster. `toPixel` maps Mercator units to its
// pixel coordinates.
function exportMetadata(snap, crs, ow, oh, worldFile, bounds, toPixel) {
  const { name, W, H } = snap.image;
  return {
    generator: 'rubbersheet',
    version: 1,
    crs,
    width: ow,
    height: oh,
    worldFile,
    bounds,
    source: { name, width: W, height: H, ...(snap.embed ? { embedded: true } : {}) },
    // The unwarped image's placement, in EPSG:3857 whatever `crs` is, so it
    // can be put back exactly when it's embedded.
    sourceWorldFile: affineToWorldFile(snap.T),
    controlPoints: snap.points.map(p => {
      const ll = toLngLat([p.x, p.y]);
      return {
        pixel: toPixel(p.x, p.y), sourcePixel: [p.u, p.v], lngLat: [ll.lng, ll.lat],
        ...(p.world ? { anchor: 'world' } : {}),
      };
    }),
  };
}

function exportBaseName(snap) {
  return snap.image.name.replace(/\.[^.]+$/, '').replace(/-georef$/, '') + '-georef';
}

async function exportImage(snap) {
  await exportProgress('Preparing');
  const mesh = exportMesh(snap, 0);
  const r = await rasterize(mesh, mesh.pos, ...Array(2).fill(affineScale(snap.warp.S)), Infinity, 'png', snap.image.img);
  const { ow, oh, px: ps, minX, minY } = r;

  // Output pixel (i, j) covers [minX + i*ps, minX + (i+1)*ps) etc.
  const worldFile = affineToWorldFile([ps, 0, minX, 0, ps, minY]);
  const nw = toLngLat([minX, minY]), se = toLngLat([minX + ow * ps, minY + oh * ps]);
  const meta = exportMetadata(snap, 'EPSG:3857', ow, oh, worldFile, [nw.lng, se.lat, se.lng, nw.lat],
    (x, y) => [(x - minX) / ps, (y - minY) / ps]);
  let bytes = addTextChunk(r.bytes, META_KEY, JSON.stringify(meta));
  if (snap.embed) bytes = addChunk(bytes, ORIGINAL_CHUNK, await unwarpedBytes(snap.image));
  const base = exportBaseName(snap);
  download(new Blob([bytes], { type: 'image/png' }), `${base}.png`);
  if ($('worldfile').checked) {
    download(new Blob([worldFile.map(n => n.toPrecision(17)).join('\n') + '\n'], { type: 'text/plain' }), `${base}.pgw`);
    const aux = `<PAMDataset>\n  <SRS>${WKT_3857}</SRS>\n</PAMDataset>\n`;
    download(new Blob([aux], { type: 'application/xml' }), `${base}.png.aux.xml`);
  }
  setStatus(`Exported <b>${escapeHTML(base)}.png</b> (${ow}×${oh}).`);
}

// A Web Mercator GeoTIFF. The rubbersheet metadata goes in ImageDescription.
async function exportGeoTIFF(snap) {
  await exportProgress('Preparing');
  const mesh = exportMesh(snap, 0);
  const r = await rasterize(mesh, mesh.pos, ...Array(2).fill(affineScale(snap.warp.S)), Infinity, 'rgba', snap.image.img);
  const { ow, oh, px: ps, minX, minY } = r;
  const worldFile = affineToWorldFile([ps, 0, minX, 0, ps, minY]);
  const nw = toLngLat([minX, minY]), se = toLngLat([minX + ow * ps, minY + oh * ps]);
  const meta = exportMetadata(snap, 'EPSG:3857', ow, oh, worldFile, [nw.lng, se.lat, se.lng, nw.lat],
    (x, y) => [(x - minX) / ps, (y - minY) / ps]);
  const size = ps * EARTH_CIRCUMFERENCE;
  const extraTags = snap.embed ? [{ tag: ORIGINAL_TAG, bytes: await unwarpedBytes(snap.image) }] : [];
  await exportProgress('Compressing');
  const tiff = await writeGeoTIFF({
    width: ow, height: oh, rgba: r.bytes, epsg: 3857,
    scale: [size, size], origin: mercToMeters(minX, minY),
    description: JSON.stringify(meta).replace(/[^\x20-\x7e]/g,
      ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')),
    extraTags,
  });
  const base = exportBaseName(snap);
  download(new Blob([tiff], { type: 'image/tiff' }), `${base}.tif`);
  setStatus(`Exported <b>${escapeHTML(base)}.tif</b> (${ow}×${oh}).`);
}

// Google Earth stretches a GroundOverlay linearly in latitude, so the KMZ
// image is resampled to EPSG:4326 (plate carrée) rather than Mercator.
async function exportKMZ(snap) {
  await exportProgress('Preparing');
  const mesh = exportMesh(snap, DISPLAY_CELLS);
  // Plot longitude right and latitude down (negated), so north is at the top.
  const pos = new Float64Array(mesh.pos.length);
  for (let k = 0; k < pos.length; k += 2) {
    pos[k] = mercXToLng(mesh.pos[k]);
    pos[k + 1] = -mercYToLat(mesh.pos[k + 1]);
  }
  const [, minY, , maxY] = meshBounds({ pos });
  // Same ground resolution as the source, with square pixels at mid-latitude.
  const px = affineScale(snap.warp.S) * 360;
  const py = px * Math.cos(-(minY + maxY) / 2 * Math.PI / 180);
  const r = await rasterize(mesh, pos, px, py, MAX_KMZ_SIDE, 'png', snap.image.img);
  const { ow, oh } = r;
  const west = r.minX, north = -r.minY, east = west + ow * r.px, south = north - oh * r.py;

  const worldFile = [r.px, 0, 0, -r.py, west + r.px / 2, north - r.py / 2];
  const meta = exportMetadata(snap, 'EPSG:4326', ow, oh, worldFile, [west, south, east, north], (x, y) => {
    const ll = toLngLat([x, y]);
    return [(ll.lng - west) / r.px, (north - ll.lat) / r.py];
  });
  const png = addTextChunk(r.bytes, META_KEY, JSON.stringify(meta));
  const base = exportBaseName(snap);
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
  const entries = [
    { name: 'doc.kml', data: new TextEncoder().encode(kml) },
    { name: imageName, data: png },
  ];
  if (snap.embed) {
    // Google Earth ignores the other files in a KMZ.
    const data = await unwarpedBytes(snap.image);
    const stem = snap.image.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'image';
    entries.push({ name: `${ORIGINAL_DIR}${stem}.${imageType(data) || 'png'}`, data });
  }
  await exportProgress('Zipping');
  const zip = makeZip(entries);
  download(new Blob([zip], { type: 'application/vnd.google-earth.kmz' }), `${base}.kmz`);
  setStatus(`Exported <b>${escapeHTML(base)}.kmz</b> (${ow}×${oh}).`);
}

// Export progress, shown on the Export button. `exportProgress` is a no-op
// outside an export started from the button. Otherwise it relabels the button,
// with a bar for `fraction` (0–1) or an indeterminate one without, and gives
// the browser a chance to paint it, since most export work blocks the page.
let exporting = null;  // the layer being exported
async function exportProgress(label, fraction = null) {
  if (!exporting) return;
  const btn = exporting.card.querySelector('.export');
  btn.textContent = fraction === null ? `${label}…` : `${label}… ${Math.floor(fraction * 100)}%`;
  btn.classList.toggle('indeterminate', fraction === null);
  btn.style.setProperty('--progress', fraction === null ? 1 : fraction);
  // Wait for a frame to be painted; a timer covers background tabs, which
  // get no animation frames.
  await new Promise(resolve => {
    const t = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(t); resolve(); }));
  });
}

async function runExport(L) {
  if (exporting) return;
  const snap = exportSnapshot(L);
  exporting = L;
  const btn = L.card.querySelector('.export');
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  updateUI();
  try {
    await EXPORTERS[$('format').value](snap);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${escapeHTML(err.message)}`, true);
  } finally {
    exporting = null;
    btn.classList.remove('busy', 'indeterminate');
    btn.removeAttribute('aria-busy');
    btn.style.removeProperty('--progress');
    btn.textContent = 'Export';
    updateUI();
  }
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
function setStatus(html, error) {
  statusBase = error ? `<span style="color:#c0261b">${html}</span>` : html;
  updateUI();
}

// ---------------------------------------------------------------------------
// Isolate color: click a line on the image to show only lines of its color.
// isolate.js has the details.

// Start picking the color for layer L to show, or with `hide`, to hide as
// well; or stop with null. While picking, the image shows as it is, but in
// a circle around the pointer, which previews the pick under it, so it's
// plain whether the pointer is on the line meant before clicking.
function setPicking(L, hide = false) {
  const was = state.picking;
  state.picking = L;
  state.pickHide = !!L && hide;
  if (was) was.preview = null;
  if (was?.card) syncIsolate(was);
  if (L?.card) syncIsolate(L);
  document.body.classList.toggle('picking', !!L);
  if (L) setStatus(pickHelp(L, hide));
  else if (was) setStatus('');
  map.getCanvas().style.cursor = cursorFor(lastPointer && hitTest(lastPointer), false);
  if (L && lastPointer) previewPick();
  drawOverlay();
  map.triggerRepaint();
}

const pickHelp = (L, hide) => hide
  ? `Point at a line of a color to hide from <b>${escapeHTML(L.image.name)}</b> as well. The circle shows the result; click to keep it. <kbd>Esc</kbd> cancels.`
  : `Point at a line on <b>${escapeHTML(L.image.name)}</b>. The circle shows only lines of its color; click to keep it. <kbd>Esc</kbd> cancels.`;

// The preview circle around the pointer, in CSS pixels.
const LENS_RADIUS = 90;

// The preview circle as [x, y, r] in framebuffer pixels (y up), for the
// shader.
function lensCircle() {
  if (!lastPointer) return [0, 0, 0];
  const canvas = map.getCanvas();
  const k = canvas.width / canvas.clientWidth;
  return [lastPointer[0] * k, canvas.height - lastPointer[1] * k, LENS_RADIUS * k];
}

// The radius, in screen pixels, around the pointer within which to look for
// the line meant, and the most source pixels across to look at.
const PICK_RADIUS = 4;
const PICK_SIDE = 25;

// L's Isolate color settings for the line at screen point p: to show only
// its color, or with `hide`, to hide its color too. {iso} or {error}.
function pickCandidate(L, p, hide) {
  const paper = L.image.paper;
  const m = screenToMerc(p);
  const uv = paper && L.mesh && invertDrawn(L.mesh, L.fine, m[0], m[1]);
  if (!uv) return { error: pickHelp(L, hide) };
  // The search radius in source pixels, from how big a screen pixel is there.
  const m2 = screenToMerc([p[0] + PICK_RADIUS, p[1]]);
  const uv2 = invertDrawn(L.mesh, L.fine, m2[0], m2[1]);
  const r = Math.max(1.5, uv2 ? Math.hypot(uv2[0] - uv[0], uv2[1] - uv[1]) : PICK_RADIUS);
  const n = Math.min(PICK_SIDE, Math.ceil(2 * r));
  const c = pickCandidate.canvas ||= document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(L.image.img, uv[0] - r, uv[1] - r, 2 * r, 2 * r, 0, 0, n, n);
  let data;
  try {
    data = ctx.getImageData(0, 0, n, n).data;
  } catch (err) {
    return { error: 'The browser won’t share this image’s pixels, so its colors can’t be picked.' };
  }
  // The paper's color there, from the nearest cell of its grid.
  const { grid, gw, gh } = paper;
  const i = Math.min(gw - 1, Math.max(0, Math.floor(uv[0] / L.image.W * gw)));
  const j = Math.min(gh - 1, Math.max(0, Math.floor(uv[1] / L.image.H * gh)));
  const pc = [0, 1, 2].map(k => grid[(j * gw + i) * 4 + k] / 255);
  const d = pickDensity(data, pc);
  if (!d) return { error: 'There’s only paper here. Point right at a line.' };
  const rgb = pc.map((x, k) => x * Math.exp(-d[k]));
  if (hide) {
    return { iso: { ...L.isolate, w: isolateWeights(L.isolate.showD, d), hideD: d, hidden: rgb } };
  }
  // A color picked to hide before stays hidden.
  const w = isolateWeights(d, L.isolate.hideD);
  if (!w) return { error: 'That’s black ink, or too close to it to tell apart. Point at a line of another color.' };
  return {
    iso: { ...L.isolate, amount: L.isolate.amount || 0.5, w, showD: d, color: drawColor(d), picked: rgb },
  };
}

// Preview the pick under the pointer, at most once a frame.
let previewFrame = 0;
function previewPick() {
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    const L = state.picking, hide = state.pickHide;
    if (!L || !lastPointer || state.drag) return;
    const c = pickCandidate(L, lastPointer, hide);
    L.preview = c.iso || null;
    // Not shown as an error until a click misses.
    setStatus(c.iso ? pickHelp(L, hide) : c.error);
    drawOverlay();
    map.triggerRepaint();
  });
}

// Keep the pick at screen point p for layer L.
function pickIsolate(L, p, hide) {
  const c = pickCandidate(L, p, hide);
  if (!c.iso) {
    setStatus(c.error, true);
    return;
  }
  L.isolate = c.iso;
  setPicking(null);
}

// Stop hiding L's second color.
function clearHidden(L) {
  const iso = L.isolate;
  L.isolate = { ...iso, w: isolateWeights(iso.showD), hideD: null, hidden: null };
  syncIsolate(L);
  map.triggerRepaint();
}

// Show L's Isolate color settings in its card.
function syncIsolate(L) {
  if (!L.card) return;
  const q = (sel) => L.card.querySelector(sel);
  const iso = L.isolate;
  const picking = state.picking === L;
  q('.isolate').value = iso.amount;
  q('.isolate').disabled = !iso.w;
  // Nothing to color, nor to hide as well, until there's a color to show.
  q('.isolate-pick').textContent = picking && !state.pickHide ? 'Cancel' : 'Pick';
  q('.hide-row').hidden = !iso.showD;
  q('.hidden-swatch').hidden = !iso.hidden;
  q('.hidden-swatch').style.background = iso.hidden ? toHex(iso.hidden) : 'transparent';
  q('.hidden-swatch').title = iso.hidden ? `Hidden: ${toHex(iso.hidden)}` : '';
  q('.hide-pick').textContent = picking && state.pickHide ? 'Cancel' : 'Pick';
  q('.hide-clear').hidden = !iso.hidden;
}

// ---------------------------------------------------------------------------
// Layers: the list in the panel, top layer first.

// Show `order` (bottom to top) as the layers.
function setLayers(order) {
  for (const L of state.layers) if (!order.includes(L)) freeGPU(L);
  state.layers = order.slice();
  if (state.picking && !state.layers.includes(state.picking)) setPicking(null);
  if (!state.layers.includes(state.selected)) state.selected = state.layers[state.layers.length - 1] ?? null;
  state.hover = null;
  const list = $('layers');
  list.replaceChildren(...state.layers.slice().reverse().map(layerCard));
  list.hidden = !state.layers.length;
  if (!state.layers.length) {
    statusBase = '';
    map.getCanvas().style.cursor = '';
  }
  syncImageParam();
  map.triggerRepaint();
  scheduleDetail();
  drawOverlay();
  updateUI();
}

function select(L) {
  state.selected = L;
  state.hover = null;
  drawOverlay();
  updateUI();
}

// A new layer on top, selected.
function addLayer(L) {
  checkpoint();
  update(L);
  setLayers([...state.layers, L]);
  select(L);
}

function removeLayer(L) {
  if (state.drag || state.ease) return;
  checkpoint();
  statusBase = '';
  setLayers(state.layers.filter(x => x !== L));
}

function layerCard(L) {
  if (L.card) return L.card;
  const card = $('layer-template').content.firstElementChild.cloneNode(true);
  L.card = card;
  const q = (sel) => card.querySelector(sel);
  q('.name').textContent = L.image.name;
  q('.name').title = L.image.name;
  const opacity = q('.opacity'), hide = q('.hide-paper');
  opacity.id = `opacity-${L.id}`;
  hide.id = `hide-paper-${L.id}`;
  q('.opacity-label').htmlFor = opacity.id;
  q('.hide-paper-label').htmlFor = hide.id;
  opacity.value = L.opacity;
  hide.value = L.hidePaper;
  opacity.addEventListener('input', () => {
    L.opacity = Number(opacity.value);
    map.triggerRepaint();
    scheduleDetail();
  });
  hide.addEventListener('input', () => {
    L.hidePaper = Number(hide.value);
    map.triggerRepaint();
  });
  const paper = L.image.paper;
  hide.disabled = !paper;
  q('.swatch').style.background = paper ? `rgb(${paper.colour.join(',')})` : 'transparent';
  q('.swatch').title = paper ? `Paper color: rgb(${paper.colour.join(', ')})` : '';
  const iso = q('.isolate'), pick = q('.isolate-pick');
  iso.id = `isolate-${L.id}`;
  q('.isolate-label').htmlFor = iso.id;
  iso.addEventListener('input', () => {
    L.isolate.amount = Number(iso.value);
    map.triggerRepaint();
  });
  const tintOn = q('.tint-on'), tint = q('.tint');
  tintOn.id = `tint-${L.id}`;
  q('.tint-label').htmlFor = tintOn.id;
  tintOn.checked = L.tint.on;
  tint.value = toHex(L.tint.color);
  tintOn.addEventListener('change', () => {
    L.tint.on = tintOn.checked;
    map.triggerRepaint();
  });
  // Choosing a color turns the tint on.
  tint.addEventListener('input', () => {
    L.tint = { on: true, color: fromHex(tint.value) };
    tintOn.checked = true;
    map.triggerRepaint();
  });
  // Pick, or while picking that, cancel.
  const pickButton = (button, hide) => {
    button.disabled = !paper;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected !== L) select(L);
      setPicking(state.picking === L && state.pickHide === hide ? null : L, hide);
    });
  };
  pickButton(pick, false);
  pickButton(q('.hide-pick'), true);
  q('.hide-clear').addEventListener('click', (e) => {
    e.stopPropagation();
    clearHidden(L);
  });
  syncIsolate(L);
  q('.export').addEventListener('click', () => runExport(L));
  q('.zoom').addEventListener('click', () => zoomToLayers([L]));
  q('.remove').addEventListener('click', () => removeLayer(L));
  // On click, not pointerdown: selecting can change the card's height, which
  // would move a button out from under the pointer before it's released.
  card.addEventListener('click', () => {
    if (state.selected !== L && state.layers.includes(L)) select(L);
  });
  q('.grip').addEventListener('pointerdown', (e) => dragCard(L, e));
  return card;
}

// Drag a layer's card up or down the list by its grip, moving the layer in
// the map as it goes.
function dragCard(L, e) {
  if (e.button !== 0 || state.drag || state.ease) return;
  e.preventDefault();
  // Listening on the window: moving the card in the list would lose a
  // pointer capture.
  const card = L.card, list = $('layers'), id = e.pointerId;
  if (state.selected !== L) select(L);
  card.classList.add('moving');
  const start = state.layers.slice();
  const orderFromList = () => [...list.children].reverse().map(c => state.layers.find(x => x.card === c));
  // Where the card would be if it followed the pointer: it moves past a
  // neighbour once its leading edge passes the neighbour's middle, which is
  // half a card either way, wherever on the card it was grabbed.
  const grab = e.clientY - card.getBoundingClientRect().top;
  const mid = (c) => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    const top = ev.clientY - grab, bottom = top + card.offsetHeight;
    let moved = false;
    for (;;) {
      const next = card.nextElementSibling, prev = card.previousElementSibling;
      if (next && mid(next) < bottom) list.insertBefore(next, card);
      else if (prev && mid(prev) > top) list.insertBefore(card, prev);
      else break;
      moved = true;
    }
    if (!moved) return;
    state.layers = orderFromList();
    map.triggerRepaint();
    drawOverlay();
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    card.classList.remove('moving');
    const order = orderFromList();
    state.layers = start;
    if (order.some((x, i) => x !== start[i])) {
      checkpoint();
      setLayers(order);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function updateUI() {
  $('undo').disabled = !edits.undo.length;
  $('redo').disabled = !edits.redo.length;
  const status = $('status');
  status.innerHTML = statusBase;
  status.hidden = !statusBase;
  for (const L of state.layers) {
    const card = layerCard(L);
    const selected = L === state.selected;
    card.classList.toggle('selected', selected);
    card.querySelector('.export').disabled = !!exporting;
    const n = L.points.length;
    card.querySelector('.info').textContent = `${L.image.W}×${L.image.H}, ${n} control point${n === 1 ? '' : 's'}` +
      (n < 2 && selected ? ' — ⌘/Ctrl-click the image to add one.' : '.');
  }
}

function zoomToLayers(layers) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of layers) {
    if (!L.mesh) continue;
    const b = meshBounds(L.mesh);
    minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
  }
  if (!(minX < maxX)) return;
  const nw = toLngLat([minX, minY]), se = toLngLat([maxX, maxY]);
  map.fitBounds([[nw.lng, se.lat], [se.lng, nw.lat]], { padding: 60, duration: 600 });
}

const EXPORTERS = { png: exportImage, tiff: exportGeoTIFF, kmz: exportKMZ };
$('format').addEventListener('change', (e) => {
  $('worldfile-row').hidden = e.target.value !== 'png';
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('basemap').addEventListener('change', (e) => {
  map.setStyle(STYLES[e.target.value], { diff: false });
  // Only the vector maps have separate road layers to lift.
  $('streets-on-top').disabled = !['streets', 'lines'].includes(e.target.value);
});
$('streets-on-top').addEventListener('change', (e) => {
  state.streetsOnTop = e.target.checked;
  applyStreets();
});

const imageParams = new URLSearchParams(window.location.search).getAll('image').filter(Boolean);
if (imageParams.length) loadURLs(imageParams, linkHasView);

// Exposed for debugging and automated tests.
window.rubbersheet = {
  map, state, update, loadFiles, loadURL, loadURLs, exportSnapshot, exportImage, exportGeoTIFF, exportKMZ,
  decodeJPEG, invertDrawn, EASE, select, removeLayer, setLayers, undo, redo,
};
