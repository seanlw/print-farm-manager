// Tests for DELETE /api/printers/:id
// Uses an in-memory SQLite DB. The driver registry and event log are mocked
// so the test never touches a real network connection or the on-disk DB.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
  dropConnection: jest.fn(),
}));
jest.mock('../events', () => ({ insert: jest.fn() }));

const { dropConnection } = require('../drivers');

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      ip               TEXT NOT NULL,
      api_key          TEXT NOT NULL DEFAULT '',
      group_name       TEXT,
      type             TEXT DEFAULT 'prusa',
      model            TEXT NOT NULL,
      status           TEXT DEFAULT 'UNKNOWN',
      is_held          INTEGER DEFAULT 1,
      is_active        INTEGER DEFAULT 1,
      decommissioned_at INTEGER,
      decommission_note TEXT,
      serial_number    TEXT DEFAULT '',
      created_at       INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL REFERENCES projects(id),
      name          TEXT NOT NULL,
      target_qty    INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'open',
      sort_order    INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_model   TEXT NOT NULL,
      filename        TEXT NOT NULL,
      filepath        TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs  INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id         INTEGER NOT NULL REFERENCES parts(id),
      printer_id      INTEGER NOT NULL REFERENCES printers(id),
      gcode_id        INTEGER NOT NULL REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status          TEXT DEFAULT 'queued',
      started_at      INTEGER,
      finished_at     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    CREATE TABLE printer_groups (
      name       TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

beforeEach(() => {
  dropConnection.mockClear();
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedPrinter(overrides = {}) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO printers (name, ip, type, model, status, is_held, is_active, decommissioned_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name    ?? `Printer_${now}_${Math.random()}`,
    overrides.ip      ?? '10.0.0.1',
    overrides.type    ?? 'prusa',
    overrides.model   ?? 'mk4s',
    overrides.status  ?? 'IDLE',
    overrides.is_held  ?? 0,
    overrides.is_active ?? 1,
    overrides.decommissioned_at ?? null,
    now
  );
  return r.lastInsertRowid;
}

function seedProject() {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Test Project', 'active', ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(projectId, targetQty = 10, completedQty = 0) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
     VALUES (?, 'Test Part', ?, ?, 'open', ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'part.bgcode', '/fake/path/part.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(printerId, partId, gcodeId, status = 'finished', partsPerPlate = 4) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, gcodeId, partsPerPlate, status, now - 3600000, status === 'finished' ? now : null, now - 3600000)
    .lastInsertRowid;
}

// ── DELETE /api/printers/:id ────────────────────────────────────────────────────

describe('DELETE /api/printers/:id', () => {
  test('returns 404 for unknown printer id', async () => {
    const res = await request(app).delete('/api/printers/99999');
    expect(res.status).toBe(404);
  });

  test('returns 409 when the printer is still active', async () => {
    const printerId = seedPrinter({ is_active: 1, decommissioned_at: null });

    const res = await request(app).delete(`/api/printers/${printerId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/decommissioned/i);

    // Nothing was touched
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer).toBeTruthy();
    expect(dropConnection).not.toHaveBeenCalled();
  });

  test('returns 409 when a decommissioned printer has an unresolved uploading job', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    seedJob(printerId, partId, gcodeId, 'uploading', 4);

    const res = await request(app).delete(`/api/printers/${printerId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/unresolved/i);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer).toBeTruthy();
  });

  test('returns 409 when a decommissioned printer has an unresolved printing job', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    seedJob(printerId, partId, gcodeId, 'printing', 4);

    const res = await request(app).delete(`/api/printers/${printerId}`);
    expect(res.status).toBe(409);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer).toBeTruthy();
  });

  test('deletes a decommissioned printer with no unresolved job', async () => {
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });

    const res = await request(app).delete(`/api/printers/${printerId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
    expect(printer).toBeUndefined();
  });

  test('drops the driver connection cache for the deleted printer', async () => {
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now(), type: 'bambu' });

    await request(app).delete(`/api/printers/${printerId}`);

    expect(dropConnection).toHaveBeenCalledTimes(1);
    expect(dropConnection).toHaveBeenCalledWith(expect.objectContaining({ id: printerId, type: 'bambu' }));
  });

  test('cascades: finished/failed job history for the printer is deleted with it', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    const jobId     = seedJob(printerId, partId, gcodeId, 'finished', 4);

    const res = await request(app).delete(`/api/printers/${printerId}`);
    expect(res.status).toBe(200);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    expect(job).toBeUndefined();
  });

  test('does not touch other printers or their job history', async () => {
    const projectId  = seedProject();
    const partId     = seedPart(projectId, 10, 4);
    const gcodeId    = seedGcode(partId);
    const targetId   = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    const survivorId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    const survivorJobId = seedJob(survivorId, partId, gcodeId, 'finished', 4);

    await request(app).delete(`/api/printers/${targetId}`);

    const survivor = db.prepare('SELECT * FROM printers WHERE id = ?').get(survivorId);
    expect(survivor).toBeTruthy();
    const survivorJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(survivorJobId);
    expect(survivorJob).toBeTruthy();
  });

  test('does not change completed_qty on the part (job history removal is not a credit event)', async () => {
    const projectId = seedProject();
    const partId    = seedPart(projectId, 10, 4);
    const gcodeId   = seedGcode(partId);
    const printerId = seedPrinter({ is_active: 0, decommissioned_at: Date.now() });
    seedJob(printerId, partId, gcodeId, 'finished', 4);

    await request(app).delete(`/api/printers/${printerId}`);

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4); // unchanged: completed_qty already reflects the credited print
  });
});
