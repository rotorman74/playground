/* Sailing ETA Calculator
 * - Computes ETA across a configurable range of speeds (knots)
 * - Distance from manual entry OR a multi-leg route built on the map
 * - Departure "now" or a chosen future time
 * - Live recompute when the route starts from the device's current location
 */

'use strict';

// Bump this on each release (auto-incremented — see CLAUDE.md).
const APP_VERSION = '1.6.2';
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
  moveIndex: null,            // waypoint index currently being relocated, or null
  expanded: new Set(),        // speed labels whose wind detail is expanded
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
  moveBanner: $('move-banner'),
  moveCancel: $('move-cancel'),
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

// Initial great-circle bearing from a to b, in degrees (0 = north, clockwise).
function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Point a fraction f (0..1) of the way along the great circle from a to b.
function interpolate(a, b, f) {
  const δ = greatCircleNM(a, b) / EARTH_NM;
  if (δ === 0) return { lat: a.lat, lng: a.lng };
  const φ1 = toRad(a.lat), λ1 = toRad(a.lng);
  const φ2 = toRad(b.lat), λ2 = toRad(b.lng);
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI,
    lng: Math.atan2(y, x) * 180 / Math.PI,
  };
}

// Position (and course) at a given distance (NM) along the current route path.
function positionAtDistance(path, d) {
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const leg = greatCircleNM(path[i], path[i + 1]);
    if (d <= acc + leg || i === path.length - 2) {
      const f = leg > 0 ? (d - acc) / leg : 0;
      const pos = interpolate(path[i], path[i + 1], Math.min(1, Math.max(0, f)));
      return { lat: pos.lat, lng: pos.lng, course: bearingDeg(path[i], path[i + 1]) };
    }
    acc += leg;
  }
  const last = path[path.length - 1];
  const prev = path[path.length - 2];
  return { lat: last.lat, lng: last.lng, course: bearingDeg(prev, last) };
}

// 3-hourly samples along the route for a given speed, from departure to arrival.
function sampleRoute(speed, distance, departure) {
  const path = pathPoints();
  if (path.length < 2 || !(speed > 0)) return [];
  const arrivalH = distance / speed;
  const samples = [];
  const STEP_H = 3;
  const MAX = 200;
  for (let h = 0; ; h += STEP_H) {
    if (speed * h >= distance) {
      samples.push({
        date: new Date(departure.getTime() + arrivalH * 3600 * 1000),
        ...positionAtDistance(path, distance),
        arrived: true,
      });
      break;
    }
    samples.push({
      date: new Date(departure.getTime() + h * 3600 * 1000),
      ...positionAtDistance(path, speed * h),
      arrived: false,
    });
    if (samples.length >= MAX) break;
  }
  return samples;
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

// ── Wind (ECMWF via Open-Meteo) ────────────────────────────────────
const windCache = new Map();   // key -> { speed, dir, gust } | null (unavailable)
const windPending = new Set();
const detailCache = new Map(); // speed label -> { sig, node } (expanded wind detail)
let windEpoch = 0;             // bumps when wind data changes, to refresh details
let rerenderTimer = null;

function isoHourUTC(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13) + ':00';
}
function windKey(lat, lng, date) {
  return `${lat.toFixed(3)},${lng.toFixed(3)},${isoHourUTC(date)}`;
}

function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(recalculate, 60);
}

