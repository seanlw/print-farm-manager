# Spoolman Integration

Optional integration with [Spoolman](https://github.com/Donkie/Spoolman), a self-hosted filament inventory manager (vendor → filament type → physical spool, with remaining-weight tracking). Requested in [upstream issue #21](https://github.com/joeltelling/print-farm-manager/issues/21).

**Off by default.** Until `spoolman_enabled` is set to `true` and a base URL is configured, this integration makes no network calls and has zero effect on the farm.

Endpoint shapes were verified directly against Spoolman's own source (`spoolman/api/v1/{spool,filament,vendor}.py`, `spoolman/main.py` on the `Donkie/Spoolman` GitHub repo, master branch), not guessed.

## Status

This is being built incrementally, in independently-working chunks:

1. **Settings + read-only library proxy**: enable/disable, base URL, a server-side proxy so the browser never talks to Spoolman directly, and a connectivity status check.
2. **Filament Library UI switch**: every material/color picker on the farm, and the Settings Filament Library section itself, source from Spoolman instead of the local library while enabled. See `docs/filaments.md`'s "Spoolman mode" section.
3. **Loaded-spool binding**: bind a specific Spoolman spool to a printer; `loaded_material`/`loaded_color` are derived from it. See "Loaded-spool binding" below.
4. **Usage tracking** (this chunk): reports consumed grams to Spoolman on print completion. See "Usage tracking" below.

## Settings

Stored in the existing `settings` key/value table (`server/db.js`), no new table.

| Key | Values | Default | Notes |
|---|---|---|---|
| `spoolman_enabled` | `'true'` \| `'false'` | `'false'` | Seeded on every install. |
| `spoolman_base_url` | `http://...` or `https://...`, ≤200 chars | not set | No default row (absence means "not configured", checked explicitly rather than defaulting to an empty string). |

Set via `PUT /api/settings/:key` (see `docs/api.md`). Changing `spoolman_base_url` clears the integration's internal cache immediately so a URL change never serves data from the old origin.

**Turning `spoolman_enabled` on clears stale loaded-material data.** On the `false` → `true` transition only (not on every re-save), every printer with no bound spool (`spoolman_spool_id IS NULL`) has its `loaded_material`/`loaded_color` cleared to `NULL`, with an `info_changed` event logged per affected printer. This exists because those two fields might still be holding whatever was picked from the old manual library before the integration was turned on, and once Spoolman is the source of truth that data no longer traces back to anything real, it would otherwise sit there looking exactly like it came from a bound spool. Printers with a bound spool are untouched. The operator rebinds (or, if disabling again, manually re-picks) to set them again.

## `server/integrations/spoolman.js`

The server-side client module. Every exported function checks `isEnabled(db)` first and either no-ops or throws a typed `{ code: 'SPOOLMAN_DISABLED' }` error, so a farm that never touches the setting incurs one cheap `settings` table lookup and no network calls, ever.

| Function | Spoolman endpoint | Notes |
|---|---|---|
| `getStatus(db)` | `GET /api/v1/info` | Connectivity check; never throws. |
| `listVendors(db)` | `GET /api/v1/vendor` | Cached 60s. |
| `listFilaments(db)` | `GET /api/v1/filament` | Cached 60s. |
| `listSpools(db, query)` | `GET /api/v1/spool` | Query params passed through; cached 60s per distinct query. |
| `getSpool(db, id)` | `GET /api/v1/spool/:id` | Never cached (callers that bind a spool need the freshest data). |
| `reportJobUsage(db, jobId)` | `PUT /api/v1/spool/:id/use` | Reports a finished job's consumed grams, once. See "Usage tracking" below. |

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
Proxies `GET /api/v1/filament`. Returns Spoolman's filament type list unmodified (includes nested `vendor`, `material`, `name`, `color_hex`).

### `GET /api/spoolman/spools`
Proxies `GET /api/v1/spool`. Query parameters (e.g. `allow_archived`, `filament.material`) are passed straight through to Spoolman.

### `GET /api/spoolman/spools/:id`
Proxies `GET /api/v1/spool/:id`. `404` if Spoolman reports the spool doesn't exist.

## Filament Library UI switch

`client/src/useFilamentLibrary.js` is the shared hook every picker uses. It checks `spoolman_enabled` on mount and either fetches `/api/filaments/types` + `/api/filaments/colors` (local mode) or `/api/spoolman/filaments` grouped into the same `{ id, name }` / `{ id, name, hex_color, type_name }` shape (Spoolman mode), so the picker JSX in Settings.jsx, PrinterDetail.jsx, Printers.jsx, and Projects.jsx needs no branching of its own. In Spoolman mode, a color's `name` (and therefore its picker value) is the filament's own `Filament.name`, not its hex code, since a hex string is unreadable in a dropdown; `hex_color` is carried along for reference only. See `docs/filaments.md`'s "Spoolman mode" section for the case-sensitive matching caveat this introduces.

While enabled, the Filament Library section in Settings renders read-only (grouped vendor, material, color, filament name), and hides its manual Add Type/Add Color forms rather than deleting the underlying local tables, so disabling the integration instantly restores manual editing. A "Manage in Spoolman" link opens `spoolman_base_url` directly in a new tab (`target="_blank"`) for adding vendors, filaments, or spools, since none of that management happens in this app. This assumes the same URL is reachable from both the server (which already proxies through it) and the operator's browser, true for any normal self-hosted Spoolman instance on the farm's LAN.

## Loaded-spool binding

Two new columns on `printers` (additive, see `docs/database.md`): `spoolman_spool_id` (the bound spool, NULL = unbound) and `spoolman_report_usage` (per-printer opt-in for usage tracking, default off, see "Usage tracking" below).

Three new `printers.js` action endpoints, documented in full in `docs/api.md`: `POST /api/printers/:id/spoolman-bind`, `spoolman-unbind`, `spoolman-sync`.

**Snapshot-on-bind, not a live lookup.** Binding fetches the spool once via `spoolman.getSpool(db, id)` and writes `loaded_material`/`loaded_color` through the exact same columns `PUT /api/printers/:id` already uses, deriving the color as `filament.name` (e.g. `"Prusament PETG Signal Red"`), gated on `color_hex` being present so a multi-color filament is treated as having no color rather than guessed. This is the same field, same derivation `useFilamentLibrary.js`'s picker uses for a Spoolman color's value, so a bound printer's `loaded_color` and a gcode's `required_color` picked from the dropdown stay comparable. Deliberately not the hex code: the scheduler's dispatch reservation (`_reserveJob`) is synchronous by design, with no I/O, so nothing in the bind/unbind/sync path may be on that call path, and the scheduler itself never learns Spoolman exists, it just keeps reading `loaded_material`/`loaded_color` as plain strings, which now happen to be human-readable ones.

**Staying in sync is manual, not polled.** If the bound spool's filament data changes in Spoolman later, use `spoolman-sync` (a "Sync from Spoolman" button in PrinterDetail) to re-fetch and re-snapshot. This is not folded into the 15 second poller: entangling two independently-failing systems' error handling for something that changes rarely isn't worth it, and matches this app's general preference for the operator resolving ambiguity over the system inferring it.

**Unbinding does not clear the snapshot.** `spoolman-unbind` only clears `spoolman_spool_id`; `loaded_material`/`loaded_color` keep their last value, exactly as if the operator had typed them in manually. The scheduler's dispatch eligibility does not change just because a spool was unbound.

**UI**: PrinterDetail's "Spoolman Spool" card, shown only while the integration is enabled. Unbound: a spool picker (from `GET /api/spoolman/spools?allow_archived=false`) plus a Bind button. Bound: the current material/color, plus Sync and Unbind buttons. A "Report usage to Spoolman" checkbox sets `spoolman_report_usage`, saved immediately like a normal field edit; see "Usage tracking" below for what it controls.

**Manual material/color picking is disabled farm-wide while Spoolman is enabled, not just on a bound printer.** PrinterDetail's Material/Color edit fields are read-only whenever the integration is on (with a hint pointing at either the bound spool or, if unbound, at the Spoolman Spool card above), the Add Printer form in Settings hides its Loaded Material/Color fields entirely (a new printer can't be bound until it exists, so binding happens afterward via PrinterDetail), and the Printers page's bulk-edit bar drops its Material/Color controls (bulk-setting free text would bypass the one-spool-per-printer binding model). The intent: once Spoolman is the source of truth, there should be no way to end up with a printer's `loaded_material`/`loaded_color` that didn't come from a real bound spool.

