# Automatic alignment prototype

An experiment, not part of the site: does matching a georeferenced scan's black linework against modern road and rail vectors find its georeferencing error? It loosely follows Chiang, Knoblock, Duan et al.'s work on aligning USGS historical topographic maps with road vector data.

`autoalign.py` takes a GeoTIFF that is already roughly georeferenced (a USGS historical topo, say) and works out where it really belongs:

1. It extracts the black linework (roads, railroads, town grids). These are pixels darker than the paper around them and redder than green after averaging over nearby ink. That leaves out brown contours, blue drainage, shorelines and marsh hatching. Lettering and dots are dropped as small connected components.
2. It projects TIGER/Line or OpenStreetMap roads and railroads into the image using the file's own georeferencing (`georef.mjs` uses rubbersheet's TIFF reader and projections). It leaves out freeways, ramps, service roads and paths, which are almost always later additions. Railroads are weighted 3×.
3. It fits a global similarity (shift, rotation, scale) that lays the vectors on the linework, by maximising a truncated chamfer score, mean exp(−d²/2σ²), where d is the distance to the nearest ink. Modern roads that aren't on the old map score near zero wherever they land, so they add noise but don't pull the fit. The search runs coarse to fine: a grid search over shifts within ±600 m, then Powell over all four parameters.
4. It fits a smooth local offset field on a grid of nodes, 1.5 km apart by default, in two stages:
   - **Brute force per cell.** It searches every shift within ±200 m for the best fit in overlapping 2.5 km cells. Each cell's result is weighted by how sharply the score peaks in each direction: a lone straight road pins the shift across it but not along it. The field is then fitted through those shifts with a smoothness penalty. It also has a weak pull back to the global fit, so it fades out over empty water instead of extrapolating. Cells that disagree with their neighbours lose weight over a few rounds.
   - **Refinement.** It refines the field against all the vector points at once with L-BFGS, plus a penalty on the field's curvature.

   The brute-force stage is needed for city grids. Starting gradient steps from the global fit can stall half a block out, because the grid lines still partly overlap there.
5. It writes control points (`pixel` in the original image → true `lngLat`) on a grid wherever linework supports them, along with these diagnostics:
   - `ink.png`: the extracted linework
   - `before.jpg`, `global.jpg`, `local.jpg`: the vectors drawn over the map after each step
   - `offsets.jpg`: the correction at each control point, exaggerated 5×

With `--export file.tif`, it also writes the corrected map as a Web Mercator GeoTIFF that carries rubbersheet's metadata. The app opens it already pinned, with the generated control points in place to drag or delete. `writetiff.mjs` writes the file with rubbersheet's own GeoTIFF writer.

Given `--reference` (a rubbersheet export of the same map with hand-placed control points), it also scores itself against those points and draws `reference.jpg`. Each hand point appears there as a red ring, and the model's position for the same true location as a blue cross. `refpoints.mjs` maps the export's `sourcePixel`s back to the original file. rubbersheet reprojects a non-Mercator GeoTIFF before you place points on it, so this mapping is needed.

## Running it

It needs Python 3 with numpy, scipy, Pillow and pyshp, plus Node for the georeferencing helpers. The vector data comes from either source:

- **TIGER/Line**: the county roads files and the national rails file from https://www2.census.gov/geo/tiger/TIGER2024/ (`ROADS/tl_2024_<state+county FIPS>_roads.zip`, `RAILS/tl_2024_us_rails.zip`), unzipped.
- **OSM**: `python3 fetch_osm.py WEST SOUTH EAST NORTH osm.json`

```
python3 autoalign.py CA_Haywards_297664_1899_62500_geo.tif \
    --tiger tl_2024_06001_roads.shp tl_2024_06081_roads.shp tl_2024_us_rails.shp \
    --reference hayward.tif --out out
```

It takes about 1½ minutes for a 5000 × 6000 scan.

## Results: USGS Haywards 1899, 1:62,500

These are compared against 23 hand-placed control points, given as distance from the true location:

| | RMS | median | max |
|---|---|---|---|
| Original georeferencing | 225 m | 233 m | 277 m |
| Global similarity (TIGER) | 44 m | 31 m | 124 m |
| Similarity + smooth field (TIGER) | 42 m | 29 m | 122 m |
| Similarity + smooth field (OSM, before the per-cell search was added) | 42 m | 26 m | 115 m |
| Hand points predicting each other (leave one out) | 42 m | 29 m | 133 m |

