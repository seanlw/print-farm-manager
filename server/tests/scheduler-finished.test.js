// Tests for scheduler._handleFinished
//
// Covers:
//   - Normal path: 'printing' job found → mark finished, increment qty, hold printer
//   - MQTT recovery: no 'printing' job but recent 'failed' job → recover + credit
//   - 24h window: 'failed' job older than 24h is NOT recovered
//   - No job at all: warn and return cleanly
//   - Part closure: completed_qty reaching target closes the part
//   - Project completion: all parts closed → project marked completed
//   - getDriver called with printer.type (string), not the printer object

const Database    = require('better-sqlite3');
const JobScheduler = require('../scheduler');

// Mock the drivers module — _handleFinished calls getDriver for SD-card cleanup.
// mockDriver is referenced lazily inside the factory arrow function so the
// jest.mock hoisting doesn't hit the temporal dead zone for the const declaration.
const mockDriver = { deleteFile: jest.fn().mockResolvedValue(undefined) };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
// Grab the mocked getDriver after the mock is registered so we can assert on it.
const { getDriver: mockGetDriver } = require('../drivers');

// Suppress event logging side-effects
jest.mock('../events', () => ({ insert: jest.fn() }));

afterEach(() => jest.clearAllMocks());

// ── DB + scheduler factory ────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
      status TEXT DEFAULT 'PRINTING', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10');
  `);
  return db;
}

function makeScheduler(db) {
  const scheduler = new JobScheduler(db, { on: () => {} });
  // Prevent _dispatchToPrinter from running (it requires a full DB candidate)
  scheduler._dispatchToPrinter = jest.fn().mockResolvedValue(null);
  return scheduler;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedPrinter(db, overrides = {}) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO printers (name, ip, model, type, status, is_held, is_active, created_at)
    VALUES (?, '10.0.0.1', ?, ?, 'PRINTING', 0, 1, ?)
  `).run(
    overrides.name  ?? `Printer_${now}`,
    overrides.model ?? 'mk4s',
    overrides.type  ?? 'bambu',
    now
  ).lastInsertRowid;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO projects (name, status, priority, created_at, updated_at)
     VALUES ('Proj', 'active', 0, ?, ?)`
  ).run(now, now).lastInsertRowid;
}

function seedPart(db, projectId, { targetQty = 10, completedQty = 0 } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, created_at, updated_at)
     VALUES (?, 'Part A', ?, ?, 'open', 0, ?, ?)`
  ).run(projectId, targetQty, completedQty, now, now).lastInsertRowid;
}

