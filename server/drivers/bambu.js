// Bambu Lab printer driver — MQTT over TLS + FTPS
// Connector family: Bambu MQTT
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Prerequisites on the printer (both required):
//   Settings → Network → LAN Only Mode: ON
//   Settings → Network → Developer Mode: ON  ← appears after LAN Mode is on
//   Developer Mode eliminates the X.509 certificate signing requirement for commands.
//
// Credentials stored in DB:
//   printer.ip            — local IP address
//   printer.api_key       — access code (shown on printer screen under WiFi settings)
//   printer.serial_number — device serial number (used as MQTT topic path)
//
// Connection model (differs from Prusa/Elegoo):
//   Bambu pushes status to device/{serial}/report continuously — there is no
//   request/response polling. We subscribe once and cache the latest payload.
//   getStatus() returns from cache instantly. OFFLINE is returned until the
//   first status message arrives after connect.
//
// Bambu sends partial status updates, not full state each time.
// We merge each incoming update into conn.latestPrint so no fields are lost.
//
// Protocol reference: https://github.com/Doridian/OpenBambuAPI

const mqtt     = require('mqtt');
const ftp      = require('basic-ftp');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const JSZip    = require('jszip');

// Map of printer.id → { client, latestPrint, connected }
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns (or creates) the connection object for a printer.
// The MQTT connection is established in the background — callers should
// check conn.connected before sending commands.
function getOrCreateConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const serial = printer.serial_number;
  const conn   = { client: null, latestPrint: null, connected: false };
  connections.set(printer.id, conn);

  const client = mqtt.connect(`mqtts://${printer.ip}:8883`, {
    username:          'bblp',
    password:          printer.api_key, // access code from printer WiFi settings
    rejectUnauthorized: false,          // Bambu uses a self-signed TLS certificate — intentional
    reconnectPeriod:   5000,
    connectTimeout:    10000,
  });

  conn.client = client;

  client.on('connect', () => {
    conn.connected = true;

    // Subscribe to the printer's status push topic
    client.subscribe(`device/${serial}/report`, (err) => {
      if (err) console.warn(`[bambu] ${printer.name} subscribe error:`, err.message);
    });

    // Request an immediate full status dump so the cache is populated right away
    // rather than waiting for the next natural push interval.
    client.publish(`device/${serial}/request`, JSON.stringify({
      pushing: { sequence_id: '0', command: 'pushall', push_target: 1 },
    }));

    console.log(`[bambu] Connected to ${printer.name} (${printer.ip})`);
  });

  client.on('message', (_topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      // All status fields arrive under data.print.
      // Merge — Bambu sends partial updates, not a full snapshot each time.
      if (data.print) {
        conn.latestPrint = { ...conn.latestPrint, ...data.print };
      }
    } catch (_) {}
  });

  client.on('reconnect', () => {
    conn.connected = false;
    console.log(`[bambu] ${printer.name} reconnecting…`);
  });

  client.on('offline', () => {
    conn.connected = false;
  });

  client.on('error', (err) => {
    conn.connected = false;
    if (process.env.DEBUG_BAMBU) {
      console.warn(`[bambu] ${printer.name} error:`, err?.message || err);
    }
  });

  return conn;
}

