/* Sailing ETA Calculator
 * - Computes ETA across a configurable range of speeds (knots)
 * - Distance from manual entry OR a multi-leg route built on the map
 * - Departure "now" or a chosen future time
 * - Live recompute when the route starts from the device's current location
 */

'use strict';

// Bump this on each release (see CLAUDE.md — ask the user for the new number).
const APP_VERSION = '1.3.0';
const STORAGE_KEY = 'sailing-eta-settings-v2';

// ── State ──────────────────────────────────────────────────────────
const state = {
  distanceMode: 'manual',     // 'manual' | 'map'
  departureMode: 'now',       // 'now' | 'future'
  useCurrent: false,          // route starts from live GPS position
  gps: null,                  // current GPS point { lat, lng } when useCurrent
  waypoints: [],              // user-placed route points [{ lat, lng }, ...]
  watchId: null,              // geolocation watch handle
  gpsCentered: false,         // have we recentered the map on the first GPS fix?
  track: [],                  // recent GPS fixes [{ t, lat, lng }] for speed-over-ground
};

// ── DOM ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  distance: $('distance'),
  manualPane: $('manual-pane'),
  mapPane: $('map-pane'),
  futurePane: $('future-pane'),
  departureTime: $('departure-time'),
  speedMin: $('speed-min'),
  speedMax: $('speed-max'),
  speedStep: $('speed-step'),
  avgMinutes: $('avg-minutes'),
  currentSpeed: $('current-speed'),
  useCurrent: $('use-current'),
  gpsStatus: $('gps-status'),
  routeList: $('route-list'),
  wpLat: $('wp-lat'),
  wpLng: $('wp-lng'),
  addPoint: $('add-point'),
  undoPoint: $('undo-point'),
  clearRoute: $('clear-route'),
  mapUndo: $('map-undo'),
  mapClear: $('map-clear'),
  computedDistance: $('computed-distance'),
  resultsMeta: $('results-meta'),
  tableBody: document.querySelector('#eta-table tbody'),
  appVersion: $('app-version'),
  settingsToggle: $('settings-toggle'),
  controls: $('controls'),
};

// ── Geo math ───────────────────────────────────────────────────────
const EARTH_NM = 3440.065; // mean Earth radius in nautical miles
const toRad = (d) => (d * Math.PI) / 180;

function greatCircleNM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Route helpers ──────────────────────────────────────────────────
// The full ordered path: live GPS position (if used) followed by waypoints.
function pathPoints() {
  const pts = state.useCurrent && state.gps ? [state.gps] : [];
  return pts.concat(state.waypoints);
}

function routeDistanceNM() {
  const p = pathPoints();
  let total = 0;
  for (let i = 1; i < p.length; i++) total += greatCircleNM(p[i - 1], p[i]);
  return total;
}

