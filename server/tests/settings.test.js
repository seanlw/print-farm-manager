const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE printers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      loaded_material   TEXT,
      loaded_color      TEXT,
      spoolman_spool_id INTEGER
    );
  `);
  db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();

  app = express();
  app.use(express.json());
  app.use('/api/settings', require('../routes/settings')(db));
});

describe('GET /api/settings', () => {
  test('returns all settings as a key/value object', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.dispatch_batch_size).toBe('10');
  });
});

describe('PUT /api/settings/dispatch_batch_size', () => {
  test('saves a valid value and returns it', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 5 });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('dispatch_batch_size');
    expect(res.body.value).toBe('5');
    // Persisted in DB
    expect(db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get().value).toBe('5');
  });

  test('rejects a value below 1', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a value above 100', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 101 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a non-numeric value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 'banana' });
    expect(res.status).toBe(400);
  });

  test('rejects an empty value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value is required/i);
  });

  test('rejects an unknown settings key', async () => {
    const res = await request(app)
      .put('/api/settings/unknown_key')
      .send({ value: '5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown setting key/i);
  });
});

describe('PUT /api/settings/spoolman_enabled', () => {
  test('accepts "true" and "false"', async () => {
    let res = await request(app).put('/api/settings/spoolman_enabled').send({ value: 'true' });
    expect(res.status).toBe(200);
    res = await request(app).put('/api/settings/spoolman_enabled').send({ value: 'false' });
    expect(res.status).toBe(200);
  });

  test('rejects any other value', async () => {
    const res = await request(app).put('/api/settings/spoolman_enabled').send({ value: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be "true" or "false"/i);
  });
});

describe('PUT /api/settings/spoolman_enabled: clears stale loaded_material/color', () => {
  // Reset to a known 'false' starting point regardless of prior test order.
  beforeEach(async () => {
    await request(app).put('/api/settings/spoolman_enabled').send({ value: 'false' });
  });

  test('clears loaded_material/loaded_color on unbound printers on the false→true transition', async () => {
    const unbound = db.prepare(
      "INSERT INTO printers (name, loaded_material, loaded_color) VALUES ('Unbound1', 'PLA', 'Black')"
    ).run();
    const bound = db.prepare(
      "INSERT INTO printers (name, loaded_material, loaded_color, spoolman_spool_id) VALUES ('Bound1', 'PETG', 'Red', 42)"
    ).run();

    const res = await request(app).put('/api/settings/spoolman_enabled').send({ value: 'true' });
    expect(res.status).toBe(200);

    const unboundRow = db.prepare('SELECT * FROM printers WHERE id = ?').get(unbound.lastInsertRowid);
    expect(unboundRow.loaded_material).toBeNull();
    expect(unboundRow.loaded_color).toBeNull();

    const boundRow = db.prepare('SELECT * FROM printers WHERE id = ?').get(bound.lastInsertRowid);
    expect(boundRow.loaded_material).toBe('PETG');
    expect(boundRow.loaded_color).toBe('Red');
  });

  test('does not re-clear on a repeated true write (only fires on the transition)', async () => {
    await request(app).put('/api/settings/spoolman_enabled').send({ value: 'true' });
    const row = db.prepare(
      "INSERT INTO printers (name, loaded_material, loaded_color) VALUES ('AlreadyEnabled', 'ABS', 'Grey')"
    ).run();

    const res = await request(app).put('/api/settings/spoolman_enabled').send({ value: 'true' });
    expect(res.status).toBe(200);

    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(row.lastInsertRowid);
    expect(printer.loaded_material).toBe('ABS');
    expect(printer.loaded_color).toBe('Grey');
  });
});

describe('PUT /api/settings/spoolman_base_url', () => {
  test('accepts an http(s) URL', async () => {
    const res = await request(app)
      .put('/api/settings/spoolman_base_url')
      .send({ value: 'http://spoolman.local:7912' });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'spoolman_base_url'").get().value)
      .toBe('http://spoolman.local:7912');
  });

  test('rejects a value with no scheme', async () => {
    const res = await request(app)
      .put('/api/settings/spoolman_base_url')
      .send({ value: 'spoolman.local:7912' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http:\/\/ or https:\/\//);
  });

  test('rejects a value over 200 characters', async () => {
    const res = await request(app)
      .put('/api/settings/spoolman_base_url')
      .send({ value: 'http://' + 'a'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200 characters/);
  });
});
