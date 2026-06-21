/* Sailing ETA Calculator
 * - Computes ETA across a configurable range of speeds (knots)
 * - Distance from manual entry OR great-circle distance between two map points
 * - Departure "now" or a chosen future time
 * - Live recompute when the start point follows the device's current location
 */

'use strict';

// Bump this on each release (see CLAUDE.md — ask the user for the new number).
const APP_VERSION = '1.1.0';
const STORAGE_KEY = 'sailing-eta-settings-v1';

// ── State ──────────────────────────────────────────────────────────
const state = {
  distanceMode: 'manual',     // 'manual' | 'map'
  departureMode: 'now',       // 'now' | 'future'
  setPoint: 'dest',           // which point a map click sets: 'start' | 'dest'
  useCurrent: false,          // start follows GPS
  start: null,                // { lat, lng }
  dest: null,                 // { lat, lng }
  watchId: null,              // geolocation watch handle
  gpsCentered: false,         // have we recentered the map on the first GPS fix?
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
  startLat: $('start-lat'),
  startLng: $('start-lng'),
  destLat: $('dest-lat'),
  destLng: $('dest-lng'),
  useCurrent: $('use-current'),
  gpsStatus: $('gps-status'),
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
    if (state.start && state.dest) return greatCircleNM(state.start, state.dest);
    return null;
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

function recalculate() {
  const distance = getDistance();
  const departure = getDeparture();
  const body = els.tableBody;
  body.innerHTML = '';

  if (distance === null) {
    body.innerHTML =
      '<tr class="empty-row"><td colspan="4">Enter a distance, or set start &amp; destination on the map.</td></tr>';
    els.resultsMeta.textContent = '';
    return;
  }

  els.resultsMeta.textContent =
    `${distance.toFixed(1)} NM · departing ${formatETA(departure)}`;

  for (const speed of speedList()) {
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
      <td>${arrivalTime}</td>
      <td class="dow-cell">${dow}</td>`;
    body.appendChild(tr);
  }

  saveSettings();
}

// ── Map ────────────────────────────────────────────────────────────
let map, startMarker, destMarker, routeLine;

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

  // Optional place-name overlay so the satellite view stays legible.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, opacity: 0.9 }
  ).addTo(map);

  map.on('click', (e) => {
    const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (state.setPoint === 'start') {
      if (state.useCurrent) return; // start is locked to GPS
      setStart(pt);
    } else {
      setDest(pt);
    }
  });
}

function markerIcon(kind) {
  const color = kind === 'start' ? '#34d399' : '#2bb3ff';
  return L.divIcon({
    className: 'pin',
    html: `<div style="background:${color};width:18px;height:18px;border-radius:50% 50% 50% 0;
           transform:rotate(-45deg);border:2px solid #04141f;box-shadow:0 2px 6px rgba(0,0,0,.5)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
  });
}

function setStart(pt, { fromGps = false } = {}) {
  state.start = pt;
  els.startLat.value = pt.lat.toFixed(6);
  els.startLng.value = pt.lng.toFixed(6);

  if (!startMarker) {
    startMarker = L.marker(pt, {
      icon: markerIcon('start'),
      draggable: true,
    }).addTo(map);
    startMarker.on('dragend', () => {
      if (state.useCurrent) return;
      const ll = startMarker.getLatLng();
      setStart({ lat: ll.lat, lng: ll.lng });
    });
    startMarker.bindTooltip('Start');
  } else {
    startMarker.setLatLng(pt);
  }
  startMarker.dragging[state.useCurrent ? 'disable' : 'enable']();

  // On the first GPS fix, recenter so the user can see themselves and click a
  // destination nearby. Only do it once so we don't fight manual panning.
  if (fromGps && !state.dest && !state.gpsCentered) {
    map.setView(pt, 9);
    state.gpsCentered = true;
  }

  afterPointChange(fromGps);
}

function setDest(pt) {
  state.dest = pt;
  els.destLat.value = pt.lat.toFixed(6);
  els.destLng.value = pt.lng.toFixed(6);

  if (!destMarker) {
    destMarker = L.marker(pt, {
      icon: markerIcon('dest'),
      draggable: true,
    }).addTo(map);
    destMarker.on('dragend', () => {
      const ll = destMarker.getLatLng();
      setDest({ lat: ll.lat, lng: ll.lng });
    });
    destMarker.bindTooltip('Destination');
  } else {
    destMarker.setLatLng(pt);
  }
  afterPointChange(false);
}