// Fetch wind for any samples not already cached. One request per expand.
async function ensureWind(samples) {
  const need = [];
  for (const s of samples) {
    const k = windKey(s.lat, s.lng, s.date);
    if (!windCache.has(k) && !windPending.has(k)) {
      need.push(s);
      windPending.add(k);
    }
  }
  if (!need.length) return;
  const chunk = need.slice(0, 100);

  try {
    const lats = chunk.map((s) => s.lat.toFixed(4)).join(',');
    const lons = chunk.map((s) => s.lng.toFixed(4)).join(',');
    const times = chunk.map((s) => +new Date(s.date));
    const sd = new Date(Math.min(...times)).toISOString().slice(0, 10);
    const ed = new Date(Math.max(...times)).toISOString().slice(0, 10);
    const url =
      `https://api.open-meteo.com/v1/ecmwf?latitude=${lats}&longitude=${lons}` +
      `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn` +
      `&timezone=UTC&start_date=${sd}&end_date=${ed}`;
    const res = await fetch(url);
    const json = await res.json();
    const arr = Array.isArray(json) ? json : [json];

    chunk.forEach((s, i) => {
      const k = windKey(s.lat, s.lng, s.date);
      const loc = arr[i];
      let val = null;
      if (loc && loc.hourly && loc.hourly.time) {
        const idx = loc.hourly.time.indexOf(isoHourUTC(s.date));
        if (idx >= 0) {
          val = {
            speed: loc.hourly.wind_speed_10m[idx],
            dir: loc.hourly.wind_direction_10m[idx],
            gust: loc.hourly.wind_gusts_10m ? loc.hourly.wind_gusts_10m[idx] : null,
          };
        }
      }
      windCache.set(k, val);
      windPending.delete(k);
    });
  } catch (e) {
    chunk.forEach((s) => {
      windCache.set(windKey(s.lat, s.lng, s.date), null);
      windPending.delete(windKey(s.lat, s.lng, s.date));
    });
  }
  windEpoch++; // new wind data → expanded details should rebuild once
  scheduleRerender();
}

// A small arrow glyph rotated to a compass bearing (0 = up/north).
function arrow(bearing, title, color) {
  const c = color ? `;color:${color}` : '';
  return `<span class="dir-arrow" style="transform:rotate(${bearing}deg)${c}" title="${title}">↑</span>`;
}

// Windy-style colour ramp by wind speed (knots).
function windSpeedColor(kn) {
  if (kn < 10) return '#9be15d'; // light green
  if (kn < 20) return '#2bb24a'; // green
  if (kn < 30) return '#ffd23f'; // yellow
  if (kn < 40) return '#ff9f1c'; // orange
  if (kn < 50) return '#e23b3b'; // red
  return '#9b59d0';              // purple
}

// Colour by the boat-relative wind angle (|degrees| off the bow / point of sail).
function relAngleColor(absRel) {
  if (absRel < 45) return '#e23b3b';  // 0–45: red (too close to the wind)
  if (absRel < 60) return '#ff9f1c';  // 45–60: orange
  if (absRel < 90) return '#ffd23f';  // 60–90: yellow
  if (absRel < 135) return '#2bb24a'; // 90–135: green (best reaching)
  return '#ffd23f';                   // 135–180: yellow (running)
}

