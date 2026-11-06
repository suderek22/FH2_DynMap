(function () {
  'use strict';
  var MAP_W = 7168, MAP_H = 4096, NATIVE_Z = 5;
  var $ = function (id) { return document.getElementById(id); };

  var cfg = Object.assign({ map: 'anthem', follow: true, trail: true, landmarks: true, roads: false, cams: true, zones: true, unit: 'kmh', bright: 100, names: false, hideLeft: false, hideRight: false },
    JSON.parse(localStorage.getItem('dynmap.cfg') || '{}'));
  function saveCfg() { localStorage.setItem('dynmap.cfg', JSON.stringify(cfg)); }
  var anthem = { width: 7168, height: 4096, nativeZoom: 5,
    calib: { ax: 0.342617167, bx: 2555.30502, az: -0.343337966, bz: 327.298182 },
    landmarks: [{ name: 'Horizon Festival', px: 4660, py: 2490, icon: 'pin_hf' }] };
  if (cfg.map !== 'anthem' && cfg.map !== 'island') cfg.map = 'anthem';
  var mapMeta = anthem, mapReady = false, mapGeneration = 0, tileLayer = null, savingCalib = false;

  var map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: 7, zoomSnap: 0.25, attributionControl: false });
  function toLL(px, py) {
    var p = mapMeta.rotation === 'left' ? L.point(py, MAP_W - px) : L.point(px, py);
    return map.unproject(p, NATIVE_Z);
  }
  function fromLL(ll) {
    var p = map.project(ll, NATIVE_Z);
    return mapMeta.rotation === 'left' ? { x: MAP_W - p.y, y: p.x } : { x: p.x, y: p.y };
  }

  function applyBright() { document.querySelector('.leaflet-tile-pane').style.filter = 'brightness(' + cfg.bright / 100 + ')'; }

  var calib = { ax: 0.342617167, bx: 2555.30502, az: -0.343337966, bz: 327.298182 };
  function worldToPx(x, z) { return { x: calib.ax * x + calib.bx, y: calib.az * z + calib.bz }; }

  // landmarks
  function icon(name, w, h, ax, ay) { return L.icon({ iconUrl: 'icons/' + name + '.png', iconSize: [w, h], iconAnchor: [ax, ay], className: 'lm' }); }
  var landmarks = L.layerGroup();
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
    var key = [cfg.map, calib.ax, calib.bx, calib.az, calib.bz].join(',');
    if (key === builtFor) return;
    builtFor = key;
    roadsLayer.clearLayers(); camsLayer.clearLayers(); zonesLayer.clearLayers();
    landmarks.clearLayers();
    mapMeta.landmarks.forEach(function (p) {
      var ll = p.px === undefined ? wll(p.x, p.z) : toLL(p.px, p.py);
      L.marker(ll, { icon: p.icon === 'pin_hf' ? icon('pin_hf', 45, 60, 22, 59) : icon(p.icon, 26, 26, 13, 13),
        title: p.name }).addTo(landmarks);
    });
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
  function readJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.json();
    });
  }
  function showMapError(message) {
    $('mapError').hidden = !message;
    $('mapError').textContent = message;
    if (message) console.error(message);
  }
  function clearPlayers() {
    Object.keys(players).forEach(function (id) { map.removeLayer(players[id].marker); });
    Object.keys(trails).forEach(function (id) { map.removeLayer(trails[id].line); });
    players = {}; trails = {}; lastList = []; selected = null; autoPicked = false;
    renderList([]);
  }
  function switchMap(id) {
    var generation = ++mapGeneration, base = id === 'island' ? 'maps/island/' : '';
    cfg.map = id; saveCfg(); mapReady = false;
    $('optMap').value = id;
    $('status').textContent = 'loading map'; $('status').className = 'pill';
    $('mapInfo').textContent = id === 'island' ? 'Storm Island (The Island DLC)' : 'Anthem (mainland)';
    showMapError('');
    clearPlayers(); clearCalPoints();
    roadsLayer.clearLayers(); camsLayer.clearLayers(); zonesLayer.clearLayers(); landmarks.clearLayers();
    if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
    calUpdate();
    Promise.all([id === 'island' ? readJson(base + 'map.json') : Promise.resolve(anthem),
      readJson(base + 'data/roads.json'), readJson(base + 'data/overlays.json')]).then(function (r) {
      if (generation !== mapGeneration) return;
      mapMeta = r[0]; MAP_W = mapMeta.width; MAP_H = mapMeta.height; NATIVE_Z = mapMeta.nativeZoom;
      calib = Object.assign({}, mapMeta.calib);
      roadData = r[1]; ovData = r[2]; builtFor = '';
      var bounds = L.latLngBounds(toLL(0, MAP_H), toLL(MAP_W, 0));
      tileLayer = L.tileLayer(base + 'tiles/{z}/{x}_{y}.jpg?v=5', { minZoom: 0, maxZoom: 7,
        maxNativeZoom: NATIVE_Z, tileSize: 256, noWrap: true, bounds: bounds }).addTo(map);
      map.setMaxBounds(bounds.pad(0.25)); map.fitBounds(bounds);
      mapReady = true; buildOverlays(); applyLayers(); applyLandmarks(); applyBright(); calUpdate();
    }).catch(function (e) {
      if (generation !== mapGeneration) return;
      $('status').textContent = 'map unavailable';
      showMapError('Could not load ' + id + ' map: ' + e.message + '. Select the map again to retry.');
    });
  }

  // players
  var players = {}, selected = null, lastList = [], autoPicked = false;
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
      html: '<div class="me"><div class="dot"></div><div class="ring"></div><img src="icons/arrow.png" style="width:22px;height:auto"><div class="tag"></div><div class="mini"></div></div>' });
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
      (function (id) { e.marker.on('click', function () { select(id, false); }); })(p.id);
    }
    var dx = pt.x - e.px.x, dy = pt.y - e.px.y;
    if (Math.hypot(dx, dy) > 0.6 && p.speed > 1)
      e.heading = Math.atan2(dx, -dy) * 180 / Math.PI - (mapMeta.rotation === 'left' ? 90 : 0);
    e.px = pt;
    e.marker.setLatLng(ll);
    var el = e.marker.getElement();
    var sel = p.id === selected;
    if (el) {
      var me = el.querySelector('.me');
      me.classList.toggle('sel', sel);
      el.querySelector('img').style.transform = 'rotate(' + e.heading + 'deg)';
      el.querySelector('.tag').textContent = p.name;
      el.querySelector('.mini').textContent = p.name;
      el.title = p.name;
    }
    e.marker.setZIndexOffset(sel ? 2000 : 1000);
    e.data = p;
    var col = playerColor(p);
    if (el) {
      el.querySelector('.ring').style.borderColor = col;
      el.querySelector('.ring').style.background = col + '47';
      el.querySelector('.tag').style.background = col;
      var mini = el.querySelector('.mini');
      mini.style.background = col;
      mini.style.color = (col === '#ffffff' || col === '#ffd400') ? '#000' : '#fff';
      el.querySelector('.tag').style.color = (col === '#ffffff' || col === '#ffd400') ? '#000' : '#fff';
    }
    if (cfg.trail && sel) {
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
      d.querySelector('b').textContent = p.name;
      d.querySelector('small').textContent = p.car || 'unknown car';
      d.onclick = function () { select(p.id, true); };
      host.appendChild(d);
    });
  }

  function select(id, zoom) {
    selected = id;
    Object.keys(trails).forEach(function (k) { if (String(k) !== String(id)) { map.removeLayer(trails[k].line); delete trails[k]; } });
    lastList.forEach(updatePlayer);
    var e = players[id];
    if (e && zoom) map.setView(e.marker.getLatLng(), Math.max(map.getZoom(), 4.5), { animate: true });
    renderList(lastList);
  }

  map.on('dragstart', function () { if (cfg.follow && selected !== null) { cfg.follow = false; $('optFollow').checked = false; saveCfg(); } });

  var ok = false;
  function poll() {
    var generation = mapGeneration;
    readJson('api/state?map=' + cfg.map).then(function (s) {
      if (generation !== mapGeneration || !mapReady || savingCalib) return;
      ok = true;
      calib = s.calib; buildOverlays();
      var otherMap = s.activeMap && s.activeMap !== 'unknown' && s.activeMap !== cfg.map;
      $('status').textContent = otherMap ? 'playing on ' + (s.activeMap === 'island' ? 'Storm Island' : 'Anthem') :
        s.players.length ? 'live' : 'waiting for game';
      $('noPlayers').textContent = otherMap ? 'Players are on ' + (s.activeMap === 'island' ? 'Storm Island' : 'Anthem') +
        '. Select that map to see them.' : 'Waiting for the game. Start driving in free roam.';
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
      if (selected !== null && !ids[selected]) selected = null;
      if (selected === null && !autoPicked && s.players.length) { autoPicked = true; select(s.players[0].id, true); }
      renderList(s.players);
      var e = players[selected];
      if (e && cfg.follow) map.panTo(e.marker.getLatLng(), { animate: true, duration: 0.25, easeLinearity: 1 });
      calUpdate();
    }).catch(function (e) {
      if (generation !== mapGeneration || !mapReady) return;
      $('status').textContent = 'offline'; $('status').className = 'pill';
      console.error('DynMap state: ' + e.message);
    })
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
      saveCfg(); applyLandmarks(); applyLayers(); applyBright(); applyUi();
      if (key === 'trail' && !cfg.trail) Object.keys(trails).forEach(clearTrail);
      if (key === 'follow' && cfg.follow && players[selected]) map.panTo(players[selected].marker.getLatLng());
      renderList(lastList);
    };
  }
  function applyUi() {
    document.body.classList.toggle('names', !!cfg.names);
    [['left', 'hideLeft', 'tabLeft'], ['right', 'hideRight', 'tabRight']].forEach(function (x) {
      $(x[0]).classList.toggle('hidden', !!cfg[x[1]]);
      $(x[2]).classList.toggle('show', !!cfg[x[1]]);
    });
  }
  $('optMap').onchange = function () { switchMap(this.value); };
  Array.prototype.forEach.call(document.querySelectorAll('.collapse'), function (b) {
    b.onclick = function () { cfg[b.dataset.panel === 'left' ? 'hideLeft' : 'hideRight'] = true; saveCfg(); applyUi(); };
  });
  $('tabLeft').onclick = function () { cfg.hideLeft = false; saveCfg(); applyUi(); };
  $('tabRight').onclick = function () { cfg.hideRight = false; saveCfg(); applyUi(); };
  bind('optNames', 'names', 'check');
  applyUi();
  bind('optFollow', 'follow', 'check'); bind('optTrail', 'trail', 'check'); bind('optLandmarks', 'landmarks', 'check');
  bind('optUnit', 'unit'); bind('optBright', 'bright', 'num');
  bind('optRoads', 'roads', 'check'); bind('optCams', 'cams', 'check'); bind('optZones', 'zones', 'check');
  applyLandmarks(); applyBright();

  // calibration
  var calPts = [], calMarkers = [], pending = null;
  function clearCalPoints() {
    calPts = []; calMarkers.forEach(function (m) { map.removeLayer(m); }); calMarkers = [];
    pending = null;
    document.body.classList.remove('calibrating');
    $('calAdd').classList.remove('active'); $('calAdd').textContent = 'Add point';
  }
  function calUpdate() {
    var e = players[selected];
    $('calInfo').textContent = 'x*' + calib.ax.toFixed(4) + ' + ' + calib.bx.toFixed(1) + '   z*' + calib.az.toFixed(4) + ' + ' + calib.bz.toFixed(1);
    $('calAdd').disabled = !e || !mapReady || savingCalib;
    $('calList').innerHTML = calPts.map(function (q, i) { return 'Point ' + (i + 1) + ': world ' + Math.round(q.x) + ', ' + Math.round(q.z) + ' -> px ' + Math.round(q.px) + ', ' + Math.round(q.py); }).join('<br>');
    $('calApply').disabled = calPts.length < 1 || !mapReady || savingCalib;
    $('calReset').disabled = !mapReady || savingCalib;
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
    if (!pending) { if (selected !== null) select(null, false); return; }
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
    clearCalPoints();
    save(Object.assign({}, mapMeta.calib));
  };
  function save(n) {
    var generation = mapGeneration, id = cfg.map;
    savingCalib = true; calUpdate(); showMapError('');
    readJson('api/calib?map=' + id + '&ax=' + n.ax + '&bx=' + n.bx + '&az=' + n.az + '&bz=' + n.bz).then(function (r) {
      if (!r.ok) throw new Error('Calibration was not saved');
      if (generation !== mapGeneration) return;
      calib = n; builtFor = ''; buildOverlays();
      Object.keys(trails).forEach(clearTrail);
      lastList.forEach(updatePlayer);
    }).catch(function (e) {
      if (generation === mapGeneration) showMapError('Could not save calibration: ' + e.message);
    }).then(function () { savingCalib = false; calUpdate(); });
  }

  switchMap(cfg.map);
  poll();
})();
