const express = require('express');
const router = express.Router();
const spoolman = require('../integrations/spoolman');
const events = require('../events');

const ALLOWED_KEYS = new Set(['dispatch_batch_size', 'farm_name', 'spoolman_enabled', 'spoolman_base_url']);

module.exports = (db) => {
  // GET /api/settings — returns all settings as { key: value, ... }
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    res.json(result);
  });

  // PUT /api/settings/:key — update a single setting value
  router.put('/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }
    const { value } = req.body;
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ error: 'value is required' });
    }

    if (key === 'dispatch_batch_size') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'dispatch_batch_size must be an integer between 1 and 100' });
      }
    }

    if (key === 'farm_name' && String(value).trim().length > 40) {
      return res.status(400).json({ error: 'farm_name must be 40 characters or fewer' });
    }

    if (key === 'spoolman_enabled' && !['true', 'false'].includes(String(value))) {
      return res.status(400).json({ error: 'spoolman_enabled must be "true" or "false"' });
    }

    if (key === 'spoolman_base_url') {
      const v = String(value).trim();
      if (!/^https?:\/\/.+/i.test(v)) {
        return res.status(400).json({ error: 'spoolman_base_url must start with http:// or https://' });
      }
      if (v.length > 200) {
        return res.status(400).json({ error: 'spoolman_base_url must be 200 characters or fewer' });
      }
    }

    // Enabling Spoolman: any printer not bound to a spool may still be carrying
    // loaded_material/loaded_color picked from the old manual library before the
    // integration was turned on. That data no longer traces back to anything real
    // once Spoolman is the source of truth, so it's cleared here rather than left
    // to look like it came from a bound spool. Bound printers are untouched: their
    // values already came from a real spool via spoolman-bind. Only fires on the
    // false→true transition, not on every re-save of an already-enabled setting.
    if (key === 'spoolman_enabled' && String(value) === 'true') {
      const wasEnabled = db.prepare("SELECT value FROM settings WHERE key = 'spoolman_enabled'").get()?.value === 'true';
      if (!wasEnabled) {
        const stale = db.prepare(
          "SELECT id FROM printers WHERE spoolman_spool_id IS NULL AND (loaded_material IS NOT NULL OR loaded_color IS NOT NULL)"
        ).all();
        if (stale.length) {
          db.transaction(() => {
            db.prepare(
              'UPDATE printers SET loaded_material = NULL, loaded_color = NULL WHERE spoolman_spool_id IS NULL'
            ).run();
            for (const p of stale) {
              events.insert(p.id, 'info_changed', 'Loaded material/color cleared: Spoolman integration enabled, bind a spool to set them again');
            }
          })();
          console.log(`[settings] Spoolman enabled: cleared loaded_material/loaded_color on ${stale.length} unbound printer(s)`);
        }
      }
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    if (key === 'spoolman_base_url') spoolman.invalidateCache();
    res.json({ key, value: String(value) });
  });

  return router;
};