function afterPointChange(fromGps) {
  // Draw / update the route line.
  if (state.start && state.dest) {
    const latlngs = [state.start, state.dest];
    if (!routeLine) {
      routeLine = L.polyline(latlngs, {
        color: '#2bb3ff',
        weight: 3,
        dashArray: '6 6',
      }).addTo(map);
    } else {
      routeLine.setLatLngs(latlngs);
    }
    const dist = greatCircleNM(state.start, state.dest);
    els.computedDistance.innerHTML = `Great-circle distance: <strong>${dist.toFixed(1)} NM</strong>`;
    // Only auto-fit when the user is setting points by hand, not on every GPS tick.
    if (!fromGps) map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
  } else {
    els.computedDistance.textContent = 'Great-circle distance: —';
  }
  if (state.distanceMode === 'map') recalculate();
  else saveSettings();
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
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const acc = pos.coords.accuracy ? ` (±${Math.round(pos.coords.accuracy)} m)` : '';
      els.gpsStatus.classList.remove('err');
      els.gpsStatus.textContent =
        `Live: ${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}${acc} · updated ${new Date().toLocaleTimeString()}`;
      setStart(pt, { fromGps: true });
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
        setPoint: state.setPoint,
        useCurrent: state.useCurrent,
        distance: els.distance.value,
        speedMin: els.speedMin.value,
        speedMax: els.speedMax.value,
        speedStep: els.speedStep.value,
        departureTime: els.departureTime.value,
        start: state.start,
        dest: state.dest,
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

  // Plain input values.
  if (s.distance != null) els.distance.value = s.distance;
  if (s.speedMin != null) els.speedMin.value = s.speedMin;
  if (s.speedMax != null) els.speedMax.value = s.speedMax;
  if (s.speedStep != null) els.speedStep.value = s.speedStep;
  if (s.departureTime) els.departureTime.value = s.departureTime;

  // Modes (also updates the matching tab UI / panes).
  if (s.setPoint) {
    state.setPoint = s.setPoint;
    const radio = document.querySelector(`input[name="setpoint"][value="${s.setPoint}"]`);
    if (radio) radio.checked = true;
  }
  if (s.distanceMode) setDistanceMode(s.distanceMode);
  if (s.departureMode) setDepartureMode(s.departureMode);

  // Saved coordinates.
  if (s.dest) setDest(s.dest);
  if (s.start && !s.useCurrent) setStart(s.start);

  // Restore live-location tracking last so it can override the saved start.
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
  els.startLat.disabled = on;
  els.startLng.disabled = on;
  if (startMarker) startMarker.dragging[on ? 'disable' : 'enable']();
  if (on) {
    startWatchingLocation();
  } else {
    stopWatchingLocation();
    state.gpsCentered = false; // recenter again next time GPS is enabled
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
  [els.distance, els.speedMin, els.speedMax, els.speedStep, els.departureTime].forEach((el) =>
    el.addEventListener('input', recalculate)
  );

  // Manual coordinate entry.
  const readStart = () => {
    const lat = parseFloat(els.startLat.value);
    const lng = parseFloat(els.startLng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setStart({ lat, lng });
  };
  const readDest = () => {
    const lat = parseFloat(els.destLat.value);
    const lng = parseFloat(els.destLng.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setDest({ lat, lng });
  };
  els.startLat.addEventListener('change', readStart);
  els.startLng.addEventListener('change', readStart);
  els.destLat.addEventListener('change', readDest);
  els.destLng.addEventListener('change', readDest);

  // Which point map clicks set.
  document.querySelectorAll('input[name="setpoint"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.setPoint = e.target.value; saveSettings(); })
  );

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

  recalculate();
  // Keep ETAs honest when departing "now" without any other input changing.
  setInterval(() => { if (state.departureMode === 'now') recalculate(); }, 30000);
}

document.addEventListener('DOMContentLoaded', init);
