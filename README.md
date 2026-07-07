# 3dWorks Online Dashboard

A local web app for pricing 3D print jobs and keeping an eye on your printers, filament storage, and quote/order history — all in one dashboard you can open from a browser on your computer, phone, or tablet.

## Features

- **Pricing Calculator** — cost breakdown (filament, electricity, maintenance, labor) with a 20% filament waste allowance built in, quick-pick markup tiers (2×/3×/3.5×), a custom-price override, and discount support.
- **Live Printer Status** — real-time state, progress, time remaining, and temperatures for:
  - **Bambu Lab** printers (LAN mode, via local MQTT)
  - **OctoPrint**
  - **Moonraker / Klipper**
- **Filament Storage Monitoring** — humidity and temperature readouts for dry boxes, AMS units, and room sensors, pulled from **Home Assistant**, with a high-humidity warning banner.
- **Quotes** — save a calculated price as a customer quote, print/PDF it as a formatted document.
- **History** — every saved calculation is logged and fully editable (change any input and it recalculates), with CSV export and a print view.
- **Backups** — one-click manual backup download, plus automatic daily backups written to disk.
- **Mobile-friendly** — responsive layout; open it in Safari on iPhone/iPad and use "Add to Home Screen" for a full-screen, app-like experience.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (uses the built-in `fetch` API)
- npm

## Getting Started

```bash
git clone https://github.com/kd5dmg/3dworks-online-dashboard.git
cd 3dworks-online-dashboard
npm install
npm start
```

Then open **http://localhost:3141** in your browser.

On macOS, you can also just double-click **`Launch Pricer.command`** — it installs dependencies on first run and opens the app automatically.

The server binds to your whole network, not just localhost, so it also prints a network URL (e.g. `http://192.168.x.x:3141`) — open that on your phone or tablet while on the same Wi-Fi.

## Usage

### Dashboard
Live status cards for every printer you've configured, plus job/revenue/profit stats and recent activity.

### Calculator
Pick a printer, filament, and labor rate; enter grams, print time, and labor hours. Click **Calculate Price** to see the full cost breakdown and suggested price at three markup tiers, or type your own markup/custom price. **Save to History** or **Save as Quote** when you're happy with it.

### Filaments / Labor Rates / Printers
Manage your reusable profiles — filament cost per kg, labor rates, and printer wattage/maintenance cost.

### Printers — connecting live status
Edit a printer and pick a **Live status source**:
- **OctoPrint** — host/IP, port, and an API key (OctoPrint → Settings → API)
- **Bambu Lab (LAN mode)** — host/IP, serial number, and LAN access code (from the printer's network settings screen)
- **Moonraker (Klipper)** — host/IP and port (API key optional, only needed if your Moonraker instance requires one)

Each printer also gets an "Open printer interface" link on the Dashboard if you set one in `PRINTER_LINKS` in `renderer/app.js`.

### Filament Storage (Home Assistant)
In **Settings**, enter your Home Assistant URL and a [Long-Lived Access Token](https://www.home-assistant.io/docs/authentication/#your-account-profile) (from your HA profile page). The **Filament Storage** tab shows humidity/temperature sensors grouped by location — edit the `HA_SECTIONS` list in `renderer/app.js` to match your own entity IDs.

### Quotes
Turn a calculation into a customer-facing quote with a valid-until date and notes, then print or save as PDF.

### History
Every saved calculation is listed with an edit (✏️) button — change any field and the whole cost breakdown recalculates, exactly like the main calculator (including the custom-price override).

### Settings
Global electricity rate and commission percentage, Home Assistant connection, and backups.

## Data & Backups

All your data (printers, filaments, quotes, history, settings — including any API keys/tokens you enter) is stored locally in `data/pricer-data.json`, which is git-ignored and never leaves your machine.

- **Manual backup**: Settings → Download Backup (lets you choose where to save, on browsers that support it).
- **Automatic backup**: a dated JSON snapshot is written on every save and once per server startup. The location is hardcoded in `server.js` (`BACKUP_DIR`) — change that path to wherever you'd like backups stored on your own machine.

## Notes

- Printer connections (OctoPrint/Bambu/Moonraker) and Home Assistant all rely on your local network — everything runs from your own machine, no cloud services involved.
- There's no login/authentication on the server itself, so anyone on your Wi-Fi network can access it. Fine for home use; keep that in mind before exposing it beyond your LAN.
