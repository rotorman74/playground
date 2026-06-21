# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Sailing ETA Calculator — a single-page, static web app (vanilla HTML/CSS/JS,
no build step). It estimates arrival times across a configurable range of
speeds and shows nights at sea.

- `index.html` — markup
- `styles.css` — styles
- `app.js` — all logic (geo math, ETA table, map, geolocation, persistence)
- Map: Leaflet + Esri World Imagery (satellite); no API keys
- Distance is either entered manually or measured from a **multi-leg route**
  built on the map (start/live position + waypoints; total = sum of
  great-circle legs)
- Each speed row can be expanded into a 3-hourly timeline of position, course,
  **ECMWF wind** (fetched client-side from Open-Meteo's `/v1/ecmwf` endpoint,
  knots; true + apparent, gusts) and **ocean currents** (set/drift from
  Open-Meteo's Marine API, with along-course effect), including wind angle
  relative to the boat (bow up)
- User settings persist to `localStorage` (`sailing-eta-settings-v2`)

## Results table

Columns (no header row, compact single-line), ordered **fastest speed first**:
**speed** (number only, 1 decimal), **nights** (calendar midnights crossed to
arrival), **arrival time** (HH:MM), **date** (weekday + day of month; the short
month name is appended only when the month differs from the row above).

## Releases & versioning

The app version is shown in the footer and defined as `APP_VERSION` in `app.js`.

**Bump `APP_VERSION` automatically on every release — do NOT ask the user.**
Increment the patch number for fixes/small tweaks, the minor number for new
user-facing features. Then commit and deploy.

## Deployment

GitHub Pages via `.github/workflows/deploy-pages.yml`. The `github-pages`
environment only permits deploys from the repository's **default branch**, so
deploy by running that workflow on the default branch. (If the default branch
is `main`, pushes to `main` auto-deploy.)

Live site: https://rotorman74.github.io/playground/
