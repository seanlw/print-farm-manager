const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { decodeBgcode, decode3mf, GcodeDecodeError } = require('../gcode-decode');
const router = express.Router();

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const storage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
// A generous cap, well above any real sliced G-code this app's supported printer models would
// produce — bounds per-upload disk usage rather than any expectation of hitting this in
// practice. Compressed-format decompression bombs are capped separately, at decode time
// (server/gcode-decode.js), since a small upload can still expand to far more than this at
// decode time.
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Model token in filename → internal ID
const MODEL_TOKEN_MAP = {
  mk4s: 'mk4s',
  mk4:  'mk4',
  c1l:  'c1l',
  c1:   'c1',
  core1l: 'c1l',
  coreone: 'c1',
  core1:   'c1',
  xl:   'xl',
};

function parseFilename(filename) {
  // Allow an optional trailing token (e.g. _37grams, _45g) after the time field before the extension.
  const regex = /^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Za-z]+)_([A-Za-z0-9]+)_(\d+h\d+m)(?:_[^.]+)?\.(bgcode|gcode)$/i;
  const match = filename.match(regex);
  if (!match) return null;

  const parts_per_plate = parseInt(match[1], 10);
  const model_token = match[6].toLowerCase();
  const printer_model = MODEL_TOKEN_MAP[model_token] || null;

  // Parse "5h11m" → seconds
  const timeMatch = match[7].match(/(\d+)h(\d+)m/);
  const est_print_secs = timeMatch
    ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60
    : null;

  return { parts_per_plate, printer_model, est_print_secs, part_name_hint: match[2] };
}

// Extract material grams from any filename — flexible pattern matching.
// kg before g to avoid "1.2kg" matching "2" with /g/.
function extractMaterialGramsFromFilename(filename) {
  const kg = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*kg(?:[_\s\-\.\(]|$)/i);
  if (kg) return parseFloat(kg[1]) * 1000;
  const g = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*(?:grams?|g)(?:[_\s\-\.\(]|$)/i);
  if (g) return parseFloat(g[1]);
  return null;
}

// Accepts: bare integer (seconds), HH:MM:SS, H:MM, or component form (2h15m, 1h 30m, etc.)
function normalizePrintTime(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60;
  let total = 0, found = false;
  m = s.match(/(\d+)\s*h/i); if (m) { total += +m[1] * 3600; found = true; }
  m = s.match(/(\d+)\s*m/i); if (m) { total += +m[1] * 60;   found = true; }
  m = s.match(/(\d+)\s*s/i); if (m) { total += +m[1];        found = true; }
  return found ? total : null;
}

