# Automatic alignment prototype

An experiment, not part of the site: does matching a georeferenced scan's black linework against modern road and rail vectors find its georeferencing error? It loosely follows Chiang, Knoblock, Duan et al.'s work on aligning USGS historical topographic maps with road vector data.

`autoalign.py` takes a GeoTIFF that is already roughly georeferenced (a USGS historical topo, say) and works out where it really belongs:

1. It extracts the black linework (roads, railroads, town grids). These are pixels darker than the paper around them and redder than green after averaging over nearby ink. That leaves out brown contours, blue drainage, shorelines and marsh hatching. Lettering and dots are dropped as small connected components.
2. It projects TIGER/Line or OpenStreetMap roads and railroads into the image using the file's own georeferencing (`georef.mjs` uses rubbersheet's TIFF reader and projections). It leaves out freeways, ramps, service roads and paths, which are almost always later additions. Railroads are weighted 3×.
3. It fits a global similarity (shift, rotation, scale) that lays the vectors on the linework, by maximising a truncated chamfer score, mean exp(−d²/2σ²), where d is the distance to the nearest ink. Modern roads that aren't on the old map score near zero wherever they land, so they add noise but don't pull the fit. The search runs coarse to fine: a grid search over shifts within ±600 m, then Powell over all four parameters.
4. It fits a smooth local offset field on a grid of nodes (1.5 km apart by default) to all vector points at once, with L-BFGS, plus a penalty on the field's curvature.
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
| Similarity + smooth field (OSM) | 42 m | 26 m | 115 m |
| Hand points predicting each other (leave one out) | 42 m | 29 m | 133 m |

- **Most of the error is global.** The original placement is off by a near-uniform ~220 m (120 m east, 183 m north) with a slight rotation. The automatic fit finds that without any human input: the coarse search lands within a few pixels of the final shift.
- **The local field helps only a little.** It is about as good at your points as your other points are when each is left out in turn. In that sense the automatic model is as good as the hand model away from the points it was built from.
- **What's left over** is mostly where the hand points and the linework disagree, and both are a few pixels (5 m each) of draughting width either way.
- **The worst point (#14)** is a slough junction in the San Mateo marshes, with no roads within kilometres. Only hydrography could pin it; see below.
- **The next-worst (#8)** may be a misplaced hand point. It is also the one the other hand points predict worst.

## Results: USGS Portland 1897, 1:62,500

There are no hand-placed points for this sheet, so there is no score. The sheet runs west of its nominal 7.5′ frame to take in the Willamette–Columbia confluence. Run it with `--whole-image`, or the neatline guess crops off that strip. With TIGER (Multnomah, Clark, Washington and Clackamas roads, plus rails):

- **Global fit:** the drawing sits about 180 m west and 125 m south of where the original georeferencing puts its features, with a 0.08° rotation and a 0.15% scale change. That is the same direction and size as the Haywards error.
- **Robustness:** the result is the same to within a pixel or two whether or not the western strip is included.
- **Spot checks:** the corrected railroads and major roads sit on the drawn ones.

## Next steps

- **Hydrography.** Extract the blue ink and match it against OSM waterways or NHD flowlines. That would cover marsh and bay margins like #14's, as long as the channel is natural and hasn't been rerouted since.
- **Contours against a DEM.** Match the brown linework against contours generated from modern elevation data (3DEP, or Terrarium tiles). Hills don't move, and the eastern third of this sheet is all hills with few roads.
- **Into the app.** Every step here is simple enough for the browser. Distance transforms, a grid search and L-BFGS on a few thousand unknowns are all fine in JS. Overpass and the OSM API both allow cross-origin requests. An "auto-align" button could propose control points for the user to accept, edit or reject.
- **Aerial photos.** Matching against vectors needs extracted linework. For old aerials, the counterpart is road segmentation, which is now a standard task for learned models. Alternatively, learned dense matchers can match old aerials directly against modern orthoimagery.
