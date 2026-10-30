"""Public OSM GPS traces of the area (api trackpoints pages) as JSON fixes for the simulator: only driving ones."""
import glob
import json
import math
import os
import xml.etree.ElementTree as ET
from datetime import datetime

NS = {'g': 'http://www.topografix.com/GPX/1/0'}


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    return 2 * 6371000 * math.asin(math.sqrt(
        math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))


segments = {}
for f in sorted(glob.glob('data/traces-p*.gpx')):
    for trk in ET.parse(f).getroot().findall('g:trk', NS):
        url = trk.find('g:url', NS)
        for n, seg in enumerate(trk.findall('g:trkseg', NS)):
            key = url.text.rsplit('/', 1)[-1] if url is not None else f'anon{len(segments)}'
            pts = []
            for p in seg.findall('g:trkpt', NS):
                t = p.find('g:time', NS)
                if t is None:
                    continue
                ms = int(datetime.fromisoformat(t.text.replace('Z', '+00:00')).timestamp() * 1000)
                pts.append({'t': ms, 'lat': float(p.get('lat')), 'lon': float(p.get('lon'))})
            segments.setdefault(key, []).extend(pts)

os.makedirs('data/traces', exist_ok=True)
index = []
for key, pts in segments.items():
    if len(pts) < 60:
        continue
    pts.sort(key=lambda p: p['t'])
    dur = (pts[-1]['t'] - pts[0]['t']) / 1000
    dist = sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    gaps = sorted(pts[i + 1]['t'] - pts[i]['t'] for i in range(len(pts) - 1))
    kmh = dist / dur * 3.6 if dur > 0 else 0
    if gaps[len(gaps) // 2] > 5000 or kmh < 15:
        continue
    name = f'osm-{key}'
    with open(f'data/traces/{name}.json', 'w') as f:
        json.dump(pts, f)
    index.append({'name': name, 'label': f'OSM {key}: {dist / 1000:.1f} km, {kmh:.0f} km/h di media', 'file': f'{name}.json'})
    print(index[-1]['label'])
with open('data/traces/index.json', 'w') as f:
    json.dump(index, f)
