const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const axios = require('axios');
const router = express.Router();
const events = require('../events');

const upload = multer({ storage: multer.memoryStorage() });

const NO_API_KEY_TYPES = new Set(['elegoo-centauri', 'klipper']); // types that store no api_key

// Normalize a raw model string to a canonical ID (lowercase, trimmed).
// Validation against the registered model list is done via DB query at each call site.
function normalizeModel(raw) {
  if (!raw) return null;
  return raw.trim().toLowerCase() || null;
}

// Fallback: infer model from printer name when no model column is present.
function inferModel(name) {
  if (/^MK4S_/i.test(name)) return 'mk4s';
  if (/^MK4_/i.test(name))  return 'mk4';
  if (/^(CoreOne_|Core1L_|C1L )/i.test(name)) return 'c1l';
  if (/^(CoreOne_|Core1_|C1 )/i.test(name))   return 'c1';
  if (/^XL_/i.test(name))   return 'xl';
  return null;
}

// Resolve model: explicit CSV column wins; name inference is the fallback.
function resolveModel(rawModel, name) {
  return normalizeModel(rawModel) || inferModel(name);
}

module.exports = (db) => {
  // GET /api/printers — list active printers only
  // Includes last_parts_per_plate from the most recent finished job, used by the
  // Fleet UI to pre-fill the confirmed-qty input on held printers.
  // Includes has_active_job — true when an uploading/printing job exists, used to
  // distinguish a held OFFLINE printer whose job is still running from one with no job.
  router.get('/', (req, res) => {
    const printers = db.prepare(`
      SELECT p.*,
        COALESCE(
          (SELECT j.parts_per_plate FROM jobs j WHERE j.printer_id = p.id AND j.status = 'finished' ORDER BY j.finished_at DESC LIMIT 1),
          (SELECT j.parts_per_plate FROM jobs j WHERE j.printer_id = p.id AND j.status = 'printing' ORDER BY j.started_at DESC LIMIT 1)
        ) AS last_parts_per_plate,
        EXISTS(
          SELECT 1 FROM jobs j WHERE j.printer_id = p.id AND j.status IN ('uploading', 'printing')
        ) AS has_active_job,
        EXISTS(
          SELECT 1 FROM jobs j WHERE j.printer_id = p.id AND j.status = 'uploading'
        ) AS has_uploading_job
      FROM printers p
      WHERE p.is_active = 1
      ORDER BY p.name
    `).all();
    res.json(printers);
  });

  // GET /api/printers/decommissioned — list decommissioned printers
  router.get('/decommissioned', (req, res) => {
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 0 ORDER BY decommissioned_at DESC').all();
    res.json(printers);
  });

  // GET /api/printers/ams?model=x1c — returns AMS slot list from any connected
  // Bambu printer of the given model. Returns [] if none is connected or model
  // is not a Bambu type. Used by the upload form to populate the slot picker.
  router.get('/ams', (req, res) => {
    const { model } = req.query;
    if (!model) return res.json([]);

    const printer = db.prepare(
      "SELECT * FROM printers WHERE model = ? AND type = 'bambu' AND is_active = 1 LIMIT 1"
    ).get(model);
    if (!printer) return res.json([]);

    const { getAmsSlots } = require('../drivers/bambu');
    const slots = getAmsSlots(printer);
    res.json(slots || []);
  });

  // GET /api/printers/:id
  router.get('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(printer);
  });

  // POST /api/printers — add single printer
  router.post('/', (req, res) => {
    const { name, ip, api_key, serial_number, group_name, type, model } = req.body;
    const printerType = type || 'prusa';
    const requiresApiKey = !NO_API_KEY_TYPES.has(printerType);
    if (!name || !ip || !model || (requiresApiKey && !api_key)) {
      const keyMsg = requiresApiKey ? ', api_key' : '';
      return res.status(400).json({ error: `name, ip${keyMsg}, and model are required` });
    }
    const normalized = normalizeModel(model);
    if (!normalized || !db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(normalized)) {
      return res.status(400).json({ error: `Unknown model "${model}". Add it in Settings → Printer Models first.` });
    }
    try {
      const result = db.prepare(`
        INSERT INTO printers (name, ip, api_key, serial_number, group_name, type, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, ip, api_key || '', serial_number || '', group_name || null, printerType, normalized, Date.now());
      res.status(201).json(db.prepare('SELECT * FROM printers WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Printer name "${name}" already exists` });
      }
      throw err;
    }
  });

  // PUT /api/printers/:id — update printer
  router.put('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const { name, ip, api_key, serial_number, group_name, type, model, is_held, decommission_note } = req.body;
    let normalized = undefined;
    if (model !== undefined) {
      normalized = normalizeModel(model);
      if (!normalized || !db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(normalized)) {
        return res.status(400).json({ error: `Unknown model "${model}". Add it in Settings → Printer Models first.` });
      }
    }

    try {
      db.prepare(`
        UPDATE printers
        SET name = COALESCE(?, name),
            ip = COALESCE(?, ip),
            api_key = COALESCE(?, api_key),
            serial_number = COALESCE(?, serial_number),
            group_name = COALESCE(?, group_name),
            type = COALESCE(?, type),
            model = COALESCE(?, model),
            is_held = COALESCE(?, is_held),
            decommission_note = COALESCE(?, decommission_note)
        WHERE id = ?
      `).run(name, ip, api_key, serial_number, group_name, type, normalized, is_held, decommission_note ?? null, req.params.id);

      res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Printer name "${name}" already exists` });
      }
      throw err;
    }
  });

  // DELETE /api/printers/:id
  router.delete('/:id', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    db.prepare('DELETE FROM printers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // POST /api/printers/:id/decommission — remove from active duty
  router.post('/:id/decommission', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    const now = Date.now();
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(now, printer.id);
    events.insert(printer.id, 'decommission', req.body?.note ?? null);
    console.log(`[printers] ${printer.name} decommissioned`);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id));
  });

  // POST /api/printers/:id/recommission — handled in server/index.js (needs scheduler access)

  // POST /api/printers/:id/mark-job-failure — mark last finished job as failed, undo completed_qty
  router.post('/:id/mark-job-failure', (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    // Active jobs (printing/uploading) take priority over finished ones.
    //
    //   printing  — active or stale; completed_qty was never credited
    //   uploading — upload stalled; completed_qty was never credited
    //   finished  — fallback: _handleFinished already credited completed_qty; operator
    //               is confirming the print was bad
    //
    // The finished fallback is intentionally narrow: only match a finished job if no
    // subsequent job was created for this printer after it finished. This ensures we
    // find the job the printer is currently held for (awaiting operator sign-off), not
    // an older finished job from a previous cycle that would cause a wrong qty decrement.
    let job = db.prepare(`
      SELECT * FROM jobs WHERE printer_id = ? AND status IN ('printing', 'uploading')
      ORDER BY started_at DESC LIMIT 1
    `).get(printer.id);
    if (!job) {
      job = db.prepare(`
        SELECT * FROM jobs j
        WHERE j.printer_id = ? AND j.status = 'finished'
          AND NOT EXISTS (
            SELECT 1 FROM jobs j2
            WHERE j2.printer_id = j.printer_id
              AND j2.id != j.id
              AND j2.created_at > j.finished_at
          )
        ORDER BY j.finished_at DESC LIMIT 1
      `).get(printer.id);
    }

    if (!job) {
      // No tracked job (e.g. print was started outside the farm manager, or the
      // printer spent all night in an UNKNOWN status so _handleFinished never fired).
      // Operator intent is clear: take the machine offline regardless.
      const now = Date.now();
      db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(now, printer.id);
      events.insert(printer.id, 'job_failed', 'No tracked job — printer decommissioned for investigation');
      console.log(`[printers] ${printer.name} decommissioned (no tracked job to mark failed)`);
      return res.json({ success: true, job_id: null });
    }

    const now = Date.now();

    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);

    if (job.status === 'finished') {
      // Normal case: job was already credited when FINISHED was seen. Undo the increment.
      db.prepare(`
        UPDATE parts SET completed_qty = MAX(0, completed_qty - ?), updated_at = ? WHERE id = ?
      `).run(job.parts_per_plate, now, job.part_id);

      // Reload part — reopen if it was closed by this job
      const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(job.part_id);
      if (part.status === 'closed' && part.completed_qty < part.target_qty) {
        db.prepare("UPDATE parts SET status = 'open', updated_at = ? WHERE id = ?").run(now, part.id);

        // If project was marked completed, reopen it to active
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(part.project_id);
        if (project && project.status === 'completed') {
          db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
          console.log(`[printers] Project ${project.id} reopened — bad print undid completion`);
        }
      }
    }
    // printing (missed-finish) and uploading (upload stalled) cases: completed_qty was never
    // incremented, so there is nothing to undo. Just mark failed and decommission below.

    // Decommission the printer — a failed print requires investigation before it can run again.
    // The operator must explicitly recommission it when the machine is confirmed safe.
    db.prepare('UPDATE printers SET is_active = 0, decommissioned_at = ? WHERE id = ?').run(now, printer.id);

    const failedPart = db.prepare('SELECT name FROM parts WHERE id = ?').get(job.part_id);
    events.insert(printer.id, 'job_failed', `Job ${job.id} — part: ${failedPart?.name ?? 'unknown'}`);

    console.log(`[printers] Job ${job.id} marked failed — ${printer.name} decommissioned pending investigation`);
    res.json({ success: true, job_id: job.id });
  });

  // GET /api/printers/:id/raw-status — calls the printer's driver, returns raw response for debugging
  router.get('/:id/raw-status', async (req, res) => {
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    try {
      const response = await axios.get(`http://${printer.ip}/api/v1/status`, {
        headers: { 'X-Api-Key': printer.api_key },
        timeout: 8000,
      });
      res.json({ printer: { id: printer.id, name: printer.name, ip: printer.ip }, raw: response.data });
    } catch (err) {
      res.json({ printer: { id: printer.id, name: printer.name, ip: printer.ip }, error: err.message });
    }
  });

  // POST /api/printers/import — CSV bulk import
  router.post('/import', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const csvText = req.file.buffer.toString('utf-8');
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    if (parsed.errors.length > 0) {
      return res.status(400).json({ error: 'CSV parse error', details: parsed.errors });
    }

    const rows = parsed.data;
    const summary = { imported: 0, skipped: 0, flagged: [] };

    const insertStmt = db.prepare(`
      INSERT INTO printers (name, ip, api_key, serial_number, group_name, type, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const existsStmt = db.prepare('SELECT id FROM printers WHERE name = ?');

    for (const row of rows) {
      const name          = (row.name          || '').trim();
      const ip            = (row.ip            || '').trim();
      const api_key       = (row.api_key       || '').trim();
      const serial_number = (row.serial_number || '').trim();
      const group_name    = (row.group         || '').trim() || null;
      const type          = (row.type          || 'prusa').trim();

      const rowRequiresApiKey = !NO_API_KEY_TYPES.has(type);
      if (!name || !ip || (rowRequiresApiKey && !api_key)) {
        summary.flagged.push({ row, reason: 'Missing required field (name, ip, or api_key)' });
        continue;
      }

      if (existsStmt.get(name)) {
        summary.skipped++;
        continue;
      }

      const model = resolveModel(row.model, name);
      if (!model) {
        summary.flagged.push({
          row,
          reason: `Could not determine model for "${name}". Add a "model" column or use a recognized name prefix.`,
        });
        continue;
      }
      if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(model)) {
        summary.flagged.push({
          row,
          reason: `Model "${model}" is not registered. Add it in Settings → Printer Models first.`,
        });
        continue;
      }

      try {
        insertStmt.run(name, ip, api_key, serial_number, group_name, type, model, Date.now());
        summary.imported++;
      } catch (err) {
        summary.flagged.push({ row, reason: err.message });
      }
    }

    res.json(summary);
  });

  // Mount events sub-router — GET/POST /api/printers/:id/events
  router.use('/:id/events', require('./events')(db));

  return router;
};
