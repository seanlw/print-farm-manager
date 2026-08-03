// Spoolman integration client: talks to a self-hosted Spoolman instance's REST API
// (github.com/Donkie/Spoolman, mounted at {base_url}/api/v1). Optional and off by
// default: every exported function no-ops or throws SPOOLMAN_DISABLED when the
// spoolman_enabled setting isn't 'true' or no base URL is configured, so a farm that
// doesn't use Spoolman sees zero extra SQL beyond one settings lookup and zero
// network calls, ever.
//
// Endpoint shapes verified against spoolman/api/v1/{spool,filament,vendor}.py on
// the Spoolman GitHub repo (master branch), not guessed.

const axios = require('axios');
const notifications = require('../notifications');

const CACHE_TTL_MS = 60_000; // library data changes rarely; avoids hammering Spoolman on every page load
const REQUEST_TIMEOUT_MS = 8000;

const _cache = new Map(); // cacheKey -> { data, fetchedAt }

function getConfig(db) {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('spoolman_enabled', 'spoolman_base_url')"
  ).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled: map.spoolman_enabled === 'true',
    baseUrl: (map.spoolman_base_url || '').trim().replace(/\/+$/, ''),
  };
}

function isEnabled(db) {
  const cfg = getConfig(db);
  return cfg.enabled && !!cfg.baseUrl;
}

function disabledError() {
  return Object.assign(new Error('Spoolman integration is not enabled'), { code: 'SPOOLMAN_DISABLED' });
}

function invalidateCache() {
  _cache.clear();
}

async function _get(db, path, { cacheKey, ttl = CACHE_TTL_MS } = {}) {
  const cfg = getConfig(db);
  if (!cfg.enabled || !cfg.baseUrl) throw disabledError();

  if (cacheKey) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < ttl) return hit.data;
  }

  const response = await axios.get(`${cfg.baseUrl}${path}`, { timeout: REQUEST_TIMEOUT_MS });
  if (cacheKey) _cache.set(cacheKey, { data: response.data, fetchedAt: Date.now() });
  return response.data;
}

async function getStatus(db) {
  const cfg = getConfig(db);
  if (!cfg.enabled || !cfg.baseUrl) {
    return { enabled: cfg.enabled, base_url: cfg.baseUrl || null, reachable: false };
  }
  try {
    await axios.get(`${cfg.baseUrl}/api/v1/info`, { timeout: REQUEST_TIMEOUT_MS });
    return { enabled: true, base_url: cfg.baseUrl, reachable: true };
  } catch (err) {
    return { enabled: true, base_url: cfg.baseUrl, reachable: false, error: err.message };
  }
}

async function listVendors(db) {
  return _get(db, '/api/v1/vendor', { cacheKey: 'vendors' });
}

async function listFilaments(db) {
  return _get(db, '/api/v1/filament', { cacheKey: 'filaments' });
}

async function listSpools(db, query = {}) {
  const params = new URLSearchParams(query).toString();
  const path = params ? `/api/v1/spool?${params}` : '/api/v1/spool';
  return _get(db, path, { cacheKey: `spools:${params}` });
}

async function getSpool(db, spoolId) {
  return _get(db, `/api/v1/spool/${encodeURIComponent(spoolId)}`, { cacheKey: null });
}

// Reports the grams a finished job actually consumed to Spoolman, once, per job.
// Never throws: every failure mode is a typed { ok: false, reason } return so
// callers (scheduler and operator-action routes) can treat this purely as a
// best-effort side effect alongside the real event, crediting parts.completed_qty,
// which always happens first and is never affected by this function's outcome.
async function reportJobUsage(db, jobId) {
  if (!isEnabled(db)) return { ok: false, reason: 'disabled' };

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return { ok: false, reason: 'not-found' };
  if (job.spoolman_reported_at) return { ok: false, reason: 'already-reported' };

  const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(job.printer_id);
  if (!printer || !printer.spoolman_report_usage) return { ok: false, reason: 'opted-out' };

  // Snapshot taken at dispatch time wins; falls back to whatever is currently bound
  // in case an older job row predates the snapshot column being populated.
  const spoolId = job.spoolman_spool_id ?? printer.spoolman_spool_id;
  if (!spoolId) return { ok: false, reason: 'not-bound' };

  const gcode = job.gcode_id
    ? db.prepare('SELECT filament_used_grams, parts_per_plate FROM gcodes WHERE id = ?').get(job.gcode_id)
    : null;
  // filament_used_grams is only ever written by parseFilamentUsage (server/gcode-decode.js)
  // reading the sliced file's own metadata, never operator-typed like material_grams is,
  // which is what makes this the field that satisfies "not a guessed number".
  if (!gcode || gcode.filament_used_grams == null || !gcode.parts_per_plate) {
    notifications.add(
      `Spoolman usage not reported for job ${jobId}: its G-code has no parsed filament usage yet (open it in the 3D viewer, or use "Parse G-code", then it will be picked up on the next finish).`
    );
    return { ok: false, reason: 'no-parsed-usage' };
  }

  // job.parts_per_plate is frozen at dispatch time; gcode.parts_per_plate is the
  // current live value. Same proration shape as the dashboard's per-job material
  // stat (server/routes/dashboard.js), just reading filament_used_grams instead
  // of the operator-editable material_grams.
  const grams = Math.round(job.parts_per_plate * (gcode.filament_used_grams / gcode.parts_per_plate) * 100) / 100;

  const cfg = getConfig(db);
  try {
    await axios.put(
      `${cfg.baseUrl}/api/v1/spool/${encodeURIComponent(spoolId)}/use`,
      { use_weight: grams },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (err) {
    return { ok: false, reason: 'http-error', error: err.message };
  }

  db.prepare('UPDATE jobs SET spoolman_reported_at = ? WHERE id = ?').run(Date.now(), jobId);
  return { ok: true, grams };
}

module.exports = {
  getConfig,
  isEnabled,
  invalidateCache,
  getStatus,
  listVendors,
  listFilaments,
  listSpools,
  getSpool,
  reportJobUsage,
};
