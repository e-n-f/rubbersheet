#!/usr/bin/env python3
"""Download OpenStreetMap roads and railways (including abandoned ones) for a
bounding box from the main OSM API, in tiles, as JSON for autoalign.py.

    python3 fetch_osm.py WEST SOUTH EAST NORTH out.json

Overpass would be the usual way to do this; the OSM API is used because it's
reachable from more places. Tiles that hit the API's node limit are split.
Please keep boxes county-sized or smaller: it's a shared editing API.
"""

import json
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

KEEP = ('highway', 'railway', 'abandoned:railway', 'disused:railway', 'historic:railway')


def main():
    W, S, E, N = map(float, sys.argv[1:5])
    out = sys.argv[5]
    nodes, ways = {}, {}

    def get(w, s, e, n, depth=0):
        url = f'https://api.openstreetmap.org/api/0.6/map?bbox={w:.5f},{s:.5f},{e:.5f},{n:.5f}'
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'rubbersheet-autoalign-prototype'})
                data = urllib.request.urlopen(req, timeout=180).read()
                break
            except urllib.error.HTTPError as ex:
                if ex.code in (400, 509) and depth < 6:
                    # Too many nodes: split in four.
                    mx, my = (w + e) / 2, (s + n) / 2
                    for b in [(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)]:
                        get(*b, depth=depth + 1)
                    return
                print('error', ex.code, url, file=sys.stderr)
                time.sleep(2 ** attempt)
            except Exception as ex:
                print('error', ex, file=sys.stderr)
                time.sleep(2 ** attempt)
        else:
            return
        for el in ET.fromstring(data):
            if el.tag == 'node':
                nodes[el.get('id')] = (float(el.get('lon')), float(el.get('lat')))
            elif el.tag == 'way':
                tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
                if any(k in tags for k in KEEP):
                    keep = {k: tags[k] for k in KEEP + ('name',) if k in tags}
                    ways[el.get('id')] = (keep, [nd.get('ref') for nd in el.findall('nd')])
        print(f'{w:.3f},{s:.3f}: {len(ways)} ways so far', file=sys.stderr)

    step = 0.04
    y = S
    while y < N:
        x = W
        while x < E:
            get(x, y, min(x + step, E), min(y + step, N))
            x += step
        y += step
    res = []
    for wid, (tags, refs) in ways.items():
        pts = [nodes[r] for r in refs if r in nodes]
        if len(pts) >= 2:
            res.append({'id': wid, 'tags': tags, 'pts': pts})
    json.dump(res, open(out, 'w'))
    print(f'{len(res)} ways', file=sys.stderr)


if __name__ == '__main__':
    main()