function seedGcode(db, partId) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at)
     VALUES (?, 'mk4s', 'test.bgcode', 'test.bgcode', 4, ?)`
  ).run(partId, now).lastInsertRowid;
}

function seedJob(db, printerId, partId, gcodeId, status = 'printing', { partsPerPlate = 4, startedAt } = {}) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO jobs (printer_id, part_id, gcode_id, parts_per_plate, status, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(printerId, partId, gcodeId, partsPerPlate, status, startedAt ?? now - 3600_000, now - 3600_000)
    .lastInsertRowid;
}

function makePrinter(db, printerId) {
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
}

// ── Normal path: 'printing' job ───────────────────────────────────────────────

describe('_handleFinished — normal path (printing job)', () => {
  test('marks the job as finished', () => {
    const db         = makeDb();
    const scheduler  = makeScheduler(db);
    const projectId  = seedProject(db);
    const partId     = seedPart(db, projectId);
    const gcodeId    = seedGcode(db, partId);
    const printerId  = seedPrinter(db);
    const jobId      = seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('increments completed_qty by parts_per_plate', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 2 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(6); // 2 + 4
  });

  test('holds the printer after a successful finish', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);
  });

  test('closes the part when completed_qty reaches target_qty', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    // target = 4, completed = 0; parts_per_plate = 4 → exactly hits target
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT status FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('closed');
  });

  test('marks the project completed when it is the last open part', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('completed');
  });

  test('does not close the project when other parts are still open', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    // A second open part
    seedPart(db, projectId, { targetQty: 8, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('active');
  });

  test('calls getDriver with printer.type string, not the printer object', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db, { type: 'bambu' });
    seedJob(db, printerId, partId, gcodeId, 'printing');

    scheduler._handleFinished(makePrinter(db, printerId));

    expect(mockGetDriver).toHaveBeenCalledWith('bambu');
    expect(mockGetDriver).not.toHaveBeenCalledWith(expect.objectContaining({ id: printerId }));
  });
});

// ── MQTT recovery: 'failed' job ───────────────────────────────────────────────
//
// Scenario: Bambu MQTT connection briefly drops during a print. The 'reconnect'
// event sets conn.connected = false, so the next getStatus() returns OFFLINE.
// _handlePrinterUnavailable marks the job 'failed'. The printer keeps printing.
// When it finishes, _handleFinished must recover the failed job and credit the count.

describe('_handleFinished — MQTT recovery (failed job, no printing job)', () => {
  test('credits completed_qty when the only recent job is failed', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });

  test('marks the recovered failed job as finished', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    const jobId     = seedJob(db, printerId, partId, gcodeId, 'failed');

    scheduler._handleFinished(makePrinter(db, printerId));

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    expect(job.status).toBe('finished');
  });

  test('holds the printer after recovering a failed job', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId);
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed');

    scheduler._handleFinished(makePrinter(db, printerId));

    const printer = db.prepare('SELECT is_held FROM printers WHERE id = ?').get(printerId);
    expect(printer.is_held).toBe(1);
  });

  test('closes the part when recovery pushes completed_qty to target', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { targetQty: 4, completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);
    seedJob(db, printerId, partId, gcodeId, 'failed', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT status FROM parts WHERE id = ?').get(partId);
    expect(part.status).toBe('closed');
  });

  test('prefers a printing job over a failed one when both exist', () => {
    // If somehow both exist, the printing job is the authoritative one.
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    const failedJobId   = seedJob(db, printerId, partId, gcodeId, 'failed',   { partsPerPlate: 4 });
    const printingJobId = seedJob(db, printerId, partId, gcodeId, 'printing', { partsPerPlate: 4 });

    scheduler._handleFinished(makePrinter(db, printerId));

    const printingJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(printingJobId);
    const failedJob   = db.prepare('SELECT status FROM jobs WHERE id = ?').get(failedJobId);
    expect(printingJob.status).toBe('finished'); // the printing job was resolved
    expect(failedJob.status).toBe('failed');     // the failed job was left alone
  });
});

// ── 24h window: stale failed jobs are ignored ─────────────────────────────────

describe('_handleFinished — 24h recovery window', () => {
  test('does not recover a failed job older than 24 hours', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    // started_at more than 24 h ago
    const oldStart = Date.now() - 25 * 60 * 60 * 1000;
    seedJob(db, printerId, partId, gcodeId, 'failed', { startedAt: oldStart });

    scheduler._handleFinished(makePrinter(db, printerId));

    // No printing job and stale failed job → count should not change
    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(0);
  });

  test('does recover a failed job within 24 hours', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 0 });
    const gcodeId   = seedGcode(db, partId);
    const printerId = seedPrinter(db);

    // started_at just under 24 h ago — should still qualify
    const recentStart = Date.now() - 23 * 60 * 60 * 1000;
    seedJob(db, printerId, partId, gcodeId, 'failed', { startedAt: recentStart });

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(4);
  });
});

// ── No job found ──────────────────────────────────────────────────────────────

describe('_handleFinished — no job found', () => {
  test('does not throw when no printing or failed job exists', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const printerId = seedPrinter(db);

    expect(() => scheduler._handleFinished(makePrinter(db, printerId))).not.toThrow();
  });

  test('does not modify completed_qty when no job is found', () => {
    const db        = makeDb();
    const scheduler = makeScheduler(db);
    const projectId = seedProject(db);
    const partId    = seedPart(db, projectId, { completedQty: 5 });
    const printerId = seedPrinter(db);
    // No job seeded

    scheduler._handleFinished(makePrinter(db, printerId));

    const part = db.prepare('SELECT completed_qty FROM parts WHERE id = ?').get(partId);
    expect(part.completed_qty).toBe(5); // unchanged
  });
});
