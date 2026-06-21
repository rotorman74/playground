# ⛵ Sailing ETA Calculator

A single-page web app that estimates arrival times for a passage across a
**range of speeds**, and tells you how many **nights at sea** each speed implies.

No build step, no API keys — just open `index.html`.

## Features

- **Speed sweep** — enter a min, max, and step (e.g. 3.0 → 9.0 kn in 0.5 kn
  increments) and get an ETA for every speed at once.
- **Nights at sea** — each row shows how many local midnights the passage crosses.
- **Departure now or later** — calculate from the current time or pick a future
  date & time.
- **Two ways to get distance:**
  1. Enter the distance directly in nautical miles, or
  2. Set a **start** and **destination** on a satellite map (click, drag, or type
     coordinates) and the great-circle distance is computed for you.
- **Live current location** — tick *Use current location* and the start point
  follows your device's GPS. ETAs recompute automatically as you move.

## Usage

Open `index.html` in a browser. For live GPS the page must be served over
`https://` (or `localhost`) — browsers block geolocation on `file://` and plain
HTTP. A quick local server:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How things are calculated

- **Distance** between two points uses the great-circle (haversine) formula with
  a mean Earth radius of 3440.065 NM.
- **Duration** = distance ÷ speed (knots are nautical miles per hour).
- **ETA** = departure time + duration, shown in your local timezone.
- **Nights** = the number of local midnights between departure and arrival.

## Tech

Vanilla HTML/CSS/JS with [Leaflet](https://leafletjs.com/) for the map and Esri
World Imagery for satellite tiles. The browser Geolocation API provides live
position.