function dropConnection(printerId) {
  const conn = connections.get(printerId);
  if (conn) {
    try { conn.client?.end(true); } catch (_) {}
    connections.delete(printerId);
  }
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps Bambu gcode_state strings to canonical status strings.
// Source: OpenBambuAPI — https://github.com/Doridian/OpenBambuAPI
//
// RUNNING  = Active print in progress
// PREPARE  = Bed leveling, heating, homing before first layer — treat as PRINTING
// IDLE     = Standby, no print loaded
// PAUSE    = Print paused by operator or firmware event
// FINISH   = Print complete — triggers operator confirmation in farm UI
// FAILED   = Firmware-detected print failure
function mapStatus(gcodeState) {
  switch (gcodeState) {
    case 'RUNNING':  return 'PRINTING';
    case 'PREPARE':  return 'PRINTING'; // calibration/homing before layers begin
    case 'IDLE':     return 'IDLE';
    case 'PAUSE':    return 'PAUSED';
    case 'FINISH':   return 'FINISHED';
    case 'FAILED':   return 'ERROR';
    default:         return 'UNKNOWN';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | UNKNOWN
// progress (0–100), timeRemaining (seconds), and currentFile are null when not printing.
async function getStatus(printer) {
  if (!printer.serial_number) {
    // Misconfigured — serial number required for MQTT topics
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const conn = getOrCreateConnection(printer);

  if (!conn.connected || !conn.latestPrint) {
    // Not yet connected or no status received — report OFFLINE, connection is
    // retrying in the background via reconnectPeriod.
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const print  = conn.latestPrint;
  const status = mapStatus(print.gcode_state);

  const progress = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_percent ?? null)
    : null;

  // Bambu reports mc_remaining_time in minutes — convert to seconds for UI consistency.
  const timeRemaining = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_remaining_time != null ? print.mc_remaining_time * 60 : null)
    : null;

  // subtask_name is the file or project currently printing.
  // Strip the multer-prepended timestamp prefix (e.g. "1712345678901_benchy.gcode").
  const rawFilename = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.subtask_name ?? null)
    : null;
  const currentFile = rawFilename ? rawFilename.replace(/^\d+_/, '') : null;

  return { status, progress, timeRemaining, currentFile };
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Returns the current AMS slot list from the cached MQTT state, or null if not connected.
// Each slot: { slot, type, color }
//   slot  — compound id: (ams_unit * 4) + tray_id, or -1 for external spool
//   type  — filament type string e.g. 'PLA', or '' if unknown
//   color — RRGGBBAA hex string, or null
// Empty trays (no tray_type field) are omitted. External spool is always included.
function getAmsSlots(printer) {
  const conn = connections.get(printer.id);
  if (!conn?.latestPrint) return null;

  const slots = [];

  const amsUnits = conn.latestPrint.ams?.ams || [];
  for (const unit of amsUnits) {
    const amsId = parseInt(unit.id, 10);
    for (const tray of unit.tray || []) {
      if (!tray.tray_type) continue; // empty slot — no filament loaded
      slots.push({
        slot:  amsId * 4 + parseInt(tray.id, 10),
        type:  tray.tray_type,
        color: tray.tray_color || null,
      });
    }
  }

  // External spool is always an option regardless of whether filament is loaded
  const vt = conn.latestPrint.vt_tray;
  slots.push({
    slot:  -1,
    type:  vt?.tray_type || '',
    color: vt?.tray_color || null,
  });

  return slots;
}

// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot: -1 = external spool, 0–N = AMS slot, null = default (external)
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null } = options;
  if (!printer.serial_number) {
    throw new Error(`Bambu printer ${printer.name} has no serial number configured`);
  }

  const onPrinterFilename = path.basename(gcodeFullPath);

  const ext = path.extname(onPrinterFilename).toLowerCase();
  const is3mf = ext === '.3mf';

  // For plain .gcode/.bgcode files: Bambu's gcode_file MQTT command is non-functional
  // on A-series printers (A1, A2, A2L). project_file works, but requires a .3mf
  // container. Wrap the gcode in a minimal .3mf (ZIP with gcode at
  // Metadata/plate_1.gcode) so we can use project_file for all file types.
  let uploadPath   = gcodeFullPath;   // path on disk to upload
  let onPrinterName = onPrinterFilename; // filename as it will appear on the SD card
  let tempPath     = null;             // set if we created a temp file to clean up

  if (!is3mf) {
    const zip = new JSZip();
    zip.file('Metadata/plate_1.gcode', fs.readFileSync(gcodeFullPath));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    const baseName = path.basename(onPrinterFilename, ext);
    onPrinterName = `${baseName}.3mf`;
    tempPath      = path.join(os.tmpdir(), onPrinterName);
    fs.writeFileSync(tempPath, zipBuffer);
    uploadPath = tempPath;
    console.log(`[bambu] Wrapped ${onPrinterFilename} → ${onPrinterName} (minimal .3mf)`);
  }

  // ── FTPS upload ──────────────────────────────────────────────────────────
  // All files (native .3mf and gcode-wrapped .3mf) go to the SD card root.
  console.log(`[bambu] Uploading ${onPrinterName} to ${printer.name} via FTPS…`);

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.uploadFrom(uploadPath, onPrinterName);
    console.log(`[bambu] Upload complete on ${printer.name}`);
  } finally {
    ftpClient.close();
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  // ── MQTT print trigger ───────────────────────────────────────────────────
  const conn = getOrCreateConnection(printer);

  if (!conn.connected) {
    throw new Error(`Bambu printer ${printer.name} MQTT not connected — cannot trigger print`);
  }

  // All files use project_file — native .3mf and gcode-wrapped .3mf alike.
  // ams_mapping format for LAN printing: a flat array where index = filament slot
  // in the .3mf (0-based) and value = physical AMS tray ID (0-15).
  // For single-color prints: [amsSlot] (one element).
  // For external spool or no AMS: [] (empty).
  // Ref: https://github.com/Doridian/OpenBambuAPI (issue #38 + mqtt.md)
  const subtaskName = path.basename(onPrinterName, '.3mf');
  const useAms      = amsSlot != null && amsSlot >= 0;
  const printPayload = {
    sequence_id:     '0',
    command:         'project_file',
    param:           'Metadata/plate_1.gcode',
    subtask_name:    subtaskName,
    url:             `ftp:///${onPrinterName}`,
    bed_type:        'auto',
    timelapse:       false,
    bed_leveling:    true,
    flow_cali:       false,
    vibration_cali:  true,
    layer_inspect:   false,
    use_ams:         useAms,
    ams_mapping:     useAms ? [amsSlot] : [],
    profile_id:      '0',
    project_id:      '0',
    subtask_id:      '0',
    task_id:         '0',
  };

  const mqttPayload = JSON.stringify({ print: printPayload });
  console.log(`[bambu] MQTT payload → ${printer.name}: ${mqttPayload}`);
  conn.client.publish(`device/${printer.serial_number}/request`, mqttPayload, (err) => {
    if (err) console.error(`[bambu] MQTT publish failed for ${printer.name}:`, err.message);
    else console.log(`[bambu] MQTT publish confirmed for ${printer.name}`);
  });
}

// ─── File cleanup ─────────────────────────────────────────────────────────────

// Deletes a file from the printer's SD card via FTPS.
// Called by the scheduler after a job finishes to prevent accumulation of files.
async function deleteFile(printer, filename) {
  if (!filename) return;

  // .gcode/.bgcode files were wrapped in a .3mf and uploaded to SD root.
  // Delete the .3mf wrapper, not the original gcode path.
  const ext = path.extname(filename).toLowerCase();
  const remotePath = (ext === '.gcode' || ext === '.bgcode')
    ? `${path.basename(filename, ext)}.3mf`
    : filename;

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.remove(remotePath);
    console.log(`[bambu] Deleted ${remotePath} from ${printer.name}`);
  } catch (err) {
    // Non-fatal — file may have already been deleted or never uploaded
    console.warn(`[bambu] Could not delete ${filename} from ${printer.name}: ${err.message}`);
  } finally {
    ftpClient.close();
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  if (!printer.serial_number) return;

  const conn = connections.get(printer.id);
  if (!conn?.connected) {
    console.warn(`[bambu] ${printer.name} not connected — cannot cancel`);
    return;
  }

  conn.client.publish(`device/${printer.serial_number}/request`, JSON.stringify({
    print: { sequence_id: '0', command: 'stop' },
  }));

  console.log(`[bambu] Job cancelled on ${printer.name}`);
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
async function checkIfPrinting(printer) {
  const { status } = await getStatus(printer);
  return status === 'PRINTING' || status === 'PAUSED';
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getAmsSlots, deleteFile };
