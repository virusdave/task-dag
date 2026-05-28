#!/usr/bin/env python3
"""Build a single static OSM thumbnail of the NYC-metro bbox used by
MiniGeoMarker.tsx, shipped as a committed PNG asset.

BOUNDS (mirrored from helios/src/client/routes/visitors/MiniGeoMarker.tsx):
  minLat: 40.35, maxLat: 41.05, minLng: -74.35, maxLng: -73.45

Output: helios/src/client/assets/nyc-mini-map.png at ~320x220 for crisp
display at the 64x44 thumbnail rendering size (covers 1x, 2x, 3x DPI).
"""
import math
import urllib.request
import sys
from io import BytesIO
from PIL import Image

MIN_LAT = 40.35
MAX_LAT = 41.05
MIN_LNG = -74.35
MAX_LNG = -73.45
Z = 10
TILE = 256
TARGET_W = 320
TARGET_H = 220
OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else 'nyc-mini-map.png'

def tile_xy(lat, lng, z):
    """Returns FRACTIONAL tile coords (units of tiles, not pixels)."""
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n
    return x, y

# Fractional tile coords (units of TILE, not pixels).
x_min_t, y_max_t = tile_xy(MAX_LAT, MIN_LNG, Z)  # top-left
x_max_t, y_min_t = tile_xy(MIN_LAT, MAX_LNG, Z)  # bottom-right
left_t = min(x_min_t, x_max_t)
right_t = max(x_min_t, x_max_t)
top_t = min(y_max_t, y_min_t)
bot_t = max(y_max_t, y_min_t)

# Whole-tile range that covers the bbox.
tx0 = int(math.floor(left_t))
ty0 = int(math.floor(top_t))
tx1 = int(math.floor(right_t - 1e-9))
ty1 = int(math.floor(bot_t - 1e-9))

# In the stitched canvas, the bbox occupies these pixel coordinates.
left = (left_t - tx0) * TILE
right = (right_t - tx0) * TILE
top = (top_t - ty0) * TILE
bot = (bot_t - ty0) * TILE

tiles_w = tx1 - tx0 + 1
tiles_h = ty1 - ty0 + 1
print(f"bbox px (z={Z}): left={left:.1f} top={top:.1f} right={right:.1f} bot={bot:.1f}", file=sys.stderr)
print(f"tile range: x={tx0}..{tx1} ({tiles_w} cols), y={ty0}..{ty1} ({tiles_h} rows) = {tiles_w*tiles_h} tiles", file=sys.stderr)

canvas = Image.new('RGB', (tiles_w * TILE, tiles_h * TILE), (200, 200, 200))
opener = urllib.request.build_opener()
opener.addheaders = [('User-Agent', 'helios-build/1.0 (https://github.com/freshlybakednyc/automation)')]

for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        url = f'https://tile.openstreetmap.org/{Z}/{tx}/{ty}.png'
        print(f'fetch {url}', file=sys.stderr)
        req = opener.open(url, timeout=20)
        tile_img = Image.open(BytesIO(req.read())).convert('RGB')
        canvas.paste(tile_img, ((tx - tx0) * TILE, (ty - ty0) * TILE))

# crop to bbox pixel rectangle, in the canvas's local pixel space.
crop_box = (int(round(left)), int(round(top)), int(round(right)), int(round(bot)))
print(f'crop {crop_box}', file=sys.stderr)
cropped = canvas.crop(crop_box)

# downscale to target, preserving the bbox aspect ratio. The MiniGeoMarker
# SVG (64x44) will stretch the asset with preserveAspectRatio="none"; the
# linear lat/lng→pixel projection used for the dot is consistent with that
# stretch, so the dot lands in the right relative spot even when the
# image is squished slightly from its bbox-native aspect.
resized = cropped.resize((TARGET_W, TARGET_H), Image.LANCZOS)

# Mildly desaturate + lift brightness so the dot pops against the base.
from PIL import ImageEnhance
resized = ImageEnhance.Color(resized).enhance(0.55)
resized = ImageEnhance.Brightness(resized).enhance(1.08)
resized = ImageEnhance.Contrast(resized).enhance(0.9)

resized.save(OUT_PATH, 'PNG', optimize=True)
print(f'wrote {OUT_PATH} ({resized.size[0]}x{resized.size[1]})', file=sys.stderr)
