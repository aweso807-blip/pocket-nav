# Pocket Nav

Pocket Nav is a free, deployable web app for walking navigation with turn signals:

- Right turn: single pulse
- Left turn: double pulse
- Upcoming turn pre-alert: triple pulse
- U-turn: unique triple-strong pulse
- Off-route: long pulse
- Disconnect / GPS loss / rerouting / cancel: dedicated patterns

It also includes:

- Live destination suggestions while typing
- Nearest-first ranking (distance from current location)
- Audio tones as backup cues

## Quick start (local)

Use any static server:

```powershell
npx serve .
```

Then open the shown URL on your phone.

## Free deploy options

## 1) GitHub Pages (free)

1. Push this folder to a GitHub repo.
2. In GitHub: `Settings -> Pages`.
3. Source: `Deploy from a branch`, pick `main` and `/root`.
4. Open your Pages URL on iPhone and add to Home Screen.

## 2) Cloudflare Pages (free)

1. Create a new Pages project from your GitHub repo.
2. Build command: none.
3. Output directory: `/`.
4. Deploy.

## How to use

1. Tap `Use My Current Location`.
2. Enter destination.
3. Tap `Build Route`.
4. Tap `Start Pocket Navigation`.

## Important iPhone reality

iOS Safari/PWA has strict limits:

- Vibration API/haptic behavior is limited or unavailable in many iPhone setups.
- Web apps do not reliably run full background turn-by-turn logic after lock/pocket conditions.

This project still works as a web prototype, but for reliable iPhone haptics while phone is in pocket, wrap this in a native shell (Capacitor + iOS Haptics plugin) and run from an installed iOS app.

## APIs used

- OpenStreetMap tiles
- Nominatim geocoding
- OSRM public routing (`foot` profile)

For heavy use, switch to your own routing/geocoding provider.