- **Most of the error is global.** The original placement is off by a near-uniform ~220 m (120 m east, 183 m north) with a slight rotation. The automatic fit finds that without any human input: the coarse search lands within a few pixels of the final shift.
- **The local field helps only a little.** It is about as good at your points as your other points are when each is left out in turn. In that sense the automatic model is as good as the hand model away from the points it was built from.
- **What's left over** is mostly where the hand points and the linework disagree, and both are a few pixels (5 m each) of draughting width either way.
- **The worst point (#14)** is a slough junction in the San Mateo marshes, with no roads within kilometres. Only hydrography could pin it; see below.
- **The next-worst (#8)** may be a misplaced hand point. It is also the one the other hand points predict worst.

## Results: USGS Portland 1897, 1:62,500

The sheet runs west of its nominal 7.5′ frame to take in the Willamette–Columbia confluence. Run it with `--whole-image`, or the neatline guess crops off that strip. These results use TIGER (Multnomah, Clark, Washington and Clackamas roads, plus rails), compared against 119 hand-placed control points:

| | RMS | median | max |
|---|---|---|---|
| Original georeferencing | 226 m | 219 m | 322 m |
| Global similarity | 42 m | 30 m | 126 m |
| Similarity + gradient-only field (no per-cell search) | 40 m | 26 m | 130 m |
| Similarity + per-cell search + field | 33 m | 24 m | 94 m |
| Hand points predicting each other (leave one out) | 32 m | 25 m | 74 m |

- **Global fit:** the drawing sits about 180 m west and 125 m south of where the original georeferencing puts its features. The hand points say 186 m and 122 m. That is the same direction and size as the Haywards error.
- **Without the per-cell search:** downtown's small blocks were fine. The misses were in St. Johns and University Park. There the drawn grid is offset about 70 m (about one block) from the global fit, and the gradient-only field stopped half a block short.
- **With it:** 14 hand points improve by more than 20 m and none get worse by that much. The worst remaining points, 13 and 14 near St. Johns, are also the ones the other hand points predict worst.

## Results: USGS East Denver 1890, 1:125,000

There are no hand-placed points for this sheet, so there is no score. This is a 30′ sheet at about 10.6 m per pixel. Run with `--search 1500` in case the error is larger at this scale, and with TIGER roads for the eight counties it touches, plus rails.

- **Global fit:** the drawing sits about 370 m east and 120 m north of where the original georeferencing puts its features, with a 0.17° rotation. That is larger than the two West Coast sheets and in roughly the opposite direction.
- **Spot checks:** after the full correction, modern railroads sit on the drawn ones at Brighton, Box Elder, Magnolia, Petersburg and the downtown yards.
- **One visible miss:** Brighton's east–west road lies about 125 m north of the drawn one. It might be a mapping error on the old sheet or a road that has since moved.

## Results: USGS Los Angeles 1894, 1:62,500

There are no hand-placed points for this sheet, so there is no score. This is a double-width sheet (30′ × 15′, 9692 × 6254 px), run with TIGER roads for Los Angeles County plus rails.

- **Global fit:** the drawing sits about 210 m west and 165 m south of where the original georeferencing puts its features, with essentially no rotation and a 0.14% scale change. That is the same direction as Haywards and Portland, a little larger.
- **Spot checks:** after the full correction, railroads line up at Burbank, Pasadena, San Gabriel / Mission, Puente, Home Junction and along the Los Angeles River downtown. Major roads line up at Santa Monica and Hollywood.
- **Gaps:** many 1894 lines, like Glendale's railroad, are gone from TIGER. OSM's abandoned-railway tags would add some of them back.

## Results: Woodward & Gamble, Map of the City of Oakland, 1888

This is a photographed wall map with coloured parcels on orange-tan paper. It is not a USGS sheet. The input was a rubbersheet export placed with two control points, so its only georeferencing was a shift, rotation and scale. It needed four things the USGS sheets didn't:

- **`--ink relative`:** judges ink against the local paper colour instead of fixed thresholds. Black ink darkens red, green and blue in about the same proportion; red tints and blue ink don't.
- **`--highpass 200`:** scores closeness to ink relative to the surrounding 200 m. Otherwise the fit shrank the map to 61%, because pulling every vector into the dense downtown ink (block numbers, parcel lines) scores well.
- **Global scale and rotation limits:** ±10% and ±5°, kept as soft penalties. A hard-bounded Powell search landed in a worse optimum on Portland.
- **`--downsample 2`:** the scan is 3 m/px. The export stays full size.

With those, the global fit leaves the two-point placement almost alone: 0.2% scale, 0.2° rotation, about 40 m of shift. The local field adds up to ~100 m, growing toward Alameda, Fruitvale and East Oakland, where the two points give no control. Side-by-side crops show modern streets sitting on the drawn ones there after correction, and not before. Downtown, Berkeley and Emeryville were already about right.

## Results: Wackenreuder, City and County of San Francisco, 1861

This is a photographed map with fine brown-black street lines on yellow paper and colour washes. Like Oakland, the input was a two-point rubbersheet placement, run with `--whole-image --ink relative --highpass 200`.

- **What went wrong first:** the paper-relative ink test found the streets, but the lettering filter threw almost all of them away. The hand-drawn lines break at nearly every crossing, so no single piece was 500 m long. Paper-relative ink now bridges 2-pixel gaps when measuring pieces, keeping only the original ink pixels. Before the fix, the fit locked onto noise and moved the map 600 m.
- **After the fix:** the fit adds a 1.2% scale change and ~40 m of shift to the two-point placement, plus up to ~55 m of local correction.
- **Spot checks:** in side-by-side crops, Potrero's grid moves onto the modern streets, and North Beach and the Western Addition improve. Downtown, near one of the two points, stays where it was. The Presidio and the southern ranchos have too little matching linework to judge.

## Next steps

- **Hydrography.** Extract the blue ink and match it against OSM waterways or NHD flowlines. That would cover marsh and bay margins like #14's, as long as the channel is natural and hasn't been rerouted since.
- **Contours against a DEM.** Match the brown linework against contours generated from modern elevation data (3DEP, or Terrarium tiles). Hills don't move, and the eastern third of this sheet is all hills with few roads.
- **Into the app.** Every step here is simple enough for the browser. Distance transforms, a grid search and L-BFGS on a few thousand unknowns are all fine in JS. Overpass and the OSM API both allow cross-origin requests. An "auto-align" button could propose control points for the user to accept, edit or reject.
- **Aerial photos.** Matching against vectors needs extracted linework. For old aerials, the counterpart is road segmentation, which is now a standard task for learned models. Alternatively, learned dense matchers can match old aerials directly against modern orthoimagery.
