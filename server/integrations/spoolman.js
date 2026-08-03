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

module.exports = {
  getConfig,
  isEnabled,
  invalidateCache,
  getStatus,
  listVendors,
  listFilaments,
  listSpools,
  getSpool,
};
