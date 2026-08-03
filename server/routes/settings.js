const express = require('express');
const router = express.Router();
const spoolman = require('../integrations/spoolman');

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

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    if (key === 'spoolman_base_url') spoolman.invalidateCache();
    res.json({ key, value: String(value) });
  });

  return router;
};
