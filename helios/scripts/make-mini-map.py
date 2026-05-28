#!/usr/bin/env python3
"""Build per-site mini-map basemaps for the visitor-scans thumbnails.

Generates ONE PNG per retail site, each covering a ~2-mile-radius
neighborhood box centered on the store. The PNGs are committed to
helios/src/client/assets/ and referenced by MiniGeoMarker.tsx — the
component chooses the right basemap (and matching BOUNDS) based on
which site the scan came from.

Usage:
  python3 make-mini-map.py <out-dir>

Writes:
  <out-dir>/nyc-bx-mini-map.png
  <out-dir>/nyc-mh-mini-map.png

Also prints, on stdout, the bbox + display-size constants the
component must use, so the JS side stays in lock-step with the
asset.
"""
import math
import sys
import urllib.request
from io import BytesIO

from PIL import Image, ImageEnhance

# (siteSlug, center lat, center lng). Coords copied from
# helios/src/server/db/queries/customersMapQueries.ts.
SITES = [
    ('bx', 40.86494, -73.88488),
    ('mh', 40.76232, -73.97661),
]

# ~2 miles radius. We use a slightly generous buffer (2.25 mi) so the
# store dot doesn't sit at the very edge of the basemap when the scan
# happens at the device's exact GPS.
RADIUS_MI = 2.25
KM_PER_MILE = 1.60934
RADIUS_KM = RADIUS_MI * KM_PER_MILE  # ≈ 3.62 km

# OSM zoom level — z=13 gives one tile ≈ 3.7 km wide at lat 40.8, so
# a 4.5-km-diameter bbox fits comfortably in 2×2 tiles.
Z = 13
TILE = 256

# Final raster size. 480×480 is enough resolution for the desktop
# 64×44 thumbnail (8× downsample) and the mobile expanded card view
# (~200–260px wide, 2× downsample) without obvious pixelation.
TARGET_W = 480
TARGET_H = 480


def lng_per_degree_km(lat_deg: float) -> float:
    return 111.32 * math.cos(math.radians(lat_deg))


def tile_xy(lat: float, lng: float, z: int) -> tuple[float, float]:
    """Fractional tile coordinates (units of tiles)."""
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return x, y


def build_basemap(center_lat: float, center_lng: float) -> tuple[Image.Image, dict]:
    # Convert the km radius into a degree-bbox at this latitude.
    delta_lat = RADIUS_KM / 111.32
    delta_lng = RADIUS_KM / lng_per_degree_km(center_lat)

    min_lat = center_lat - delta_lat
    max_lat = center_lat + delta_lat
    min_lng = center_lng - delta_lng
    max_lng = center_lng + delta_lng

    # Fractional tile coords of the bbox corners.
    x_left, y_top = tile_xy(max_lat, min_lng, Z)  # top-left
    x_right, y_bot = tile_xy(min_lat, max_lng, Z)  # bottom-right

    tx0 = int(math.floor(x_left))
    ty0 = int(math.floor(y_top))
    tx1 = int(math.floor(x_right - 1e-9))
    ty1 = int(math.floor(y_bot - 1e-9))

    tiles_w = tx1 - tx0 + 1
    tiles_h = ty1 - ty0 + 1

    # Stitch tiles into a single canvas at native resolution.
    canvas = Image.new('RGB', (tiles_w * TILE, tiles_h * TILE), (220, 220, 220))
    opener = urllib.request.build_opener()
    opener.addheaders = [
        ('User-Agent', 'helios-build/1.0 (https://github.com/freshlybakednyc/automation)'),
    ]
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = f'https://tile.openstreetmap.org/{Z}/{tx}/{ty}.png'
            print(f'    fetch {url}', file=sys.stderr)
            tile_img = Image.open(BytesIO(opener.open(url, timeout=20).read())).convert('RGB')
            canvas.paste(tile_img, ((tx - tx0) * TILE, (ty - ty0) * TILE))

    # Bbox pixel rectangle inside the stitched canvas.
    left = (x_left - tx0) * TILE
    right = (x_right - tx0) * TILE
    top = (y_top - ty0) * TILE
    bot = (y_bot - ty0) * TILE
    cropped = canvas.crop((int(round(left)), int(round(top)), int(round(right)), int(round(bot))))
    resized = cropped.resize((TARGET_W, TARGET_H), Image.LANCZOS)

    # Mild desaturation + lift brightness so the marker dot pops.
    resized = ImageEnhance.Color(resized).enhance(0.55)
    resized = ImageEnhance.Brightness(resized).enhance(1.08)
    resized = ImageEnhance.Contrast(resized).enhance(0.9)

    meta = {
        'min_lat': min_lat, 'max_lat': max_lat,
        'min_lng': min_lng, 'max_lng': max_lng,
        'center_lat': center_lat, 'center_lng': center_lng,
        'tile_zoom': Z,
        'final_size': (TARGET_W, TARGET_H),
    }
    return resized, meta


def main() -> None:
    if len(sys.argv) != 2:
        print('usage: make-mini-map.py <out-dir>', file=sys.stderr)
        sys.exit(2)
    out_dir = sys.argv[1]
    for slug, lat, lng in SITES:
        print(f'\n=== {slug} (center {lat}, {lng}) ===', file=sys.stderr)
        img, meta = build_basemap(lat, lng)
        out_path = f'{out_dir}/nyc-{slug}-mini-map.png'
        # Quantize to 128-color palette for a small final PNG.
        pal = img.convert('P', palette=Image.ADAPTIVE, colors=128)
        pal.save(out_path, 'PNG', optimize=True)
        print(f'wrote {out_path}', file=sys.stderr)
        print(
            f'  bbox: {meta["min_lat"]:.6f}..{meta["max_lat"]:.6f} lat, '
            f'{meta["min_lng"]:.6f}..{meta["max_lng"]:.6f} lng'
        )


if __name__ == '__main__':
    main()
