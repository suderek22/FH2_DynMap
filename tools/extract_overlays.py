"""Extract speed cameras / speed zones from the game's GameObjs.xml into web\\data\\overlays.json (world metres)."""
import json
import os
import re
import argparse
from collections import defaultdict

G = r"E:\forza2port_win\game\Anthem_1.0.0.64_x64__8wekyb3d8bbwe\Mount\media\tracks\anthem\ribbon_00\GameObjs.xml"
OUT = r"E:\forza2port_win\project_data\Forza\DynMap\web\data\overlays.json"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--gameobjs", default=G)
parser.add_argument("--output", default=OUT)
args = parser.parse_args()
G, OUT = args.gameobjs, args.output

t = open(G, encoding="utf8", errors="ignore").read()
objs = re.findall(r'<Obj GameplayID="([^"]+)">\s*<Pos value="([^"]+)"', t)
cam, zone = defaultdict(list), defaultdict(lambda: defaultdict(list))
for name, pos in objs:
    x, _, z = (float(v) for v in pos.split(","))
    m = re.match(r"(?:PDLC_)?SPEEDCAMERAZONE_(\d+)([AB])_(LEFT|RIGHT)$", name)
    if m:
        zone[m.group(1)][m.group(2)].append((x, z))
        continue
    m = re.match(r"(?:PDLC_)?SPEEDCAMERA_(\d+)_(LEFT|RIGHT)$", name)
    if m:
        cam[m.group(1)].append((x, z))


def mean(p):
    return [round(sum(a for a, _ in p) / len(p)), round(sum(b for _, b in p) / len(p))]


cameras = [{"id": int(k), "p": mean(v)} for k, v in sorted(cam.items())]
zones = [{"id": int(k), "a": mean(v["A"]), "b": mean(v["B"])} for k, v in sorted(zone.items()) if "A" in v and "B" in v]
print(len(cameras), "cameras,", len(zones), "zones")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"cameras": cameras, "zones": zones}, open(OUT, "w"), separators=(",", ":"))
