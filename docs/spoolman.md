# Spoolman Integration

Optional integration with [Spoolman](https://github.com/Donkie/Spoolman), a self-hosted filament inventory manager (vendor → filament type → physical spool, with remaining-weight tracking). Requested in [upstream issue #21](https://github.com/joeltelling/print-farm-manager/issues/21).

**Off by default.** Until `spoolman_enabled` is set to `true` and a base URL is configured, this integration makes no network calls and has zero effect on the farm.

Endpoint shapes were verified directly against Spoolman's own source (`spoolman/api/v1/{spool,filament,vendor}.py`, `spoolman/main.py` on the `Donkie/Spoolman` GitHub repo, master branch), not guessed.

## Status

This is being built incrementally, in independently-working chunks:

1. **Settings + read-only library proxy**: enable/disable, base URL, a server-side proxy so the browser never talks to Spoolman directly, and a connectivity status check.
2. **Filament Library UI switch**: every material/color picker on the farm, and the Settings Filament Library section itself, source from Spoolman instead of the local library while enabled. See `docs/filaments.md`'s "Spoolman mode" section.
3. **Loaded-spool binding** (this chunk): bind a specific Spoolman spool to a printer; `loaded_material`/`loaded_color` are derived from it. See "Loaded-spool binding" below.
4. Usage tracking (report consumed grams to Spoolman on print completion): planned, not yet implemented.

## Settings

Stored in the existing `settings` key/value table (`server/db.js`), no new table.

| Key | Values | Default | Notes |
|---|---|---|---|
| `spoolman_enabled` | `'true'` \| `'false'` | `'false'` | Seeded on every install. |
| `spoolman_base_url` | `http://...` or `https://...`, ≤200 chars | not set | No default row (absence means "not configured", checked explicitly rather than defaulting to an empty string). |

Set via `PUT /api/settings/:key` (see `docs/api.md`). Changing `spoolman_base_url` clears the integration's internal cache immediately so a URL change never serves data from the old origin.

## `server/integrations/spoolman.js`

The server-side client module. Every exported function checks `isEnabled(db)` first and either no-ops or throws a typed `{ code: 'SPOOLMAN_DISABLED' }` error, so a farm that never touches the setting incurs one cheap `settings` table lookup and no network calls, ever.

| Function | Spoolman endpoint | Notes |
|---|---|---|
| `getStatus(db)` | `GET /api/v1/info` | Connectivity check; never throws. |
| `listVendors(db)` | `GET /api/v1/vendor` | Cached 60s. |
| `listFilaments(db)` | `GET /api/v1/filament` | Cached 60s. |
| `listSpools(db, query)` | `GET /api/v1/spool` | Query params passed through; cached 60s per distinct query. |
| `getSpool(db, id)` | `GET /api/v1/spool/:id` | Never cached (callers that bind a spool need the freshest data). |

All requests use an 8 second timeout, matching this codebase's existing driver convention.

## API Endpoints: `server/routes/spoolman.js`

Mounted at `/api/spoolman`. The browser never needs Spoolman's base URL or talks to it directly: every request goes through this proxy. Every route returns `400` if the integration is disabled, and `502` with the upstream error message if Spoolman can't be reached.

### `GET /api/spoolman/status`
```json
{ "enabled": true, "base_url": "http://spoolman.local:7912", "reachable": true }
```
`reachable: false` includes an `error` field when the integration is enabled but the connectivity check failed.

### `GET /api/spoolman/vendors`
Proxies `GET /api/v1/vendor`. Returns Spoolman's vendor list unmodified.

### `GET /api/spoolman/filaments`
Proxies `GET /api/v1/filament`. Returns Spoolman's filament type list unmodified (includes nested `vendor`, `material`, `color_hex`, see the field note below).

### `GET /api/spoolman/spools`
Proxies `GET /api/v1/spool`. Query parameters (e.g. `allow_archived`, `filament.material`) are passed straight through to Spoolman.

### `GET /api/spoolman/spools/:id`
Proxies `GET /api/v1/spool/:id`. `404` if Spoolman reports the spool doesn't exist.

## Filament Library UI switch

`client/src/useFilamentLibrary.js` is the shared hook every picker uses. It checks `spoolman_enabled` on mount and either fetches `/api/filaments/types` + `/api/filaments/colors` (local mode) or `/api/spoolman/filaments` grouped into the same `{ id, name }` / `{ id, name, hex_color, type_name }` shape (Spoolman mode), so the picker JSX in Settings.jsx, PrinterDetail.jsx, Printers.jsx, and Projects.jsx needs no branching of its own. See `docs/filaments.md`'s "Spoolman mode" section for the color-format bridge and the case-sensitive matching caveat this introduces.

While enabled, the Filament Library section in Settings renders read-only (grouped vendor, material, color, filament name), and hides its manual Add Type/Add Color forms rather than deleting the underlying local tables, so disabling the integration instantly restores manual editing.

## Loaded-spool binding

Two new columns on `printers` (additive, see `docs/database.md`): `spoolman_spool_id` (the bound spool, NULL = unbound) and `spoolman_report_usage` (per-printer opt-in for the usage-tracking chunk still to come, default off).

Three new `printers.js` action endpoints, documented in full in `docs/api.md`: `POST /api/printers/:id/spoolman-bind`, `spoolman-unbind`, `spoolman-sync`.

**Snapshot-on-bind, not a live lookup.** Binding fetches the spool once via `spoolman.getSpool(db, id)` and writes `loaded_material`/`loaded_color` through the exact same columns `PUT /api/printers/:id` already uses, deriving the color as `'#' + filament.color_hex.toUpperCase()` (see the field-format note above). This is deliberate: the scheduler's dispatch reservation (`_reserveJob`) is synchronous by design, with no I/O, so nothing in the bind/unbind/sync path may be on that call path, and the scheduler itself never learns Spoolman exists, it just keeps reading `loaded_material`/`loaded_color` as plain strings.

**Staying in sync is manual, not polled.** If the bound spool's filament data changes in Spoolman later, use `spoolman-sync` (a "Sync from Spoolman" button in PrinterDetail) to re-fetch and re-snapshot. This is not folded into the 15 second poller: entangling two independently-failing systems' error handling for something that changes rarely isn't worth it, and matches this app's general preference for the operator resolving ambiguity over the system inferring it.

**Unbinding does not clear the snapshot.** `spoolman-unbind` only clears `spoolman_spool_id`; `loaded_material`/`loaded_color` keep their last value, exactly as if the operator had typed them in manually. The scheduler's dispatch eligibility does not change just because a spool was unbound.

**UI**: PrinterDetail's "Spoolman Spool" card, shown only while the integration is enabled. Unbound: a spool picker (from `GET /api/spoolman/spools?allow_archived=false`) plus a Bind button. Bound: the current material/color, plus Sync and Unbind buttons. A "Report usage to Spoolman" checkbox sets `spoolman_report_usage`, saved immediately like a normal field edit; it has no effect yet, the usage-tracking chunk is what will read it.

**Manual material/color picking is disabled farm-wide while Spoolman is enabled, not just on a bound printer.** PrinterDetail's Material/Color edit fields are read-only whenever the integration is on (with a hint pointing at either the bound spool or, if unbound, at the Spoolman Spool card above), the Add Printer form in Settings hides its Loaded Material/Color fields entirely (a new printer can't be bound until it exists, so binding happens afterward via PrinterDetail), and the Printers page's bulk-edit bar drops its Material/Color controls (bulk-setting free text would bypass the one-spool-per-printer binding model). The intent: once Spoolman is the source of truth, there should be no way to end up with a printer's `loaded_material`/`loaded_color` that didn't come from a real bound spool.

## Settings UI

The **Spoolman Integration** section in Settings has an enable checkbox (saved immediately on toggle) and a base URL field with its own Save button. While enabled, a connectivity indicator below shows whether the configured Spoolman instance is currently reachable, fetched on page load (not polled).