// ── Time helpers ───────────────────────────────────────────────────
function formatETA(date) {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Count local midnights crossed between departure and arrival = nights at sea.
function countNights(start, end) {
  let nights = 0;
  const cursor = new Date(start);
  cursor.setHours(24, 0, 0, 0); // first midnight after departure
  while (cursor <= end) {
    nights++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return nights;
}

// ── Core calculation ───────────────────────────────────────────────
function getDistance() {
  if (state.distanceMode === 'map') {
    return pathPoints().length >= 2 ? routeDistanceNM() : null;
  }
  const v = parseFloat(els.distance.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function getDeparture() {
  if (state.departureMode === 'future' && els.departureTime.value) {
    const d = new Date(els.departureTime.value);
    if (!isNaN(d)) return d;
  }
  return new Date();
}

function speedList() {
  let min = parseFloat(els.speedMin.value);
  let max = parseFloat(els.speedMax.value);
  let step = parseFloat(els.speedStep.value);
  if (!Number.isFinite(min) || min <= 0) min = 1;
  if (!Number.isFinite(max) || max <= 0) max = min;
  if (max < min) [min, max] = [max, min];
  if (!Number.isFinite(step) || step <= 0) step = 0.5;

  const speeds = [];
  // Guard against runaway loops from tiny steps over wide ranges.
  const maxRows = 200;
  for (let s = min; s <= max + 1e-9 && speeds.length < maxRows; s += step) {
    speeds.push(Math.round(s * 100) / 100);
  }
  return speeds;
}

// Average speed over ground (knots) across the configured time window, from the
// recent GPS track. Returns null when there isn't enough movement data yet.
function averagedMinutes() {
  const m = parseFloat(els.avgMinutes.value);
  return Number.isFinite(m) && m > 0 ? m : 2;
}

function computeCurrentSpeed() {
  const windowMs = averagedMinutes() * 60000;
  const now = Date.now();
  const pts = state.track.filter((p) => now - p.t <= windowMs);
  if (pts.length < 2) return null;
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += greatCircleNM(pts[i - 1], pts[i]);
  const hours = (pts[pts.length - 1].t - pts[0].t) / 3600000;
  if (hours <= 0) return null;
  return dist / hours;
}

function renderCurrentSpeed(current) {
  if (current === null) {
    els.currentSpeed.innerHTML =
      `Current speed: <strong>—</strong> <span class="cs-note">(needs GPS while moving)</span>`;
  } else {
    els.currentSpeed.innerHTML =
      `Current speed: <strong>${current.toFixed(1)} kn</strong>` +
      ` <span class="cs-note">avg ${averagedMinutes()} min</span>`;
  }
}

function recalculate() {
  const distance = getDistance();
  const departure = getDeparture();
  const body = els.tableBody;
  body.innerHTML = '';

  const current = computeCurrentSpeed();
  renderCurrentSpeed(current);

  if (distance === null) {
    const msg =
      state.distanceMode === 'map'
        ? 'Tap the map to build a route (start + at least one waypoint).'
        : 'Enter a distance to see arrival times.';
    body.innerHTML = `<tr class="empty-row"><td colspan="4">${msg}</td></tr>`;
    els.resultsMeta.textContent = '';
    saveSettings();
    return;
  }

  const legs = state.distanceMode === 'map' ? Math.max(0, pathPoints().length - 1) : 0;
  els.resultsMeta.textContent =
    `${distance.toFixed(1)} NM${legs ? ` · ${legs} leg${legs > 1 ? 's' : ''}` : ''}` +
    ` · departing ${formatETA(departure)}`;

  const speeds = speedList();
  // The row closest to the current speed gets the strongest highlight; nearby
  // rows fade out over HIGHLIGHT_SPAN knots.
  const HIGHLIGHT_SPAN = 0.5;
  let closest = null;
  if (current !== null) {
    closest = speeds.reduce((a, b) =>
      Math.abs(b - current) < Math.abs(a - current) ? b : a
    );
  }

  for (const speed of speeds) {
    const hours = distance / speed;
    const eta = new Date(departure.getTime() + hours * 3600 * 1000);
    const nights = countNights(departure, eta);
    const arrivalTime = eta.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const dow = eta.toLocaleDateString(undefined, { weekday: 'short' });

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="speed-cell">${speed.toFixed(1)}</td>
      <td class="nights-cell">${nights}</td>
      <td class="arr-cell">${arrivalTime}</td>
      <td class="dow-cell">${dow}</td>`;

    if (current !== null) {
      const strength = Math.max(0, 1 - Math.abs(speed - current) / HIGHLIGHT_SPAN);
      if (strength > 0) {
        tr.style.background = `rgba(43, 179, 255, ${(strength * 0.5).toFixed(3)})`;
      }
      if (speed === closest) tr.classList.add('current-row');
    }
    body.appendChild(tr);
  }

  saveSettings();
}

// ── Map ────────────────────────────────────────────────────────────
let map, routeLine, gpsMarker;
let wpMarkers = [];

function initMap() {
  map = L.map('map', { worldCopyJump: true }).setView([37.5, -25], 4);

  // Esri World Imagery — satellite tiles, no API key required.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution:
        'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }
  ).addTo(map);

  // Place-name overlay so the satellite view stays legible.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, opacity: 0.9 }
  ).addTo(map);

  // Each tap appends a point to the route.
  map.on('click', (e) => {
    state.waypoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    updateRoute({ fit: false });
  });
}

function routePin(color, label) {
  return L.divIcon({
    className: 'route-pin',
    html: `<div class="route-pin-body" style="background:${color}"><span>${label}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

function pinColor(idx, len) {
  if (idx === 0) return '#34d399';        // start — green
  if (idx === len - 1) return '#2bb3ff';  // destination — blue
  return '#f5b301';                       // intermediate waypoint — amber
}

// Reconcile Leaflet markers with the current route state.
function reconcileMarkers() {
  const path = pathPoints();
  const offset = state.useCurrent && state.gps ? 1 : 0;

  // GPS start marker.
  if (state.useCurrent && state.gps) {
    if (!gpsMarker) {
      gpsMarker = L.marker(state.gps, { icon: routePin('#34d399', '1') }).addTo(map);
    } else {
      gpsMarker.setLatLng(state.gps);
      gpsMarker.setIcon(routePin('#34d399', '1'));
    }
    gpsMarker.bindTooltip('Start (live position)');
  } else if (gpsMarker) {
    map.removeLayer(gpsMarker);
    gpsMarker = null;
  }

  // Drop surplus waypoint markers.
  while (wpMarkers.length > state.waypoints.length) {
    map.removeLayer(wpMarkers.pop());
  }

  // Create / update a marker per waypoint.
  state.waypoints.forEach((pt, i) => {
    const idx = offset + i;
    const label = String(idx + 1);
    const color = pinColor(idx, path.length);
    let m = wpMarkers[i];
    if (!m) {
      m = L.marker(pt, { draggable: true }).addTo(map);
      m.on('dragend', () => {
        const ll = m.getLatLng();
        state.waypoints[m._wpIndex] = { lat: ll.lat, lng: ll.lng };
        updateRoute({ fit: false });
      });
      wpMarkers[i] = m;
    } else {
      m.setLatLng(pt);
    }
    m._wpIndex = i;
    m.setIcon(routePin(color, label));
    const name = idx === 0 ? 'Start' : idx === path.length - 1 ? 'Destination' : `Waypoint ${idx}`;
    m.bindTooltip(name);

    // Tap a pin to view it and remove it from the route.
    const popup = document.createElement('div');
    popup.className = 'wp-popup';
    popup.innerHTML =
      `<div class="wp-popup-name">${idx + 1}. ${name}</div>` +
      `<div class="wp-popup-coord">${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}</div>`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'wp-popup-remove';
    rm.textContent = 'Remove point';
    rm.addEventListener('click', () => {
      map.closePopup();
      removeWaypoint(m._wpIndex);
    });
    popup.appendChild(rm);
    m.bindPopup(popup);
  });
}

function renderRouteList() {
  const path = pathPoints();
  const offset = state.useCurrent && state.gps ? 1 : 0;
  const list = els.routeList;
  list.innerHTML = '';

  if (path.length === 0) {
    list.innerHTML = '<li class="route-empty">No points yet — tap the map.</li>';
    els.computedDistance.textContent = 'Total distance: —';
    return;
  }

  path.forEach((pt, idx) => {
    const isGps = idx === 0 && offset === 1;
    const name = idx === 0 ? 'Start' : idx === path.length - 1 ? 'Destination' : `WP ${idx}`;
    const leg = idx > 0 ? ` · leg ${greatCircleNM(path[idx - 1], pt).toFixed(1)} NM` : '';
    const coords = `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;

    const li = document.createElement('li');
    li.innerHTML =
      `<span class="rl-name">${idx + 1}. ${name}${isGps ? ' (GPS)' : ''}</span>` +
      `<span class="rl-coord">${coords}${leg}</span>`;

    if (!isGps) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rl-remove';
      btn.textContent = '✕';
      btn.title = 'Remove this point';
      const wpIndex = idx - offset;
      btn.addEventListener('click', () => {
        state.waypoints.splice(wpIndex, 1);
        updateRoute({ fit: false });
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  });

  const total = routeDistanceNM();
  const legs = Math.max(0, path.length - 1);
  els.computedDistance.innerHTML =
    `Total distance: <strong>${total.toFixed(1)} NM</strong> · ${legs} leg${legs === 1 ? '' : 's'}`;
}

function fitToPath() {
  const path = pathPoints();
  if (path.length >= 2) {
    map.fitBounds(L.latLngBounds(path).pad(0.3));
  } else if (path.length === 1) {
    map.setView(path[0], Math.max(map.getZoom(), 9));
  }
}

// ── Route mutations ────────────────────────────────────────────────
function removeWaypoint(i) {
  if (i < 0 || i >= state.waypoints.length) return;
  state.waypoints.splice(i, 1);
  updateRoute({ fit: false });
}

function undoLastPoint() {
  state.waypoints.pop();
  updateRoute({ fit: false });
}

function clearRoute() {
  state.waypoints = [];
  updateRoute({ fit: false });
}

function updateMapActions() {
  const show = state.distanceMode === 'map' && state.waypoints.length > 0;
  els.mapUndo.classList.toggle('hidden', !show);
  els.mapClear.classList.toggle('hidden', !show);
}

// Central update after any change to the route.
function updateRoute({ fit = false } = {}) {
  const path = pathPoints();
  reconcileMarkers();
  updateMapActions();

  if (path.length >= 2) {
    if (!routeLine) {
      routeLine = L.polyline(path, { color: '#2bb3ff', weight: 3, dashArray: '6 6' }).addTo(map);
    } else {
      routeLine.setLatLngs(path);
    }
  } else if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }

  renderRouteList();
  if (fit) fitToPath();
  recalculate(); // also persists state
}

// ── Geolocation ────────────────────────────────────────────────────
function startWatchingLocation() {
  if (!('geolocation' in navigator)) {
    els.gpsStatus.hidden = false;
    els.gpsStatus.classList.add('err');
    els.gpsStatus.textContent = 'Geolocation is not supported by this browser.';
    els.useCurrent.checked = false;
    state.useCurrent = false;
    return;
  }
  els.gpsStatus.hidden = false;
  els.gpsStatus.classList.remove('err');
  els.gpsStatus.textContent = 'Acquiring position…';

  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };

      // Record the fix for speed-over-ground; keep ~30 min of history.
      const now = Date.now();
      state.track.push({ t: now, lat: state.gps.lat, lng: state.gps.lng });
      state.track = state.track.filter((p) => now - p.t <= 30 * 60000);

      const acc = pos.coords.accuracy ? ` (±${Math.round(pos.coords.accuracy)} m)` : '';
      els.gpsStatus.classList.remove('err');
      els.gpsStatus.textContent =
        `Live: ${state.gps.lat.toFixed(5)}, ${state.gps.lng.toFixed(5)}${acc}` +
        ` · updated ${new Date().toLocaleTimeString()}`;

      const firstFix = !state.gpsCentered;
      updateRoute({ fit: false });
      if (firstFix) {
        state.gpsCentered = true;
        fitToPath(); // show the whole route if any, else center on the position
      }
    },
    (err) => {
      els.gpsStatus.classList.add('err');
      els.gpsStatus.textContent = `Location error: ${err.message}`;
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function stopWatchingLocation() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  els.gpsStatus.hidden = true;
}

// ── Persistence ────────────────────────────────────────────────────
function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        distanceMode: state.distanceMode,
        departureMode: state.departureMode,
        useCurrent: state.useCurrent,
        waypoints: state.waypoints,
        distance: els.distance.value,
        speedMin: els.speedMin.value,
        speedMax: els.speedMax.value,
        speedStep: els.speedStep.value,
        avgMinutes: els.avgMinutes.value,
        departureTime: els.departureTime.value,
      })
    );
  } catch (e) {
    /* storage unavailable (private mode / disabled) — ignore */
  }
}

function loadSettings() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) {
    return false;
  }
  if (!s) return false;

  if (s.distance != null) els.distance.value = s.distance;
  if (s.speedMin != null) els.speedMin.value = s.speedMin;
  if (s.speedMax != null) els.speedMax.value = s.speedMax;
  if (s.speedStep != null) els.speedStep.value = s.speedStep;
  if (s.avgMinutes != null) els.avgMinutes.value = s.avgMinutes;
  if (s.departureTime) els.departureTime.value = s.departureTime;

  if (Array.isArray(s.waypoints)) {
    state.waypoints = s.waypoints.filter(
      (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    );
  }

  if (s.distanceMode) setDistanceMode(s.distanceMode);
  if (s.departureMode) setDepartureMode(s.departureMode);

  // Restore live-location tracking (it will add the GPS origin once fixed).
  if (s.useCurrent) applyUseCurrent(true);
  return true;
}

// ── Mode helpers ───────────────────────────────────────────────────
function setDistanceMode(mode) {
  state.distanceMode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  els.manualPane.classList.toggle('hidden', mode !== 'manual');
  els.mapPane.classList.toggle('hidden', mode !== 'map');
  if (mode === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
  updateMapActions();
  recalculate();
}

function setDepartureMode(mode) {
  state.departureMode = mode;
  document.querySelectorAll('[data-dep]').forEach((b) =>
    b.classList.toggle('active', b.dataset.dep === mode)
  );
  els.futurePane.classList.toggle('hidden', mode !== 'future');
  recalculate();
}

function applyUseCurrent(on) {
  state.useCurrent = on;
  els.useCurrent.checked = on;
  if (on) {
    startWatchingLocation();
  } else {
    stopWatchingLocation();
    state.gps = null;
    state.track = [];
    state.gpsCentered = false; // recenter again next time GPS is enabled
    updateRoute({ fit: false });
  }
  saveSettings();
}

function toggleSettings(show) {
  const open = show ?? els.controls.classList.contains('hidden');
  els.controls.classList.toggle('hidden', !open);
  els.settingsToggle.setAttribute('aria-expanded', String(open));
  els.settingsToggle.textContent = open ? '⚙ Hide settings' : '⚙ Settings';
  if (open && state.distanceMode === 'map' && map) {
    setTimeout(() => map.invalidateSize(), 50);
  }
}

// ── Wiring ─────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('[data-mode]').forEach((btn) =>
    btn.addEventListener('click', () => setDistanceMode(btn.dataset.mode))
  );
  document.querySelectorAll('[data-dep]').forEach((btn) =>
    btn.addEventListener('click', () => setDepartureMode(btn.dataset.dep))
  );
  els.settingsToggle.addEventListener('click', () => toggleSettings());
}

function setupInputs() {
  [els.distance, els.speedMin, els.speedMax, els.speedStep, els.avgMinutes, els.departureTime].forEach(
    (el) => el.addEventListener('input', recalculate)
  );

  // Add a route point by typing coordinates.
  els.addPoint.addEventListener('click', () => {
    const lat = parseFloat(els.wpLat.value);
    const lng = parseFloat(els.wpLng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      state.waypoints.push({ lat, lng });
      els.wpLat.value = '';
      els.wpLng.value = '';
      updateRoute({ fit: true });
    }
  });

  els.undoPoint.addEventListener('click', undoLastPoint);
  els.clearRoute.addEventListener('click', clearRoute);
  els.mapUndo.addEventListener('click', undoLastPoint);
  els.mapClear.addEventListener('click', clearRoute);

  // Use-current toggle.
  els.useCurrent.addEventListener('change', (e) => applyUseCurrent(e.target.checked));

  // Default the future-time picker to one hour from now (unless restored later).
  const soon = new Date(Date.now() + 3600 * 1000);
  soon.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  els.departureTime.value =
    `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}` +
    `T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
}

// ── Init ───────────────────────────────────────────────────────────
function init() {
  if (els.appVersion) els.appVersion.textContent = `v${APP_VERSION}`;
  initMap();
  setupTabs();
  setupInputs();

  // Restore the last session from this device; on a fresh visit, open straight
  // to the map with live current-location tracking enabled.
  const restored = loadSettings();
  if (!restored) {
    setDistanceMode('map');
    applyUseCurrent(true);
  }

  // Draw any restored route and frame it (or the live position) on the map.
  updateRoute({ fit: true });

  // Refresh "now" ETAs and the current-speed reading / row highlight over time.
  setInterval(recalculate, 15000);
}

document.addEventListener('DOMContentLoaded', init);
