# rubbersheet

Map rubbersheeting in the browser. Drop a scanned map or photo onto a MapLibre base map, pin points on it to their real locations, and export a georeferenced PNG or GeoTIFF, or a KMZ for Google Earth.

## Using it

- **Drop** a JPEG, PNG, WebP, GeoTIFF or KMZ onto the map, or use the *choose files* link. The image is centred where you drop it and sized to cover about 75% of the view. Several can be dropped at once, each with its own world file and CRS file, matched by name.
- **Layers**: each image is a layer of its own, added on top of the others. The panel lists them with the top layer first, and each has its own *Opacity*, *Hide paper* and *Isolate color* sliders and *Export*, *Zoom to image* and *Remove image* buttons. Drag a layer by its grip (⠿) to move it up or down. The base map is under all the images, and *Streets on top* over them all. One layer is **selected** at a time: it has the solid outline, and only its corner handles and control points are shown. Click an image, or its entry in the list, to select it. Where images overlap, clicks go to the selected one, so you can lower the opacity of the image above it and work through it.
- **Link** to an image on the web by adding `?image=` and the URL-encoded image address to the page URL, or to several by repeating it (`?image=…&image=…`, bottom layer first), for example `https://e-n-f.github.io/rubbersheet/?image=https%3A%2F%2Fwww.flickr.com%2Fphoto_download.gne%3Fsize%3Do%26id%3D55586523402%26secret%3D33ed8c454a`. A PNG exported from rubbersheet goes to its georeferenced place and the map zooms to the placed images, unless the link also has a map view (`#zoom/lat/lng`). The image's server must allow cross-origin requests (Flickr does). The parameter follows the layers: removing or reordering images loaded from it updates it.
- **Drag** the image to move it. When you're zoomed in so far that none of its corner handles are in view, dragging pans the map instead. Once you add a control point, the image is pinned: dragging its background pans the map instead, and the corner handles disappear. From then on, you adjust it by dragging control points.
- **Drag a corner handle** to scale and rotate around the image centre. Hold <kbd>Shift</kbd> to scale without rotating. (This works only before the first control point is added.)
- **⌘-click** (Ctrl-click on Windows/Linux) the image to add a control point. ⌘-click a point to remove it.
- **⌘-drag a control point** to slide it to a better spot, for when it wasn't added quite where you meant. The point moves across the image and the map together, so the image stays put; it's the same as removing the point and adding it again where you let go. It works the same way for image and world anchors.
- **Drag a control point** to move that spot of the image to a new place on the map. The image goes half-transparent while you drag so you can see the map underneath.
- **Streets on top of the images** draws the street base map's roads and railways over the image as thin bright yellow lines. It only works with the *Streets* and *Lines & contours* base maps, which have separate road layers. While it's on, ⌘-clicking the image adds a **world anchor**, drawn as a blue square. A world anchor is tied to that place on the map, not to the spot in the image.
  - **Dragging a world anchor** keeps the image still and bends the streets around the anchor, as the new warp will. Drag the street onto the image's feature and let go. The image warps to bring the feature under the pointer to the anchor's place, and the map eases so the anchor stays where you let go. The image eases from the old warp to the new and the streets from bent to straight, in step with the map, so the anchor and its feature stay under the pointer the whole way.
  - **Image anchors** are points added with the streets off, drawn as red circles. Dragging one moves the image as before.
  - **Both kinds** are ordinary control points in the same warp. They differ only in which half a drag changes: the image spot for a world anchor, the map place for an image anchor.
