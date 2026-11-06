import http.server, json, math, time, os, sys
from urllib.parse import urlsplit, parse_qs
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cal = {"ax": 0.342617167, "bx": 2555.30502, "az": -0.343337966, "bz": 327.298182}
with open(os.path.join(ROOT, "maps", "island", "map.json"), encoding="utf8") as f:
    calibrations = {"anthem": cal, "island": json.load(f)["calib"]}
t0 = time.time()
active_map = os.environ.get("DYNMAP_MOCK_MAP", "anthem")
if active_map not in calibrations:
    raise ValueError("DYNMAP_MOCK_MAP must be anthem or island")


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        query = parse_qs(urlsplit(self.path).query)
        map_id = query.get("map", ["anthem"])[0]
        if self.path.startswith("/api/") and map_id not in calibrations:
            self.send_error(400, "Unknown map")
            return
        if self.path.startswith("/api/state"):
            t = time.time() - t0
            center_x = 9400 if active_map == "island" else 3700
            x, z = center_x + 800 * math.cos(t / 20), -2500 + 500 * math.sin(t / 20)
            pl = [{"id": 1, "name": "suderek22", "car": "LAM_Huracan_14", "x": x, "y": 0, "z": z, "speed": 38.0, "host": True, "wb": 5}]
            for i in range(2, 8):
                a = t / (12 + i) + i
                pl.append({"id": i, "name": "AI Driver %d" % i, "car": "PLY_Car_%d" % i, "x": center_x + (300 + 120 * i) * math.cos(a), "y": 0,
                           "z": -2500 + (200 + 60 * i) * math.sin(a), "speed": 20.0 + 5 * i, "ai": True, "wb": i})
            body = json.dumps({"version": "mock", "session": "local", "calib": calibrations[map_id],
                               "activeMap": active_map, "players": pl if map_id == active_map else []}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
        elif self.path.startswith("/api/calib"):
            try:
                new_cal = {key: float(query[key][0]) for key in ("ax", "bx", "az", "bz")}
                if not all(math.isfinite(v) for v in new_cal.values()) or not new_cal["ax"] or not new_cal["az"]:
                    raise ValueError("Invalid calibration")
            except (KeyError, ValueError) as e:
                self.send_error(400, str(e))
                return
            calibrations[map_id] = new_cal
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.end_headers(); self.wfile.write(b'{"ok":true}')
        elif self.path.startswith("/favicon"):
            self.path = "/icons/pin_car.png"; super().do_GET()
        else:
            super().do_GET()


http.server.ThreadingHTTPServer(("127.0.0.1", 8091), H).serve_forever()
