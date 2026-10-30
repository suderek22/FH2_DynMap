(function () {
  'use strict';
  var MAP_W = 7168, MAP_H = 4096, NATIVE_Z = 5;
  var $ = function (id) { return document.getElementById(id); };

  var cfg = Object.assign({ follow: true, trail: true, landmarks: true, roads: false, cams: true, zones: true, unit: 'kmh', bright: 100 },
    JSON.parse(localStorage.getItem('dynmap.cfg') || '{}'));
  function saveCfg() { localStorage.setItem('dynmap.cfg', JSON.stringify(cfg)); }

  var map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: 7, zoomSnap: 0.25, attributionControl: false });
  function toLL(px, py) { return map.unproject(L.point(px, py), NATIVE_Z); }
  function fromLL(ll) { var p = map.project(ll, NATIVE_Z); return { x: p.x, y: p.y }; }
  var bounds = L.latLngBounds(toLL(0, MAP_H), toLL(MAP_W, 0));
  L.tileLayer('tiles/{z}/{x}_{y}.jpg?v=3', { minZoom: 0, maxZoom: 7, maxNativeZoom: NATIVE_Z, tileSize: 256, noWrap: true, bounds: bounds }).addTo(map);
  map.setMaxBounds(bounds.pad(0.25));
  map.fitBounds(bounds);

  function applyBright() { document.querySelector('.leaflet-tile-pane').style.filter = 'brightness(' + cfg.bright / 100 + ')'; }

  var calib = { ax: 0.342617167, bx: 2555.30502, az: -0.343337966, bz: 327.298182 };
  function worldToPx(x, z) { return { x: calib.ax * x + calib.bx, y: calib.az * z + calib.bz }; }

  // landmarks
  function icon(name, w, h, ax, ay) { return L.icon({ iconUrl: 'icons/' + name + '.png', iconSize: [w, h], iconAnchor: [ax, ay], className: 'lm' }); }
  var landmarks = L.layerGroup();
  L.marker(toLL(4660, 2490), { icon: icon('pin_hf', 45, 60, 22, 59), title: 'Horizon Festival' }).addTo(landmarks);
  function applyLandmarks() { if (cfg.landmarks) landmarks.addTo(map); else map.removeLayer(landmarks); }

  // overlay layers built from the game's own data (world metres -> map pixels via the calibration)
  var roadsLayer = L.layerGroup(), camsLayer = L.layerGroup(), zonesLayer = L.layerGroup();
  var canvas = L.canvas({ padding: 0.3 });
  var roadData = null, ovData = null, builtFor = '';
  function wll(x, z) { var p = worldToPx(x, z); return toLL(p.x, p.y); }
  var ROAD_STYLE = {
    f: { color: '#fff08a', weight: 4, opacity: 0.95 },
    a: { color: '#ffffff', weight: 3, opacity: 0.85 },
    b: { color: '#ffffff', weight: 2, opacity: 0.7 },
    d: { color: '#f0906a', weight: 2, opacity: 0.9 }
  };
  function buildOverlays() {
    var key = [calib.ax, calib.bx, calib.az, calib.bz].join(',');
    if (key === builtFor) return;
    builtFor = key;
    roadsLayer.clearLayers(); camsLayer.clearLayers(); zonesLayer.clearLayers();
    if (roadData) roadData.forEach(function (c) {
      var pts = [];
      for (var i = 1; i < c.length; i += 2) pts.push(wll(c[i], c[i + 1]));
      var st = ROAD_STYLE[c[0]] || ROAD_STYLE.b;
      L.polyline(pts, { renderer: canvas, color: st.color, weight: st.weight, opacity: st.opacity, dashArray: st.dash, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(roadsLayer);
    });
    if (ovData) {
      ovData.cameras.forEach(function (c) {
        L.marker(wll(c.p[0], c.p[1]), { icon: icon('cam', 26, 26, 13, 13), title: 'Speed camera ' + c.id }).addTo(camsLayer);
      });
      ovData.zones.forEach(function (z) {
        var a = wll(z.a[0], z.a[1]), b = wll(z.b[0], z.b[1]), line = [];
        if (z.path) for (var i = 0; i < z.path.length; i += 2) line.push(wll(z.path[i], z.path[i + 1]));
        else line = [a, b];
        L.polyline(line, { color: '#35e6ff', weight: 4, opacity: 0.9, dashArray: '8 6', lineJoin: 'round' }).addTo(zonesLayer);
        [a, b].forEach(function (q, i) {
          L.marker(q, { icon: icon('cam_zone', 24, 24, 12, 12), title: 'Speed zone ' + z.id + (i ? ' end' : ' start') }).addTo(zonesLayer);
        });
      });
    }
  }
  function applyLayers() {
    [[cfg.roads, roadsLayer], [cfg.cams, camsLayer], [cfg.zones, zonesLayer]].forEach(function (e) {
      if (e[0]) e[1].addTo(map); else map.removeLayer(e[1]);
    });
  }
  Promise.all([
    fetch('data/roads.json').then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('data/overlays.json').then(function (r) { return r.json(); }).catch(function () { return null; })
  ]).then(function (r) { roadData = r[0]; ovData = r[1]; builtFor = ''; buildOverlays(); applyLayers(); });

  // players
  var players = {}, selected = null, lastList = [];
  var TRAIL_MS = 120000;
  var trails = {}; // id -> { pts: [[px, py, time]], line }
  // Colour by wristband tier (1 yellow ... 7 gold); white when the tier is unknown.
  var CLASS_COLORS = { 1: '#ffd400', 2: '#3ecf4a', 3: '#2f7bff', 4: '#ff5fb0', 5: '#ff8a1f', 6: '#9b4dff', 7: '#d4af37' };
  function playerColor(p) { return CLASS_COLORS[p.wb] || '#ffffff'; }
  function trailFor(p) {
    var t = trails[p.id];
    if (!t) t = trails[p.id] = { pts: [], line: L.polyline([], { weight: 3, opacity: 0.85 }).addTo(map) };
    t.line.setStyle({ color: playerColor(p) });
    return t;
  }
  function clearTrail(id) {
    var t = trails[id];
    if (t) { t.pts = []; t.line.setLatLngs([]); }
  }
  function pruneTrails() {
    var cut = Date.now() - TRAIL_MS;
    Object.keys(trails).forEach(function (id) {
      var t = trails[id], n = 0;
      while (n < t.pts.length && t.pts[n][2] < cut) n++;
      if (n) { t.pts.splice(0, n); t.line.setLatLngs(t.pts.map(function (q) { return toLL(q[0], q[1]); })); }
    });
  }
  setInterval(pruneTrails, 1000);

  function playerIcon() {
    return L.divIcon({ className: '', iconSize: [44, 44], iconAnchor: [22, 22],
      html: '<div class="me"><div class="ring"></div><img src="icons/arrow.png" style="width:22px;height:auto"><div class="tag"></div></div>' });
  }

  function fmtSpeed(ms) {
    var v = cfg.unit === 'mph' ? ms * 2.23694 : ms * 3.6;
    return Math.round(v);
  }

  function updatePlayer(p) {
    var pt = worldToPx(p.x, p.z), ll = toLL(pt.x, pt.y);
    var e = players[p.id];
    if (!e) {
      e = players[p.id] = { marker: L.marker(ll, { icon: playerIcon(), zIndexOffset: 1000 }).addTo(map), px: pt, heading: 0 };
    }
    var dx = pt.x - e.px.x, dy = pt.y - e.px.y;
    if (Math.hypot(dx, dy) > 0.6 && p.speed > 1) e.heading = Math.atan2(dx, -dy) * 180 / Math.PI;
    e.px = pt;
    e.marker.setLatLng(ll);
    var el = e.marker.getElement();
    if (el) {
      el.querySelector('img').style.transform = 'rotate(' + e.heading + 'deg)';
      el.querySelector('.tag').textContent = p.name;
    }
    e.data = p;
    var col = playerColor(p);
    if (el) {
      el.querySelector('.ring').style.borderColor = col;
      el.querySelector('.ring').style.background = col + '47';
      el.querySelector('.tag').style.background = col;
      el.querySelector('.tag').style.color = (col === '#ffffff' || col === '#ffd400') ? '#000' : '#fff';
    }
    if (cfg.trail) {
      var t = trailFor(p), last = t.pts[t.pts.length - 1];
      if (!last || Math.hypot(last[0] - pt.x, last[1] - pt.y) > 3) {
        t.pts.push([pt.x, pt.y, Date.now()]);
        t.line.setLatLngs(t.pts.map(function (q) { return toLL(q[0], q[1]); }));
      }
    }
  }

  function renderList(list) {
    $('count').textContent = list.length;
    $('noPlayers').style.display = list.length ? 'none' : '';
    var host = $('players');
    host.innerHTML = '';
    list.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'player' + (p.id === selected ? ' sel' : '');
      d.innerHTML = '<span class="pcol"></span><img src="icons/pin_car.png"><div><b></b><small></small></div><div class="spd">' +
        fmtSpeed(p.speed) + '<small> ' + (cfg.unit === 'mph' ? 'mph' : 'km/h') + '</small></div>';
      d.querySelector('.pcol').style.background = playerColor(p);
      d.querySelector('b').textContent = p.name + (p.host ? ' (host)' : '');
      d.querySelector('small').textContent = p.car || 'unknown car';
      d.onclick = function () { select(p.id, true); };
      host.appendChild(d);
    });
  }

  function select(id, zoom) {
    selected = id;
    var e = players[id];
    if (e && zoom) map.setView(e.marker.getLatLng(), Math.max(map.getZoom(), 4.5), { animate: true });
    renderList(lastList);
  }

  map.on('dragstart', function () { if (cfg.follow && selected !== null) { cfg.follow = false; $('optFollow').checked = false; saveCfg(); } });

  var ok = false;
  function poll() {
    fetch('api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      ok = true;
      calib = s.calib; buildOverlays();
      $('status').textContent = s.players.length ? 'live' : 'waiting for game';
      $('status').className = 'pill' + (s.players.length ? ' on' : '');
      lastList = s.players;
      var ids = {};
      s.players.forEach(function (p) { ids[p.id] = 1; updatePlayer(p); });
      Object.keys(players).forEach(function (k) {
        if (!ids[k]) {
          map.removeLayer(players[k].marker); delete players[k];
          if (trails[k]) { map.removeLayer(trails[k].line); delete trails[k]; }
        }
      });
      if (selected === null && s.players.length) { select(s.players[0].id, true); }
      renderList(s.players);
      var e = players[selected];
      if (e && cfg.follow) map.panTo(e.marker.getLatLng(), { animate: true, duration: 0.25, easeLinearity: 1 });
      calUpdate();
    }).catch(function () { $('status').textContent = 'offline'; $('status').className = 'pill'; })
      .then(function () { setTimeout(poll, 250); });
  }

  map.on('mousemove', function (ev) {
    var p = fromLL(ev.latlng);
    var wx = (p.x - calib.bx) / calib.ax, wz = (p.y - calib.bz) / calib.az;
    $('coords').textContent = 'px ' + Math.round(p.x) + ', ' + Math.round(p.y) + '  |  world ' + Math.round(wx) + ', ' + Math.round(wz);
  });

  // settings
  function bind(id, key, type) {
    var el = $(id);
    if (type === 'check') el.checked = cfg[key]; else el.value = cfg[key];
    el.onchange = el.oninput = function () {
      cfg[key] = type === 'check' ? el.checked : (type === 'num' ? Number(el.value) : el.value);
      saveCfg(); applyLandmarks(); applyLayers(); applyBright();
      if (key === 'trail' && !cfg.trail) Object.keys(trails).forEach(clearTrail);
      if (key === 'follow' && cfg.follow && players[selected]) map.panTo(players[selected].marker.getLatLng());
      renderList(lastList);
    };
  }
  bind('optFollow', 'follow', 'check'); bind('optTrail', 'trail', 'check'); bind('optLandmarks', 'landmarks', 'check');
  bind('optUnit', 'unit'); bind('optBright', 'bright', 'num');
  bind('optRoads', 'roads', 'check'); bind('optCams', 'cams', 'check'); bind('optZones', 'zones', 'check');
  applyLandmarks(); applyBright();

  // calibration
  var calPts = [], calMarkers = [], pending = null;
  function calUpdate() {
    var e = players[selected];
    $('calInfo').textContent = 'x*' + calib.ax.toFixed(4) + ' + ' + calib.bx.toFixed(1) + '   z*' + calib.az.toFixed(4) + ' + ' + calib.bz.toFixed(1);
    $('calAdd').disabled = !e;
    $('calList').innerHTML = calPts.map(function (q, i) { return 'Point ' + (i + 1) + ': world ' + Math.round(q.x) + ', ' + Math.round(q.z) + ' -> px ' + Math.round(q.px) + ', ' + Math.round(q.py); }).join('<br>');
    $('calApply').disabled = calPts.length < 1;
  }
  $('calAdd').onclick = function () {
    var e = players[selected];
    if (!e) return;
    pending = { x: e.data.x, z: e.data.z };
    document.body.classList.add('calibrating');
    $('calAdd').classList.add('active');
    $('calAdd').textContent = 'Click the map...';
  };
  map.on('click', function (ev) {
    if (!pending) return;
    var p = fromLL(ev.latlng);
    calPts.push({ x: pending.x, z: pending.z, px: p.x, py: p.y });
    calMarkers.push(L.marker(ev.latlng, { icon: L.divIcon({ className: '', html: '<div class="cal-pt"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map));
    pending = null;
    document.body.classList.remove('calibrating');
    $('calAdd').classList.remove('active');
    $('calAdd').textContent = 'Add point';
    if (calPts.length > 2) { calPts.shift(); map.removeLayer(calMarkers.shift()); }
    calUpdate();
  });
  $('calApply').onclick = function () {
    var a = calPts[calPts.length - 1], n = Object.assign({}, calib);
    if (calPts.length >= 2) {
      var b = calPts[calPts.length - 2];
      if (Math.abs(a.x - b.x) > 20) { n.ax = (a.px - b.px) / (a.x - b.x); }
      if (Math.abs(a.z - b.z) > 20) { n.az = (a.py - b.py) / (a.z - b.z); }
    }
    n.bx = a.px - n.ax * a.x; n.bz = a.py - n.az * a.z;
    save(n);
  };
  $('calReset').onclick = function () {
    calPts = []; calMarkers.forEach(function (m) { map.removeLayer(m); }); calMarkers = [];
    save({ ax: 0.342617167, bx: 2555.30502, az: -0.343337966, bz: 327.298182 });
  };
  function save(n) {
    fetch('api/calib?ax=' + n.ax + '&bx=' + n.bx + '&az=' + n.az + '&bz=' + n.bz, { cache: 'no-store' });
    calib = n; calUpdate();
  }

  poll();
})();