## Usage tracking

On print completion, reports the grams actually consumed to Spoolman via `PUT /api/v1/spool/:id/use` (`{ use_weight: grams }`), so the spool's remaining weight in Spoolman stays accurate. This is the only part of the integration that touches code paths adjacent to `parts.completed_qty`, so it's worth being explicit: **it never does.** `reportJobUsage` is called strictly *after* the existing credit statement in every hook point, reads state that already exists, and its outcome only ever affects a log line, a notification, or a `spoolman_warning` response field, never a `parts`/`jobs` quantity or status.

Two new columns on `jobs` (additive): `spoolman_spool_id` (a snapshot of the bound spool at dispatch time, same rationale as `parts_per_plate`'s own snapshot) and `spoolman_reported_at` (set once usage has been reported for that job; the idempotency guard).

**`reportJobUsage(db, jobId)` never throws.** Every outcome is a typed `{ ok, reason }` return:

1. `disabled`: the integration isn't enabled.
2. `not-found`: no such job.
3. `already-reported`: `spoolman_reported_at` is already set. Safe to call any number of times for the same job.
4. `opted-out`: the printer's `spoolman_report_usage` is off. This is the double-counting guard the issue itself asked for: a printer that already reports its own usage to Spoolman natively (e.g. Klipper/Moonraker) should not also get decremented by this app. Off by default; the operator opts a printer in via the checkbox in PrinterDetail's Spoolman Spool card.
5. `not-bound`: neither the job's snapshot nor the printer's current binding has a spool id.
6. `no-parsed-usage`: the job's G-code has no `filament_used_grams` yet (never opened in the 3D viewer, never "Parse G-code"d). A passive notification is added; this isn't operator-actionable at the moment the job finishes, so it's not surfaced as a warning.
7. `http-error`: the PUT to Spoolman failed. `error` holds the message.
8. success: `{ ok: true, grams }`, and `jobs.spoolman_reported_at` is set.

**The grams formula reads `gcodes.filament_used_grams`, never `material_grams`.** This is deliberate: `material_grams` is a plain form field the operator can type by hand via `PUT /api/gcodes/:id`; `filament_used_grams` is written only by `parseFilamentUsage` (`server/gcode-decode.js`) reading the sliced file's own metadata. The user's requirement was "not a guessed number", and `filament_used_grams` is the one field that can never contain a human's guess.

```
grams = job.parts_per_plate * (gcode.filament_used_grams / gcode.parts_per_plate)
```

`job.parts_per_plate` is frozen at dispatch; `gcode.parts_per_plate` is the current live value. Same proration shape as the dashboard's existing per-job material stat (`server/routes/dashboard.js`), just a different source column.

**Hook points, all strictly after the existing `completed_qty` credit:**

- `scheduler.js` `_handleFinished`: the automatic FINISHED path. Fire-and-forget (`.catch()`'d): this is a background code path, not a request, so there's no response to attach a warning to, and a Spoolman blip must never become an unhandled rejection (the process-level handler in `index.js` calls `process.exit(1)`).
- `index.js` `POST /api/printers/:id/set-ready`: the missed-finish credit branch only (the normal-finish delta path doesn't create a new credit event, so nothing to report; idempotency would no-op it safely anyway). Awaited, since this is an operator-initiated action; `spoolman_warning` appears in the response only when `reason === 'http-error'`.
- `printers.js` `POST /api/printers/:id/complete-and-decommission`: same pattern as set-ready, missed-finish branch only.
- `printers.js` `POST /api/printers/:id/mark-job-failure`: **not** hooked to reverse a report. See the named limitation below.

**Marking a Spoolman-reported job failed does not reverse the report.** Spoolman's `/use` endpoint semantics for a negative amount aren't documented in what's available from the Spoolman API source, and guessing an external API's undocumented behavior is the same class of mistake as guessing a printer protocol field. If `mark-job-failure` matches a job with `spoolman_reported_at` already set, it adds a notification telling the operator to adjust the spool's remaining weight manually in Spoolman. A named v1 limitation, not a silent gap.

**Hardware-validation honesty:** this layer makes no printer/driver calls at all, it only reads the already-shipped, already-tested `parseFilamentUsage` output. The one genuinely unvalidated surface is the Spoolman HTTP contract itself: `PUT /api/v1/spool/:id/use` was implemented from Spoolman's API source (`Donkie/Spoolman`, master), not yet validated against a live Spoolman instance.

## Settings UI

The **Spoolman Integration** section in Settings has an enable checkbox (saved immediately on toggle) and a base URL field with its own Save button. While enabled, a connectivity indicator below shows whether the configured Spoolman instance is currently reachable, fetched on page load (not polled).
