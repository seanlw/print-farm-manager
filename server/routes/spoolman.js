const express = require('express');
const spoolman = require('../integrations/spoolman');

module.exports = (db) => {
  const router = express.Router();

  // Defense in depth: the client shouldn't call these when the setting is off,
  // but a stale tab or a direct curl shouldn't get a confusing 500.
  router.use((req, res, next) => {
    if (!spoolman.isEnabled(db)) {
      return res.status(400).json({ error: 'Spoolman integration is not enabled' });
    }
    next();
  });

  router.get('/status', async (_req, res) => {
    res.json(await spoolman.getStatus(db));
  });

  router.get('/vendors', async (_req, res) => {
    try {
      res.json(await spoolman.listVendors(db));
    } catch (err) {
      res.status(502).json({ error: `Could not reach Spoolman: ${err.message}` });
    }
  });

  router.get('/filaments', async (_req, res) => {
    try {
      res.json(await spoolman.listFilaments(db));
    } catch (err) {
      res.status(502).json({ error: `Could not reach Spoolman: ${err.message}` });
    }
  });

  router.get('/spools', async (req, res) => {
    try {
      res.json(await spoolman.listSpools(db, req.query));
    } catch (err) {
      res.status(502).json({ error: `Could not reach Spoolman: ${err.message}` });
    }
  });

  router.get('/spools/:id', async (req, res) => {
    try {
      res.json(await spoolman.getSpool(db, req.params.id));
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: 'Spool not found' });
      }
      res.status(502).json({ error: `Could not reach Spoolman: ${err.message}` });
    }
  });

  return router;
};
