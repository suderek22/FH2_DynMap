"""Decode Storm Island's map and generate its Leaflet tile pyramid and metadata."""
import argparse
import json
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

from xgdetile import detile, decode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    profile = ET.parse(args.profile)
    symbol = next(s for s in profile.findall(".//Symbolizer")
                  if s.find("Texture") is not None and "\\high.png" in s.find("Texture").get("value"))
    cols = int(symbol.find("Tiles").get("horizontal"))
    rows = int(symbol.find("Tiles").get("vertical"))
    world_height = float(symbol.find("Size").get("value"))
    x0 = float(symbol.find("Offset").get("x"))
    z0 = float(symbol.find("Offset").get("z"))
    w, h = cols * 1024, rows * 1024
    image = np.empty((h, w, 3), dtype=np.uint8)
    with zipfile.ZipFile(args.archive) as archive:
        for row in range(rows):
            for col in range(cols):
                raw = archive.read(f"Map/high-{row}-{col}.swatchbin")
                if len(raw) != 83 + 1024 * 1024:
                    raise ValueError("Unexpected BC7 tile size")
                linear = detile(raw[83:], 1024, 1024, 14)
                if linear is None:
                    raise RuntimeError("Cannot detile Island map")
                image[row * 1024:(row + 1) * 1024, col * 1024:(col + 1) * 1024] = decode(linear, 1024, 1024)[..., 2::-1]
        low = detile(archive.read("Map/low-0-0.swatchbin")[83:], w // 2, h // 2, 14)
        if low is None:
            raise RuntimeError("Cannot detile Island low-resolution reference")
        reference = decode(low, w // 2, h // 2)[..., 2::-1]
    img = Image.fromarray(image)
    small = np.asarray(img.resize((w // 2, h // 2), Image.Resampling.BILINEAR), dtype=float)
    error = float(np.abs(small - reference).mean())
    print(f"High/low map alignment error: {error:.2f}")
    if error > 15:
        raise ValueError("Map tiles do not match low-resolution reference")
    img = img.transpose(Image.Transpose.ROTATE_90)
    args.output.mkdir(parents=True, exist_ok=True)
    for zoom in range(5, -1, -1):
        scale = 2 ** (5 - zoom)
        level = img if scale == 1 else img.resize((img.width // scale, img.height // scale), Image.Resampling.LANCZOS)
        target = args.output / "tiles" / str(zoom)
        target.mkdir(parents=True, exist_ok=True)
        for x in range((level.width + 255) // 256):
            for y in range((level.height + 255) // 256):
                # Pad boundary tiles to Leaflet's 256-pixel tile size.
                level.crop((x * 256, y * 256, (x + 1) * 256, (y + 1) * 256)).save(target / f"{x}_{y}.jpg", quality=85)
    factor = h / world_height
    metadata = {"width": w, "height": h, "nativeZoom": 5, "rotation": "left",
                "calib": {"ax": factor, "bx": -x0 * factor, "az": -factor, "bz": (z0 + world_height) * factor},
                "landmarks": []}
    (args.output / "map.json").write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf8")
    print(metadata)


if __name__ == "__main__":
    main()
