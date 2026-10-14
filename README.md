# rubbersheet

Map rubbersheeting in the browser. Drop a scanned map or photo onto a MapLibre base map, pin points on it to their real locations, and export a georeferenced PNG, or a KMZ for Google Earth.

## Using it

- **Drop** a JPEG, PNG, WebP or KMZ onto the map, or use the *choose a file* link. The image is centred where you drop it and sized to cover about 75% of the view.
- **Link** to an image on the web by adding `?image=` and the URL-encoded image address to the page URL, for example `https://e-n-f.github.io/rubbersheet/?image=https%3A%2F%2Fwww.flickr.com%2Fphoto_download.gne%3Fsize%3Do%26id%3D55586523402%26secret%3D33ed8c454a`. A PNG exported from rubbersheet goes to its georeferenced place and the map zooms to it, unless the link also has a map view (`#zoom/lat/lng`). The image's server must allow cross-origin requests (Flickr does).
- **Drag** the image to move it. Once you add a control point, the image is pinned: dragging its background pans the map instead, and the corner handles disappear. From then on, you adjust it by dragging control points.
- **Drag a corner handle** to scale and rotate around the image centre. Hold <kbd>Shift</kbd> to scale without rotating. (This works only before the first control point is added.)
- **⌘-click** (Ctrl-click on Windows/Linux) the image to add a control point. ⌘-click a point to remove it.
- **Drag a control point** to move that spot of the image to a new place on the map. The image goes half-transparent while you drag so you can see the map underneath.
- <kbd>Esc</kbd> during a drag cancels it.
- **Export PNG** saves a north-up image in Web Mercator (EPSG:3857), at about the source resolution.
- **Export KMZ** saves a KMZ you can open in, or drag into, Google Earth. Google Earth stretches an overlay evenly in latitude, so the image inside is in EPSG:4326 (plate carrée), not Mercator, with square pixels at its middle latitude. It is capped at 8192 pixels a side.

How the image is fitted depends on the number of control points:

| Points | Transformation |
|---|---|
| 0 | Moves, scales and rotates freely |
| 1 | Dragging the point moves the whole image |
| 2 | The similarity transform (shift + scale + rotation) through both points |
| 3+ | A least-squares similarity, then rigid Moving Least Squares (Schaefer et al. 2006) to bend the rest of the way. Every point lands exactly where you put it. |

The warp is evaluated on a 64×64 grid and drawn as a textured mesh in a MapLibre custom WebGL layer, so it updates live while you drag. The export uses the same method on a 256×256 grid.

## Georeferencing metadata

Exported PNGs carry a `tEXt` chunk with the keyword `rubbersheet` holding JSON:

```json
{
  "generator": "rubbersheet",
  "version": 1,
  "crs": "EPSG:3857",
  "width": 892, "height": 687,
  "worldFile": [A, D, B, E, C, F],
  "bounds": [west, south, east, north],
  "source": { "name": "old-map.png", "width": 800, "height": 600 },
  "controlPoints": [
    { "pixel": [x, y], "sourcePixel": [u, v], "lngLat": [lng, lat] }
  ]
}
```

`worldFile` uses the standard [world file](https://gdal.org/en/stable/drivers/raster/wld.html) parameters in the units of `crs`: EPSG:3857 metres for the PNG export, and degrees (`"crs": "EPSG:4326"`) for the PNG inside a KMZ. `pixel` is the point's position in the exported image, and `sourcePixel` is its position in the original image. If you drop an exported PNG or KMZ (or the PNG from inside a KMZ) back on the map, it goes to the same place with its control points restored, so you can keep adjusting it. EPSG:4326 images are resampled row by row into Mercator when they are loaded.

Tick *Also download world file* to get `name.pgw` and `name.png.aux.xml` (the CRS) next to the PNG. GDAL and QGIS can open the result directly. You can also drop an image together with its world file (`.wld`, `.pgw`, `.jgw`, …) and an optional `.prj` or `.aux.xml`. Images in EPSG:3857 and EPSG:4326 are placed from the world file. A KMZ from elsewhere is placed from its first GroundOverlay's `LatLonBox`, unless the overlay is rotated.

## Hosting on GitHub Pages

It's a static site with no build step. Turn it on in **Settings → Pages → Build and deployment**: set *Source* to "Deploy from a branch", pick `main` and `/ (root)`. The site will be at `https://<user>.github.io/rubbersheet/`.

To run it locally, serve the directory with any static server (for example `npx http-server .`) and open it in a browser. ES modules don't load from `file://`.

## Development

```sh
node --test test/
```

These tests cover the warp math, the world-file conversions and the PNG metadata chunk.

## Base maps

- Streets: [OpenFreeMap](https://openfreemap.org/) (OpenMapTiles schema, © OpenStreetMap contributors)
- Satellite: Esri World Imagery
- OpenStreetMap: the standard tile layer, for light interactive use under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
