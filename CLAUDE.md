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
- User settings persist to `localStorage` (`sailing-eta-settings-v1`)

## Results table

Columns (no header row, compact single-line): **speed** (number only, 1
decimal), **nights** (calendar midnights crossed to arrival), **arrival time**
(HH:MM), **day of week** of arrival.

## Releases & versioning

The app version is shown in the footer and defined as `APP_VERSION` in
`app.js`.

**IMPORTANT: On every release (any user-visible change being shipped), ASK THE
USER for the new version number before committing.** Do not bump it yourself.
Once they give it:

1. Update `APP_VERSION` in `app.js` to the number they provide.
2. Commit and deploy.

## Deployment

GitHub Pages via `.github/workflows/deploy-pages.yml`. The `github-pages`
environment only permits deploys from the repository's **default branch**, so
deploy by running that workflow on the default branch. (If the default branch
is `main`, pushes to `main` auto-deploy.)

Live site: https://rotorman74.github.io/playground/
