"""Export roads from a NAV file to roads.json with road class, joined at junctions,
and route speed zones along the road graph into web\\data\\overlays.json.

NAV header supplies section counts. Nodes are 40 bytes at offset 148, followed by
6-word road records (col1 = end in node-index list, col3 = end in property tokens),
a node-index list, 16-byte links, two token arrays, string offsets and key/value strings.
"""
import json, os, heapq, argparse, struct
from collections import Counter
import numpy as np
from scipy.spatial import cKDTree

F = r"E:\forza2port_win\game\Anthem_1.0.0.64_x64__8wekyb3d8bbwe\Mount\media\tracks\anthem\ribbon_00\anthem_00.nav"
OUT = r"E:\forza2port_win\project_data\Forza\DynMap\web\data"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--nav", default=F)
parser.add_argument("--output-dir", default=OUT)
args = parser.parse_args()
F, OUT = args.nav, args.output_dir
d = open(F, "rb").read()
header = struct.unpack("<37I", d[:148])
N, road_count, index_count, link_count, token_count, key_count, value_count = header[22:29]
fl = np.frombuffer(d[148:148 + N * 40], dtype="<f4").reshape(N, 10)
P = fl[:, [0, 2]].astype(float)
t = np.frombuffer(d[148 + N * 40:], dtype="<u4").astype(np.int64)
R = t[:(road_count - 1) * 6].reshape(road_count - 1, 6)
list_word = (road_count - 1) * 6 + 3
L = t[list_word::2][:index_count]
token_start = 148 + N * 40 + list_word * 4 + index_count * 8 + link_count * 16
if struct.unpack_from("<I", d, token_start + 4)[0] == 0x3F3F3F3F:
    token_start += 8
tok = np.frombuffer(d[token_start:token_start + token_count * 8], dtype="<u4").reshape(-1, 2)[:, 0].astype(int)
string_start = token_start + token_count * 16 + (key_count + value_count + 1) * 8
string_start = d.find(b"ai_disabled\x00", string_start - 16, string_start + 32)
if string_start < 0:
    raise ValueError("Unsupported NAV property-string table")
keys = d[string_start:].split(b"\x00")[:key_count]
value_start = (string_start + sum(len(k) + 1 for k in keys) + 7) // 8 * 8
V = [x.decode("latin1") for x in d[value_start:value_start + header[30]].split(b"\x00")[:value_count]]
key_ids = {k.decode("ascii"): i for i, k in enumerate(keys)}

starts = [0] + R[:, 1].tolist() + [len(L)]
tstarts = [0] + R[:, 3].tolist() + [len(tok)]


def cls(name):
    n = name.split("_")[0]
    return {"freeway": "f", "a": "a", "b": "b", "dirt": "d"}.get(n)


roads = []
for k in range(road_count):
    seg = L[starts[k]:starts[k + 1]]
    seg = seg[seg < N]
    if len(seg) < 2:
        continue
    tk = tok[tstarts[k]:tstarts[k + 1]]
    rt = pf = nm = None
    for i in range(0, len(tk) - 1, 2):
        if tk[i] == key_ids["road_type"]:
            rt = V[tk[i + 1]]
        elif tk[i] == key_ids["profile_name"]:
            pf = V[tk[i + 1]]
        elif tk[i] == key_ids["display_name"]:
            nm = V[tk[i + 1]]
    c = cls(rt or "") or cls(pf or "")
    if not c and nm:
        c = "d" if "dirt" in nm else "f" if "freeway" in nm else None
    c = c or "n"
    roads.append((c, seg))

pieces = []
for c, seg in roads:
    cur = [seg[0]]
    for a, b in zip(seg[:-1], seg[1:]):
        if np.hypot(*(P[a] - P[b])) < 45:
            cur.append(b)
        else:
            if len(cur) > 1:
                pieces.append((c, cur))
            cur = [b]
    if len(cur) > 1:
        pieces.append((c, cur))

adj = {}
for c, seg in pieces:
    for a, b in zip(seg[:-1], seg[1:]):
        w = float(np.hypot(*(P[a] - P[b])))
        adj.setdefault(int(a), []).append((int(b), w))
        adj.setdefault(int(b), []).append((int(a), w))
used = np.array(sorted(adj))
tree = cKDTree(P[used])
JOIN = 28.0
for i, j in tree.query_pairs(JOIN):
    a, b = int(used[i]), int(used[j])
    if any(x[0] == b for x in adj[a]):
        continue
    w = float(np.hypot(*(P[a] - P[b])))
    adj[a].append((b, w))
    adj[b].append((a, w))


def rd(v):
    return int(round(v))


out = []
for c, seg in pieces:
    segset = set(map(int, seg))
    pts = P[seg]
    ends = []
    for idx in (0, -1):
        n = int(seg[idx])
        near = [int(used[q]) for q in tree.query_ball_point(P[n], JOIN)]
        near = [q for q in near if q not in segset]
        ends.append(P[min(near, key=lambda q: np.hypot(*(P[q] - P[n])))] if near else None)
    if ends[0] is not None:
        pts = np.vstack([ends[0], pts])
    if ends[1] is not None:
        pts = np.vstack([pts, ends[1]])
    keep = [0]
    for i in range(1, len(pts) - 1):
        if np.hypot(*(pts[i] - pts[keep[-1]])) >= 8:
            keep.append(i)
    keep.append(len(pts) - 1)
    flat = []
    for i in keep:
        flat += [rd(pts[i][0]), rd(pts[i][1])]
    out.append([c] + flat)
os.makedirs(OUT, exist_ok=True)
json.dump(out, open(os.path.join(OUT, "roads.json"), "w"), separators=(",", ":"))
print(len(out), "pieces", Counter(o[0] for o in out), os.path.getsize(os.path.join(OUT, "roads.json")), "bytes")


def route(a, b):
    sa = int(used[tree.query(a)[1]])
    sb = int(used[tree.query(b)[1]])
    dist = {sa: 0.0}
    prev = {}
    pq = [(0.0, sa)]
    while pq:
        dd, u = heapq.heappop(pq)
        if u == sb:
            break
        if dd > dist.get(u, 1e18):
            continue
        for v, w in adj[u]:
            nd = dd + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if sb not in dist:
        return None
    path = [sb]
    while path[-1] != sa:
        path.append(prev[path[-1]])
    return path[::-1]


ov = json.load(open(os.path.join(OUT, "overlays.json")))
for z in ov["zones"]:
    a, b = np.array(z["a"], float), np.array(z["b"], float)
    path = route(a, b)
    if path is None or len(path) < 2:
        z["path"] = None
        print("no route", z["id"])
        continue
    pts = [a] + [P[n] for n in path] + [b]
    z["path"] = [rd(v) for p in pts for v in p]
    print(z["id"], "straight", rd(np.hypot(*(a - b))), "route len", rd(sum(np.hypot(*(pts[i] - pts[i + 1])) for i in range(len(pts) - 1))))
json.dump(ov, open(os.path.join(OUT, "overlays.json"), "w"), separators=(",", ":"))