// Build the expandable per-speed wind detail row.
function buildDetailRow(speed, distance, departure) {
  const samples = sampleRoute(speed, distance, departure);
  ensureWind(samples); // async; fills the cache then re-renders

  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 4;

  let rows = '';
  let prevDom = null;
  for (const s of samples) {
    const w = windCache.get(windKey(s.lat, s.lng, s.date));
    const dom = s.date.getDate();
    const hm = s.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const domLabel = dom !== prevDom ? dom : '';
    prevDom = dom;

    let windCell = '<span class="muted">…</span>';
    let relCell = '';
    if (w === null) {
      windCell = '<span class="muted">n/a</span>';
    } else if (w) {
      const flow = (w.dir + 180) % 360;                 // direction wind blows toward
      const rel = ((w.dir - s.course + 540) % 360) - 180; // wind-from relative to bow
      const relFlow = ((flow - s.course) % 360 + 360) % 360;
      const side = rel === 0 || Math.abs(rel) === 180 ? '' : rel > 0 ? ' S' : ' P';
      windCell =
        `${arrow(flow, 'Wind blowing toward', windSpeedColor(w.speed))} ${Math.round(w.dir)}° · ${Math.round(w.speed)} kn`;
      relCell = `${arrow(relFlow, 'Wind relative to boat', relAngleColor(Math.abs(rel)))} ${Math.abs(Math.round(rel))}°${side}`;
    }

    rows +=
      `<tr><td class="wt-time">${domLabel ? domLabel + ' ' : ''}${hm}</td>` +
      `<td>${arrow(s.course, 'Course')} ${Math.round(s.course)}°</td>` +
      `<td>${windCell}</td>` +
      `<td>${relCell}</td></tr>`;
  }

  td.innerHTML =
    `<table class="wind-table"><thead><tr>` +
    `<th>day · time</th><th>course</th><th>wind</th><th>rel (bow↑)</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
  tr.appendChild(td);
  return tr;
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

  // Wind detail can only be shown for an actual route (positions over time).
  const canExpand = state.distanceMode === 'map' && pathPoints().length >= 2;

  // Fastest speed (earliest arrival) first. Each date part (weekday, day of
  // month, month) is shown only when it changes from the row above.
  let prevDow = null;
  let prevDom = null;
  let prevMonthKey = null;
  for (const speed of speeds.slice().reverse()) {
    const hours = distance / speed;
    const eta = new Date(departure.getTime() + hours * 3600 * 1000);
    const nights = countNights(departure, eta);
    const arrivalTime = eta.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });

    const dow = eta.toLocaleDateString(undefined, { weekday: 'short' });
    const dom = eta.getDate();
    const monthKey = `${eta.getFullYear()}-${eta.getMonth()}`;

    const parts = [];
    if (dow !== prevDow) parts.push(dow);
    if (dom !== prevDom) parts.push(String(dom));
    if (monthKey !== prevMonthKey) parts.push(eta.toLocaleDateString(undefined, { month: 'short' }));
    prevDow = dow;
    prevDom = dom;
    prevMonthKey = monthKey;
    const dateLabel = parts.join(' ');

    const label = speed.toFixed(1);
    const isExpanded = canExpand && state.expanded.has(label);
    const caret = canExpand
      ? `<button type="button" class="exp" data-speed="${label}" aria-label="Toggle wind detail">${isExpanded ? '▾' : '▸'}</button>`
      : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="speed-cell">${caret}${label}</td>
      <td class="nights-cell">${nights}</td>
      <td class="arr-cell">${arrivalTime}</td>
      <td class="dow-cell">${dateLabel}</td>`;

    if (current !== null) {
      const strength = Math.max(0, 1 - Math.abs(speed - current) / HIGHLIGHT_SPAN);
      if (strength > 0) {
        tr.style.background = `rgba(43, 179, 255, ${(strength * 0.5).toFixed(3)})`;
      }
      if (speed === closest) tr.classList.add('current-row');
    }
    body.appendChild(tr);

    if (isExpanded) {
      // Reuse the cached detail unless the route geometry, the 15-min time
      // bucket, or the wind data changed — so it doesn't flicker on every
      // GPS fix / periodic refresh.
      const bucket = Math.floor(departure.getTime() / (15 * 60 * 1000));
      const geom = state.waypoints.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join(';');
      const sig = `${label}|${bucket}|${geom}|${windEpoch}`;
      let entry = detailCache.get(label);
      if (!entry || entry.sig !== sig) {
        entry = { sig, node: buildDetailRow(speed, distance, departure) };
        detailCache.set(label, entry);
      }
      body.appendChild(entry.node);
    }
  }

  saveSettings();
}