- <kbd>Esc</kbd> during a drag cancels it.
- **Hide paper** makes the image's paper transparent, so the map shows through between its lines. Rubbersheet finds the paper's colour itself, block by block, so it follows uneven lighting and yellowing across a photographed map (the swatch shows the most common paper colour). Each pixel turns transparent in proportion to how close it is to the paper, and keeps its true colour over the map. At the middle of the slider the paper alone is cleared. To the left, the paper only partly fades; to the right, colours close to the paper, such as pale washes, fade too. Like *Opacity*, it changes only the view, not exports.
- **Isolate color** shows only the lines of one color, such as red pencil contours under black engraved hatching. Press *Pick* and click a line of that color; Rubbersheet looks at the few pixels around the click that stand out most from the paper and the black ink, so the click needn't land exactly on a thin line. It also finds the image's dark ink itself, as its darkest pixels. Each pixel is then measured as ink density over the local paper (the negative log of how much light gets through, in which layered inks add up) and split into the dark ink and the picked one. Only the picked ink is drawn, in the color in the box next to the slider, bright by default. Because the split is by ink, a contour stays whole where hatching crosses it. The slider sets how faint a line may be and still show; 0 turns it off. Like *Hide paper*, it changes only the view, not exports.
- **Undo** with ⌘Z (Ctrl-Z) or the *Undo* button, and **redo** with ⇧⌘Z (Ctrl-Shift-Z or Ctrl-Y) or *Redo*. There is one history for all the layers: each drag, each added or removed point, and each added, removed or moved image is one step, up to 50 back.
- **Export** saves that layer's warped image, north-up, in the format chosen under *Format*:
  - **GeoTIFF** (the default): a deflate-compressed RGBA GeoTIFF in Web Mercator (EPSG:3857), at about the source resolution. QGIS, ArcGIS and GDAL open it directly, with no side files.
  - **PNG**: the same image as a PNG, also in EPSG:3857.
  - **Include unwarped image** (on by default) puts the image as it was loaded inside the export as well: in a private PNG chunk (`rsOr`), a private GeoTIFF tag (65123), or a file under `unwarped/` in a KMZ. Other programs ignore it. Dropping the export back on the map then loads the unwarped image, placed and with its control points as when it was exported, instead of the warped pixels. Without it, each round of edit, export and re-import resamples the image again and blurs it a little more. The image is embedded as the file it was loaded from (a JPEG stays the same JPEG), or as a PNG if it was a TIFF or had to be reprojected.
  - **KMZ for Google Earth**: a KMZ you can open in, or drag into, Google Earth. Google Earth stretches an overlay evenly in latitude, so the image inside is in EPSG:4326 (plate carrée), not Mercator, with square pixels at its middle latitude. It is capped at 8192 pixels a side.

How the image is fitted depends on the number of control points:

| Points | Transformation |
|---|---|
| 0 | Moves, scales and rotates freely |
| 1 | Dragging the point moves the whole image |
| 2 | The similarity transform (shift + scale + rotation) through both points |
| 3+ | A least-squares similarity, then rigid Moving Least Squares (Schaefer et al. 2006) to bend the rest of the way. Every point lands exactly where you put it. |

The warp is evaluated on a 64×64 grid and drawn as a textured mesh in a MapLibre custom WebGL layer, so it updates live while you drag. When you're zoomed in, the cells in view are split into pieces about 16 screen pixels across, evaluated exactly, and rebuilt whenever the warp changes or the map stops moving. Without that, the image near a control point that was moved a long way could be drawn tens of pixels from the point's marker. The image's texture is at most 4096 pixels a side, so a larger image is drawn from a shrunk copy while you work. Once nothing has changed for half a second, the part of each image in view, with a margin of up to half a screen's width and height on each side, at the screen's device pixels (twice the nominal ones on a 2× display), (less where that would take more than 12 million pixels for one image, or 24 million shared among all the images in view), is cut from the full-resolution source at that resolution and drawn from that instead. It stays through pans, small zooms and edits, and is replaced after the next pause only if the view has moved past it or needs finer detail. Zooming out more than a step drops it, since it has no mipmaps and would shimmer. The export uses the same method on a 256×256 grid, sampling the image bilinearly. It uses mipmaps only when the image has to be shrunk to fit the export size limits; at the source's own resolution they would blur it, since the GPU can pick a smaller level for a rotated or slightly squeezed image. Each cell is checked against the exact warp at its centre, its edge midpoints and any control point inside it. Cells off by more than a quarter of an output pixel are split 16 × 16, along with their neighbours, so the export stays that accurate even right next to a point moved far out of line with its neighbours. A whole cell next to split ones shares their edge vertices, so no hairline gaps open between them.

