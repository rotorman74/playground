/* Sailing ETA Calculator
 * - Computes ETA across a configurable range of speeds (knots)
 * - Distance from manual entry OR great-circle distance between two map points
 * - Departure "now" or a chosen future time
 * - Live recompute when the start point follows the device's current location
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────
const state = {
  distanceMode: 'manual',     // 'manual' | 'map'
  departureMode: 'now',       // 'now' | 'future'
  setPoint: 'dest',           // which point a map click sets: 'start' | 'dest'
  useCurrent: false,          // start follows GPS
  start: null,                // { lat, lng }
  dest: null,                 // { lat, lng }
  watchId: null,              // geolocation watch handle
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
function formatDuration(hours) {
  const totalMin = Math.round(hours * 60);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

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

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="speed-cell">${speed.toFixed(1)} kn</td>
      <td>${formatDuration(hours)}</td>
      <td>${formatETA(eta)}</td>
      <td><span class="nights-badge${nights === 0 ? ' zero' : ''}">${nights}</span></td>`;
    body.appendChild(tr);
  }
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

// ── Wiring ─────────────────────────────────────────────────────────
function setupTabs() {
  // Distance mode tabs
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.distanceMode = btn.dataset.mode;
      els.manualPane.classList.toggle('hidden', state.distanceMode !== 'manual');
      els.mapPane.classList.toggle('hidden', state.distanceMode !== 'map');
      if (state.distanceMode === 'map') setTimeout(() => map.invalidateSize(), 50);
      recalculate();
    });
  });

  // Departure mode tabs
  document.querySelectorAll('[data-dep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-dep]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.departureMode = btn.dataset.dep;
      els.futurePane.classList.toggle('hidden', state.departureMode !== 'future');
      recalculate();
    });
  });
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
    r.addEventListener('change', (e) => { state.setPoint = e.target.value; })
  );

  // Use-current toggle.
  els.useCurrent.addEventListener('change', (e) => {
    state.useCurrent = e.target.checked;
    els.startLat.disabled = state.useCurrent;
    els.startLng.disabled = state.useCurrent;
    if (startMarker) startMarker.dragging[state.useCurrent ? 'disable' : 'enable']();
    if (state.useCurrent) startWatchingLocation();
    else stopWatchingLocation();
  });

  // Default the future-time picker to one hour from now.
  const soon = new Date(Date.now() + 3600 * 1000);
  soon.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  els.departureTime.value =
    `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}` +
    `T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
}

// ── Init ───────────────────────────────────────────────────────────
function init() {
  initMap();
  setupTabs();
  setupInputs();
  recalculate();
  // Keep ETAs honest when departing "now" without any other input changing.
  setInterval(() => { if (state.departureMode === 'now') recalculate(); }, 30000);
}

document.addEventListener('DOMContentLoaded', init);