// ── Map ────────────────────────────────────────────────────────────
let map, routeLine, routeHit, gpsMarker;
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

  // A tap either relocates the point being moved, or appends a new point.
  map.on('click', (e) => {
    const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (state.moveIndex !== null) {
      if (state.moveIndex < state.waypoints.length) state.waypoints[state.moveIndex] = pt;
      cancelMove();
      updateRoute({ fit: false });
      return;
    }
    state.waypoints.push(pt);
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
      gpsMarker = L.marker(state.gps, {
        icon: routePin('#34d399', '1'), bubblingMouseEvents: false,
      }).addTo(map);
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
      m = L.marker(pt, { draggable: true, bubblingMouseEvents: false }).addTo(map);
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

    const actions = document.createElement('div');
    actions.className = 'wp-popup-actions';

    const mv = document.createElement('button');
    mv.type = 'button';
    mv.className = 'wp-popup-move';
    mv.textContent = 'Move';
    mv.addEventListener('click', () => {
      map.closePopup();
      startMove(m._wpIndex);
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'wp-popup-remove';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => {
      map.closePopup();
      removeWaypoint(m._wpIndex);
    });

    actions.appendChild(mv);
    actions.appendChild(rm);
    popup.appendChild(actions);
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
  cancelMove();
  state.waypoints.splice(i, 1);
  updateRoute({ fit: false });
}

function undoLastPoint() {
  cancelMove();
  state.waypoints.pop();
  updateRoute({ fit: false });
}

function clearRoute() {
  cancelMove();
  state.waypoints = [];
  updateRoute({ fit: false });
}

function updateMapActions() {
  const show = state.distanceMode === 'map' && state.waypoints.length > 0;
  els.mapUndo.classList.toggle('hidden', !show);
  els.mapClear.classList.toggle('hidden', !show);
}

// ── Move a waypoint by tapping the map ──────────────────────────────
function startMove(i) {
  state.moveIndex = i;
  els.moveBanner.classList.remove('hidden');
  const el = map.getContainer();
  el.classList.add('move-mode');
}

function cancelMove() {
  state.moveIndex = null;
  els.moveBanner.classList.add('hidden');
  map.getContainer().classList.remove('move-mode');
}

// ── Insert a waypoint by tapping the route line ─────────────────────
function findInsertSegment(latlng) {
  const path = pathPoints();
  if (path.length < 2) return null;
  const p = map.latLngToLayerPoint(latlng);
  let best = Infinity;
  let segIdx = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = map.latLngToLayerPoint(path[i]);
    const b = map.latLngToLayerPoint(path[i + 1]);
    const d = L.LineUtil.pointToSegmentDistance(p, a, b);
    if (d < best) { best = d; segIdx = i; }
  }
  return segIdx;
}

function insertOnLine(latlng) {
  const seg = findInsertSegment(latlng);
  if (seg === null) return;
  const offset = state.useCurrent && state.gps ? 1 : 0;
  const wpIndex = Math.max(0, seg + 1 - offset);
  state.waypoints.splice(wpIndex, 0, { lat: latlng.lat, lng: latlng.lng });
  updateRoute({ fit: false });
}

function onLineClick(e) {
  // While moving a point, a tap on the line relocates it there.
  if (state.moveIndex !== null) {
    if (state.moveIndex < state.waypoints.length) {
      state.waypoints[state.moveIndex] = { lat: e.latlng.lat, lng: e.latlng.lng };
    }
    cancelMove();
    updateRoute({ fit: false });
    return;
  }
  const div = document.createElement('div');
  div.className = 'wp-popup';
  div.innerHTML = '<div class="wp-popup-name">Insert a waypoint here?</div>';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'wp-popup-move';
  b.textContent = 'Insert point';
  b.addEventListener('click', () => {
    map.closePopup();
    insertOnLine(e.latlng);
  });
  div.appendChild(b);
  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
}

// Central update after any change to the route.
function updateRoute({ fit = false } = {}) {
  const path = pathPoints();
  reconcileMarkers();
  updateMapActions();

  if (path.length >= 2) {
    if (!routeLine) {
      // A wide, invisible line underneath makes the route easy to tap.
      routeHit = L.polyline(path, {
        color: '#000', weight: 24, opacity: 0, bubblingMouseEvents: false,
      }).addTo(map);
      routeHit.on('click', onLineClick);
      routeLine = L.polyline(path, { color: '#2bb3ff', weight: 3, dashArray: '6 6' }).addTo(map);
    } else {
      routeHit.setLatLngs(path);
      routeLine.setLatLngs(path);
    }
  } else {
    if (routeHit) { map.removeLayer(routeHit); routeHit = null; }
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
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
  els.moveCancel.addEventListener('click', cancelMove);

  // Expand / collapse a speed row's wind detail.
  els.tableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.exp');
    if (!btn) return;
    const k = btn.dataset.speed;
    if (state.expanded.has(k)) state.expanded.delete(k);
    else state.expanded.add(k);
    recalculate();
  });

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