// Accepts: bare number (grams), "45g", "45.5 grams", "1.2kg", "1.2 kilograms"
function normalizeMaterialGrams(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  let m = s.match(/^(\d+(?:\.\d+)?)\s*kg(?:ilograms?)?$/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/^(\d+(?:\.\d+)?)\s*g(?:rams?)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

module.exports = (db) => {
  // GET /api/gcodes — list, optionally filtered by part_id
  // The part_id-filtered branch is ordered oldest-first (by created_at, with id as a tiebreak
  // for same-millisecond inserts) so "the first gcode for this part" is a stable, meaningful
  // concept for callers — e.g. the 3D Viewer previews gcodes[0] as the part's representative
  // file — rather than relying on SQLite's unspecified row order for a query with no ORDER BY.
  router.get('/', (req, res) => {
    const { part_id } = req.query;
    const gcodes = part_id
      ? db.prepare('SELECT * FROM gcodes WHERE part_id = ? ORDER BY created_at ASC, id ASC').all(part_id)
      : db.prepare('SELECT * FROM gcodes ORDER BY created_at DESC').all();
    res.json(gcodes);
  });

  // POST /api/gcodes/parse-filename — parse filename, return fields, don't save anything
  router.post('/parse-filename', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const parsed = parseFilename(filename);
    const material_grams = extractMaterialGramsFromFilename(filename);
    if (!parsed) {
      return res.json({ parse_failed: true, material_grams });
    }
    res.json({ parse_failed: false, ...parsed, material_grams });
  });

  // POST /api/gcodes/upload — upload G-code file and create DB record
  router.post('/upload', async (req, res) => {
    try {
      await runUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, material_grams,
            allowed_groups, required_material, required_color } = req.body;

    if (!part_id || !parts_per_plate || !printer_model) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'part_id, parts_per_plate, and printer_model are required' });
    }

    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(printer_model)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unknown model "${printer_model}". Add it in Settings → Printer Models first.` });
    }

    // Enforce uniqueness on (part_id, printer_model) at app layer
    const existing = db.prepare(
      'SELECT id FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part_id, printer_model);
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({
        error: `This Part already has a G-code for ${printer_model}. Delete the existing one before uploading a replacement.`,
      });
    }

    // ams_slot: -1 = external spool, 0–N = AMS slot, null = not applicable (non-Bambu)
    const parsedAmsSlot = ams_slot !== undefined && ams_slot !== '' ? parseInt(ams_slot, 10) : null;

    const parsedMaterialGrams = material_grams ? parseFloat(material_grams) : null;
    // allowed_groups: JSON array string e.g. '["MK4S Farm","XL Farm"]', or null = all groups
    const parsedAllowedGroups = allowed_groups && allowed_groups !== '' ? allowed_groups : null;
    const parsedRequiredMaterial = required_material && required_material !== '' ? required_material.trim() : null;
    const parsedRequiredColor    = required_color    && required_color    !== '' ? required_color.trim()    : null;

    const gcode = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, file_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      part_id,
      printer_model,
      req.file.originalname,
      req.file.filename,
      parseInt(parts_per_plate, 10),
      est_print_secs ? parseInt(est_print_secs, 10) : null,
      parsedMaterialGrams,
      parsedAmsSlot,
      parsedAllowedGroups,
      parsedRequiredMaterial,
      parsedRequiredColor,
      req.file.size,
      Date.now()
    );

    res.status(201).json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcode.lastInsertRowid));
  });

  // PUT /api/gcodes/:id — update est_print_secs and/or material_grams
  // Accepts human-readable strings ("2h15m", "45g") or raw numbers; omitting a field leaves it unchanged.
  router.put('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    let estPrintSecs = gcode.est_print_secs;
    if ('print_time' in req.body) {
      if (!req.body.print_time) {
        estPrintSecs = null;
      } else {
        estPrintSecs = normalizePrintTime(req.body.print_time);
        if (estPrintSecs === null) {
          return res.status(400).json({ error: 'Cannot parse print time. Use formats like "2h15m", "90m", or "1:30:00".' });
        }
      }
    }

    let materialGrams = gcode.material_grams;
    if ('material_grams' in req.body) {
      if (!req.body.material_grams) {
        materialGrams = null;
      } else {
        materialGrams = normalizeMaterialGrams(req.body.material_grams);
        if (materialGrams === null) {
          return res.status(400).json({ error: 'Cannot parse material. Use formats like "45g", "45.5g", or "1.2kg".' });
        }
      }
    }

    // allowed_groups / required_material / required_color: present-in-body wins; absent = keep existing
    const allowedGroups      = 'allowed_groups'      in req.body ? (req.body.allowed_groups      || null) : gcode.allowed_groups;
    const requiredMaterial   = 'required_material'   in req.body ? (req.body.required_material   || null) : gcode.required_material;
    const requiredColor      = 'required_color'      in req.body ? (req.body.required_color       || null) : gcode.required_color;

    db.prepare('UPDATE gcodes SET est_print_secs = ?, material_grams = ?, allowed_groups = ?, required_material = ?, required_color = ? WHERE id = ?')
      .run(estPrintSecs, materialGrams, allowedGroups, requiredMaterial, requiredColor, req.params.id);

    res.json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id));
  });

  // GET /api/gcodes/:id/preview — plain-text G-code for the 3D viewer, normalized
  // regardless of source format (.gcode passes through, .bgcode/.3mf are decoded server-side
  // so the client only ever has to deal with plain G-code text).
  router.get('/:id/preview', async (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, gcodeFilename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'G-code file is missing from disk' });
    }

    const ext = path.extname(gcode.filename).toLowerCase();
    try {
      const buffer = fs.readFileSync(fullPath);
      let text;
      if (ext === '.bgcode') {
        text = decodeBgcode(buffer);
      } else if (ext === '.3mf') {
        text = await decode3mf(buffer);
      } else {
        text = buffer.toString('utf8');
      }
      res.set('Content-Type', 'text/plain').send(text);
    } catch (err) {
      if (err instanceof GcodeDecodeError) {
        return res.status(422).json({ error: err.message, code: err.code });
      }
      // Any other decode failure (e.g. a corrupt Deflate/Heatshrink payload inside an
      // otherwise well-formed bgcode block, or a corrupt entry inside an otherwise valid .3mf
      // zip) must still resolve to a response rather than reject — this route runs on Express
      // 4, which doesn't catch rejected promises from async handlers, and the app's own
      // top-level `unhandledRejection` handler treats any that escape as fatal and exits the
      // process. A malformed uploaded file should return a 422, not take down the server.
      console.error(`[gcodes] preview decode failed for gcode ${req.params.id}:`, err);
      return res.status(422).json({ error: 'Failed to decode this G-code file — it may be corrupt.', code: 'DECODE_FAILED' });
    }
  });

  // DELETE /api/gcodes/:id
  router.delete('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const activeJob = db.prepare(
      "SELECT id FROM jobs WHERE gcode_id = ? AND status IN ('queued', 'uploading', 'printing') LIMIT 1"
    ).get(req.params.id);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete — this G-code has an active job in progress.' });
    }

    // Detach historical jobs so the FK doesn't block deletion
    db.prepare("UPDATE jobs SET gcode_id = NULL WHERE gcode_id = ?").run(req.params.id);

    const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, gcodeFilename);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    db.prepare('DELETE FROM gcodes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
