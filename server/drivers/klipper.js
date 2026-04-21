// Klipper driver — Moonraker REST API (HTTP polling, port 7125)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Moonraker is the standard API layer for Klipper firmware (Voron, etc.).
// All communication is plain HTTP — no persistent connection, no auth required on LAN.
// Upload is two steps: POST multipart file, then POST print/start.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const PORT = 7125;

function base(printer) {
  return `http://${printer.ip}:${PORT}`;
}

// ─── Status ─────────────────────────────────────────────────────────────────

// Moonraker print_stats.state → canonical status
const STATE_MAP = {
  standby:   'IDLE',
  printing:  'PRINTING',
  paused:    'PAUSED',
  complete:  'FINISHED',
  error:     'ERROR',
  cancelled: 'STOPPED',
};

async function getStatus(printer) {
  try {
    const res = await axios.get(
      `${base(printer)}/printer/objects/query`,
      {
        params: { print_stats: null, virtual_sdcard: null, webhooks: null },
        timeout: 8000,
      }
    );

    const stats  = res.data?.result?.status?.print_stats  || {};
    const vsd    = res.data?.result?.status?.virtual_sdcard || {};
    const hooks  = res.data?.result?.status?.webhooks || {};

    // If Klipper itself is not ready (startup, shutdown, error), report offline.
    if (hooks.state && hooks.state !== 'ready') {
      return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
    }

    const status = STATE_MAP[stats.state] || 'UNKNOWN';

    let progress    = null;
    let timeRemaining = null;
    let currentFile = null;

    if (status === 'PRINTING' || status === 'PAUSED') {
      const pct = vsd.progress ?? null;
      if (pct != null) progress = Math.round(pct * 100);

      // Estimate time remaining from elapsed print time and file progress.
      // Only meaningful once a few percent in — avoid div-by-zero and wildly
      // inaccurate early estimates.
      const elapsed = stats.print_duration ?? 0;
      if (pct != null && pct > 0.02 && elapsed > 0) {
        timeRemaining = Math.round(elapsed * (1 - pct) / pct);
      }

      if (stats.filename) {
        currentFile = stats.filename;
      }
    }

    return { status, progress, timeRemaining, currentFile };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to Moonraker's gcodes directory, then triggers a print.
// Moonraker deduplicates by filename — uploading a file that already exists
// overwrites it silently, so no pre-delete step is needed.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const form = new FormData();
  form.append('file', fs.createReadStream(gcodeFullPath), { filename });

  await axios.post(
    `${base(printer)}/server/files/gcodes/`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 300000, // 5 minutes for large files
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  // Small delay — Moonraker needs a moment to register the file before print/start.
  await new Promise(r => setTimeout(r, 1000));

  await axios.post(
    `${base(printer)}/printer/print/start`,
    null,
    {
      params: { filename },
      timeout: 15000,
    }
  );
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    await axios.post(`${base(printer)}/printer/print/cancel`, null, { timeout: 10000 });
  } catch (err) {
    console.warn(`[klipper] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
