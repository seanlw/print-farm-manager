# Multi-Brand Printer Support

> **Phase 6C added (2026-04-20).** Klipper (Moonraker) connector complete — covers Voron and all Klipper-firmware printers. Prusa Link, Elegoo SDCP, Bambu, and Klipper are all fully supported.

## Overview

The system was built against PrusaLink (Prusa's REST API). The `type` column on the `printers` table has always anticipated future brands. Phase 6 makes that column meaningful by introducing a **printer driver abstraction layer**.

The first non-Prusa target is the **Elegoo Centauri Carbon**, selected because:
- It's a capable FDM machine that would slot naturally into a mixed fleet
- Its community-documented SDCP protocol is well-understood (see external links below)
- Adding it exercises the full abstraction — protocol, auth, upload, and state mapping all differ from Prusa

See [ARCHITECTURE.md Section 13](../ARCHITECTURE.md#13-phase-6--multi-brand-printer-support) for the full spec.

---

## The Core Problem

PrusaLink is a REST API (HTTP polling). The Elegoo Centauri Carbon uses **SDCP — a WebSocket-based proprietary protocol**. They are fundamentally different communication models.

| Capability | PrusaLink | Elegoo SDCP |
|---|---|---|
| Status | `GET /api/v1/status` | WebSocket request/response on port 3030 |
| Upload | `PUT /api/v1/files/usb/{name}` | `POST /uploadFile/upload` (multipart) |
| Print trigger | `Print-After-Upload: 1` header | WebSocket command after upload |
| Auth | `X-Api-Key` header | None (LAN only) |
| File format | `.bgcode` / `.gcode` | `.gcode` only |

This means the poller and scheduler can't just swap a URL — they need to call different code entirely depending on printer brand.

---

## Canonical State Model

Both brands map their native states to a shared internal set. The rest of the system (poller events, scheduler logic, UI colors) never changes:

| Canonical | PrusaLink source | SDCP source |
|---|---|---|
| `IDLE` | `IDLE` | Code 0 |
| `PRINTING` | `PRINTING` | Codes 1, 13, 16, 18, 21 (several FDM startup states — see CHANGELOG) |
| `FINISHED` | `FINISHED` | Codes 3 (stopped) and 4 (complete) |
| `PAUSED` | `PAUSED` | Code 2 |
| `ERROR` | `ERROR`, `ATTENTION` | Not currently generated; reserved for confirmed fault codes |
| `OFFLINE` | Timeout | WebSocket unreachable |
| `UNKNOWN` | — | Unrecognised SDCP code; logged for classification, does not hold printer |

---

## Connector Families

Each connector family covers all printer models that share the same protocol:

| Connector | Protocol | Printer models |
|---|---|---|
| **Prusa Link** | PrusaLink REST API (HTTP polling) | MK4, XL, and any future Prusa models |
| **Elegoo SDCP** | SDCP WebSocket V3.0.0 (port 3030) | Centauri Carbon, Centauri Carbon 2 |
| **Klipper (Moonraker)** | Moonraker REST API (HTTP polling, port 7125) | Voron and any Klipper-firmware printer |

The `printer.type` DB column stores the connector identifier (`prusa`, `elegoo-centauri`, `bambu`, or `klipper`). The model column (`centauri-carbon`, etc.) is used only for display grouping in the UI.

---

## Driver Architecture

A new `server/drivers/` directory. Each driver exports four functions with the same interface:

```
getStatus(printer)
  → { status, progress, timeRemaining, currentFile }

uploadAndPrint(printer, filePath, filename)
  → resolves when print confirmed started

cancelJob(printer)
  → resolves when cancellation confirmed

checkIfPrinting(printer)
  → boolean
```

`currentFile` is the display name of the file currently printing, or `null`. Elegoo SDCP reads this directly from `PrintInfo.Filename` (timestamp prefix stripped). Prusa Link returns `null` — the poller falls back to a jobs → gcodes DB join.

The driver registry (`server/drivers/index.js`) maps `printer.type → driver module`. The poller and scheduler call `getDriver(printer.type)` and never touch brand-specific code directly.

---

## Files to Create

| File | Purpose | Status |
|---|---|---|
| `server/drivers/index.js` | Driver registry — maps type string to module | **Done** |
| `server/drivers/prusa.js` | Extracts existing PrusaLink logic from poller.js / scheduler.js | **Done** |
| `server/drivers/elegoo-centauri.js` | New SDCP WebSocket implementation | **Done** |
| `server/drivers/klipper.js` | Moonraker REST API implementation | **Done** |

---

## Files to Modify

| File | What changes | Status |
|---|---|---|
| `server/poller.js` | Replace direct axios PrusaLink calls with `driver.getStatus(printer)` | **Done** |
| `server/scheduler.js` | Replace `_uploadGCode()` with `driver.uploadAndPrint(...)` | **Done** |
| `server/routes/printers.js` | Add `elegoo-centauri` type, `centauri-carbon` model, make `api_key` optional | **Done** |
| `client/src/pages/Fleet.jsx` | Add `centauri-carbon` to model list and labels | **Done** |
| `client/src/pages/Dashboard.jsx` | Same model list additions | **Done** |
| `client/src/pages/Settings.jsx` | Add model option; hide API key field for Elegoo brand | **Done** |

No DB schema changes are needed. The existing columns (`type`, `api_key`, `model`, `job_name`, `job_progress`, `job_time_remaining`) are all reusable.

---

## New Dependency

```bash
npm install sdcp
```

Uses the `sdcp` npm package (blakejrobinson) which wraps the SDCP WebSocket protocol, handling connection management, message framing, UUID-matched request/response correlation, and auto-reconnect. This replaced the original plan to use `ws` directly.

---

## Elegoo SDCP Notes

- Persistent WebSocket connection per printer (port 3030), managed inside the driver
- Reconnect on drop — the driver holds connections in a module-level Map keyed by printer ID
- Message format: `{ Id: "<uuid>", Data: { Cmd: <int>, RequestID: "<uuid>", MainboardID: "<str>" }, Topic: "..." }`
- No authentication — LAN access only; `api_key` stored as `''` in DB

### External References

- [OpenCentauri API docs](https://docs.opencentauri.cc/software/api/) — community-maintained spec
- [cassini](https://github.com/vvuk/cassini) — Node.js SDCP client (reference implementation)
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — Home Assistant integration with comprehensive state mapping
- [RemmyLee/carbon](https://github.com/RemmyLee/carbon) — developer documentation for SDCP

---

## G-Code Filename Parsing

The existing Prusa Slicer filename regex (`^(\d+)x ... .bgcode$`) will not match Elegoo/OrcaSlicer output. This is fine — the system already handles parse failures gracefully: it returns `parse_failed: true` and the operator enters `parts_per_plate` and model manually. No code change is needed for G-code parsing in Phase 6.

---

## What Is Not Changing

- The entire state machine in `poller.js` (hold logic, cold-start handling, event emission)
- The dispatch batching, ceiling math, retry logic, and part-cascade fallthrough in `scheduler.js`
- The DB schema
- All existing Prusa functionality

The driver layer is an extraction + addition — not a rewrite.
