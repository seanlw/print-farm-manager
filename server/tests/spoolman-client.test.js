// Unit tests for server/integrations/spoolman.js
// All network calls are mocked, no real Spoolman instance needed.

jest.mock('axios');
const axios = require('axios');

jest.mock('../notifications', () => ({ add: jest.fn() }));
const notifications = require('../notifications');

const Database = require('better-sqlite3');
const spoolman = require('../integrations/spoolman');

let db;

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spoolman_spool_id INTEGER,
      spoolman_report_usage INTEGER DEFAULT 0
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parts_per_plate INTEGER,
      filament_used_grams REAL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER,
      gcode_id INTEGER,
      parts_per_plate INTEGER,
      spoolman_spool_id INTEGER,
      spoolman_reported_at INTEGER
    );
  `);
  setSetting('spoolman_enabled', 'false');
  spoolman.invalidateCache();
  jest.clearAllMocks();
});

describe('isEnabled', () => {
  test('false when spoolman_enabled is false', () => {
    expect(spoolman.isEnabled(db)).toBe(false);
  });

  test('false when enabled but no base URL configured', () => {
    setSetting('spoolman_enabled', 'true');
    expect(spoolman.isEnabled(db)).toBe(false);
  });

  test('true when enabled and base URL configured', () => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912');
    expect(spoolman.isEnabled(db)).toBe(true);
  });

  test('strips a trailing slash from the configured base URL', () => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912/');
    expect(spoolman.getConfig(db).baseUrl).toBe('http://spoolman.local:7912');
  });
});

describe('list/get functions when disabled', () => {
  test.each([
    ['listVendors', () => spoolman.listVendors(db)],
    ['listFilaments', () => spoolman.listFilaments(db)],
    ['listSpools', () => spoolman.listSpools(db)],
    ['getSpool', () => spoolman.getSpool(db, 1)],
  ])('%s throws SPOOLMAN_DISABLED without touching the network', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'SPOOLMAN_DISABLED' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('list/get functions when enabled', () => {
  beforeEach(() => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912');
  });

  test('listVendors calls GET /api/v1/vendor', async () => {
    axios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Polymaker' }] });
    const result = await spoolman.listVendors(db);
    expect(axios.get).toHaveBeenCalledWith('http://spoolman.local:7912/api/v1/vendor', expect.objectContaining({ timeout: 8000 }));
    expect(result).toEqual([{ id: 1, name: 'Polymaker' }]);
  });

  test('listFilaments calls GET /api/v1/filament', async () => {
    axios.get.mockResolvedValueOnce({ data: [] });
    await spoolman.listFilaments(db);
    expect(axios.get).toHaveBeenCalledWith('http://spoolman.local:7912/api/v1/filament', expect.anything());
  });

  test('listSpools passes query params through to GET /api/v1/spool', async () => {
    axios.get.mockResolvedValueOnce({ data: [] });
    await spoolman.listSpools(db, { allow_archived: 'false' });
    expect(axios.get).toHaveBeenCalledWith('http://spoolman.local:7912/api/v1/spool?allow_archived=false', expect.anything());
  });

  test('getSpool calls GET /api/v1/spool/:id and is never cached', async () => {
    axios.get.mockResolvedValue({ data: { id: 7 } });
    await spoolman.getSpool(db, 7);
    await spoolman.getSpool(db, 7);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenCalledWith('http://spoolman.local:7912/api/v1/spool/7', expect.anything());
  });

  test('cached list calls only hit axios once within the TTL', async () => {
    axios.get.mockResolvedValue({ data: [] });
    await spoolman.listVendors(db);
    await spoolman.listVendors(db);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('invalidateCache forces a fresh fetch', async () => {
    axios.get.mockResolvedValue({ data: [] });
    await spoolman.listVendors(db);
    spoolman.invalidateCache();
    await spoolman.listVendors(db);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe('getStatus', () => {
  test('reports not reachable, no network call, when disabled', async () => {
    const status = await spoolman.getStatus(db);
    expect(status).toEqual({ enabled: false, base_url: null, reachable: false });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('reports reachable when enabled and the info endpoint responds', async () => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912');
    axios.get.mockResolvedValueOnce({ data: { version: '0.23.1' } });
    const status = await spoolman.getStatus(db);
    expect(status).toEqual({ enabled: true, base_url: 'http://spoolman.local:7912', reachable: true });
  });

  test('reports unreachable with the error message when the info call fails', async () => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912');
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const status = await spoolman.getStatus(db);
    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/ECONNREFUSED/);
  });
});

describe('reportJobUsage', () => {
  function seedPrinter(overrides = {}) {
    return db.prepare(
      'INSERT INTO printers (spoolman_spool_id, spoolman_report_usage) VALUES (?, ?)'
    ).run(
      overrides.spoolman_spool_id ?? null,
      overrides.spoolman_report_usage ?? 1
    ).lastInsertRowid;
  }

  function seedGcode(overrides = {}) {
    return db.prepare(
      'INSERT INTO gcodes (parts_per_plate, filament_used_grams) VALUES (?, ?)'
    ).run(
      overrides.parts_per_plate ?? 4,
      'filament_used_grams' in overrides ? overrides.filament_used_grams : 40
    ).lastInsertRowid;
  }

  function seedJob(printerId, gcodeId, overrides = {}) {
    return db.prepare(
      'INSERT INTO jobs (printer_id, gcode_id, parts_per_plate, spoolman_spool_id, spoolman_reported_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      printerId,
      gcodeId,
      overrides.parts_per_plate ?? 4,
      'spoolman_spool_id' in overrides ? overrides.spoolman_spool_id : null,
      overrides.spoolman_reported_at ?? null
    ).lastInsertRowid;
  }

  test('disabled: returns without touching the network or the DB beyond the settings check', async () => {
    const printerId = seedPrinter({ spoolman_spool_id: 7 });
    const gcodeId    = seedGcode();
    const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7 });

    const result = await spoolman.reportJobUsage(db, jobId);

    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(axios.put).not.toHaveBeenCalled();
  });

  describe('when enabled', () => {
    beforeEach(() => {
      setSetting('spoolman_enabled', 'true');
      setSetting('spoolman_base_url', 'http://spoolman.local:7912');
    });

    test('not-found: unknown job id', async () => {
      const result = await spoolman.reportJobUsage(db, 999999);
      expect(result).toEqual({ ok: false, reason: 'not-found' });
    });

    test('already-reported: job.spoolman_reported_at already set', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7, spoolman_reported_at: Date.now() });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result).toEqual({ ok: false, reason: 'already-reported' });
      expect(axios.put).not.toHaveBeenCalled();
    });

    test('opted-out: printer.spoolman_report_usage is 0', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7, spoolman_report_usage: 0 });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7 });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result).toEqual({ ok: false, reason: 'opted-out' });
      expect(axios.put).not.toHaveBeenCalled();
    });

    test('not-bound: neither the job nor the printer has a spool bound', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: null });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: null });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result).toEqual({ ok: false, reason: 'not-bound' });
      expect(axios.put).not.toHaveBeenCalled();
    });

    test('falls back to the printer\'s currently bound spool when the job has no snapshot', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: null });
      axios.put.mockResolvedValueOnce({ data: {} });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result.ok).toBe(true);
      expect(axios.put).toHaveBeenCalledWith(
        'http://spoolman.local:7912/api/v1/spool/7/use',
        expect.anything(),
        expect.anything()
      );
    });

    test('no-parsed-usage: gcode has no filament_used_grams, and a notification is added', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode({ filament_used_grams: null });
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7 });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result).toEqual({ ok: false, reason: 'no-parsed-usage' });
      expect(axios.put).not.toHaveBeenCalled();
      expect(notifications.add).toHaveBeenCalledWith(expect.stringContaining(`job ${jobId}`));
    });

    test('no-parsed-usage: job has no gcode_id at all', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const jobId = db.prepare(
        'INSERT INTO jobs (printer_id, gcode_id, parts_per_plate, spoolman_spool_id) VALUES (?, NULL, 4, 7)'
      ).run(printerId).lastInsertRowid;

      const result = await spoolman.reportJobUsage(db, jobId);
      expect(result).toEqual({ ok: false, reason: 'no-parsed-usage' });
    });

    test('success: PUTs the exact use_weight payload and marks the job reported', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode({ parts_per_plate: 4, filament_used_grams: 40 });
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7, parts_per_plate: 4 });
      axios.put.mockResolvedValueOnce({ data: {} });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result).toEqual({ ok: true, grams: 40 });
      expect(axios.put).toHaveBeenCalledWith(
        'http://spoolman.local:7912/api/v1/spool/7/use',
        { use_weight: 40 },
        expect.objectContaining({ timeout: 8000 })
      );
      const job = db.prepare('SELECT spoolman_reported_at FROM jobs WHERE id = ?').get(jobId);
      expect(job.spoolman_reported_at).toEqual(expect.any(Number));
    });

    test('prorates by the live gcode.parts_per_plate, not the frozen job value', async () => {
      // Job was dispatched when the gcode plated 4; the gcode has since been edited to plate 2.
      // gramsForJob = job.parts_per_plate(4) * (filament_used_grams(40) / gcode.parts_per_plate(2)) = 80
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode({ parts_per_plate: 2, filament_used_grams: 40 });
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7, parts_per_plate: 4 });
      axios.put.mockResolvedValueOnce({ data: {} });

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result.grams).toBe(80);
    });

    test('http-error: axios rejects, job is not marked reported, no throw', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7 });
      axios.put.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const result = await spoolman.reportJobUsage(db, jobId);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('http-error');
      expect(result.error).toMatch(/ECONNREFUSED/);
      const job = db.prepare('SELECT spoolman_reported_at FROM jobs WHERE id = ?').get(jobId);
      expect(job.spoolman_reported_at).toBeNull();
    });

    test('a second call after a successful report is idempotent (already-reported)', async () => {
      const printerId = seedPrinter({ spoolman_spool_id: 7 });
      const gcodeId    = seedGcode();
      const jobId      = seedJob(printerId, gcodeId, { spoolman_spool_id: 7 });
      axios.put.mockResolvedValueOnce({ data: {} });

      await spoolman.reportJobUsage(db, jobId);
      const second = await spoolman.reportJobUsage(db, jobId);

      expect(second).toEqual({ ok: false, reason: 'already-reported' });
      expect(axios.put).toHaveBeenCalledTimes(1);
    });
  });
});