## Georeferencing metadata

Exported PNGs carry a `tEXt` chunk with the keyword `rubbersheet` holding JSON (GeoTIFFs carry the same JSON in their `ImageDescription` tag):

```json
{
  "generator": "rubbersheet",
  "version": 1,
  "crs": "EPSG:3857",
  "width": 892, "height": 687,
  "worldFile": [A, D, B, E, C, F],
  "bounds": [west, south, east, north],
  "source": { "name": "old-map.png", "width": 800, "height": 600, "embedded": true },
  "sourceWorldFile": [A, D, B, E, C, F],
  "controlPoints": [
    { "pixel": [x, y], "sourcePixel": [u, v], "lngLat": [lng, lat] }
  ]
}
```

`worldFile` uses the standard [world file](https://gdal.org/en/stable/drivers/raster/wld.html) parameters in the units of `crs`: EPSG:3857 metres for the PNG and GeoTIFF exports, and degrees (`"crs": "EPSG:4326"`) for the PNG inside a KMZ. `sourceWorldFile` is the original image's own placement before any bending, always in EPSG:3857 metres; with `embedded` it puts the embedded unwarped image back exactly. `pixel` is the point's position in the exported image, and `sourcePixel` is its position in the original image. A world anchor also has `"anchor": "world"`. If you drop an exported PNG, GeoTIFF or KMZ (or the PNG from inside a KMZ) back on the map, it goes to the same place with its control points restored, so you can keep adjusting it. Images in any other projection are reprojected into Web Mercator when they are loaded, using the same mesh renderer as the export.

Tick *Also download world file* to get `name.pgw` and `name.png.aux.xml` (the CRS) next to the PNG. GDAL and QGIS can open the result directly. You can also drop an image together with its world file (`.wld`, `.pgw`, `.jgw`, …) and an optional `.prj` or `.aux.xml`. Images in EPSG:3857 and EPSG:4326 are placed from the world file. A KMZ from elsewhere is placed from its first GroundOverlay's `LatLonBox`, including its rotation.

### GeoTIFFs from elsewhere

A GeoTIFF is placed from its own tags. It can be in:

- latitude/longitude, or Web Mercator;
- UTM, given as an EPSG code (WGS84 `326xx`/`327xx`, NAD83 `269xx`, NAD27 `267xx`, ETRS89 `258xx`) or spelled out;
- Transverse Mercator, Lambert Conformal Conic (1SP or 2SP) or Polyconic, spelled out in the file's GeoKeys, in metres or feet. The USGS Historical Topographic Map Collection scans, downloadable as GeoTIFFs from [TopoView](https://ngmdb.usgs.gov/topoview/viewer/), use Polyconic.

The datum can be WGS84, NAD83, ETRS89 or NAD27. NAD27 is shifted to WGS84 with the average shift for the contiguous US, which is good to about 5–10 m; add control points if you need better. Other EPSG codes, such as State Plane zones given only by number, aren't supported yet. The image still loads, and the status line says why it couldn't be placed.

The reader handles 8-bit greyscale, paletted, RGB and RGBA images, in strips or tiles, uncompressed or with LZW, deflate or JPEG compression. That covers what GDAL and QGIS usually write and USGS scans, but not 16-bit or BigTIFF files. Only the first (full-resolution) image in a file is read. JPEG-compressed RGBA (as GDAL writes with `-co COMPRESS=JPEG` on an image with an alpha band) keeps its transparency: browsers decode those four-band JPEG tiles as CMYK and drop the alpha, so each tile is decoded a second time with its color bands flattened, which recovers the alpha.

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
- Lines & contours (the default): a plain style for aligning old maps against, with no buildings, parks or fills. Roads are blue centrelines and railways dashed lines, with their names, water is a pale fill whose edge is the coastline, and elevation contours (in feet, from zoom 10) are drawn by [maplibre-contour](https://github.com/onthegomap/maplibre-contour) from the [Mapzen terrain tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) on AWS. Same OpenFreeMap vector tiles as Streets.
- Satellite: Esri World Imagery
- OpenStreetMap: the standard tile layer, for light interactive use under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
