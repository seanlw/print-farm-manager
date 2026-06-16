const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_models (
      model_id  TEXT PRIMARY KEY,
      label     TEXT NOT NULL,
      connector TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE printers (
      id        INTEGER PRIMARY KEY,
      model     TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  app = express();
  app.use(express.json());
  app.use('/api/models', require('../routes/models')(db));
});

beforeEach(() => {
  db.exec('DELETE FROM printers');
  db.exec('DELETE FROM printer_models');
});

// ── GET /api/models ──────────────────────────────────────────────────────────

describe('GET /api/models', () => {
  test('returns empty array when no models configured', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns all models ordered by connector then model_id', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    db.exec(`INSERT INTO printer_models VALUES ('x1c', 'X1 Carbon', 'bambu')`);
    db.exec(`INSERT INTO printer_models VALUES ('a1', 'A1', 'bambu')`);

    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    // bambu < prusa alphabetically; within bambu: a1 < x1c
    expect(res.body.map(m => m.model_id)).toEqual(['a1', 'x1c', 'mk4']);
  });
});

// ── POST /api/models ─────────────────────────────────────────────────────────

describe('POST /api/models', () => {
  test('creates a model and returns 201 with the new record', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'mk4', label: 'MK4', connector: 'prusa' });
    expect(res.status).toBe(201);
    expect(res.body.model_id).toBe('mk4');
    expect(res.body.label).toBe('MK4');
    expect(res.body.connector).toBe('prusa');
  });

  test('normalizes model_id to lowercase with hyphens', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'My Printer 3000', label: 'My Printer', connector: 'prusa' });
    expect(res.status).toBe(201);
    expect(res.body.model_id).toBe('my-printer-3000');
  });

  test('trims whitespace from label', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'p1s', label: '  P1S  ', connector: 'bambu' });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('P1S');
  });

  test('accepts all valid connectors', async () => {
    const connectors = ['prusa', 'elegoo-centauri', 'elegoo-centauri2', 'bambu'];
    for (const [i, connector] of connectors.entries()) {
      const res = await request(app)
        .post('/api/models')
        .send({ model_id: `model-${i}`, label: `Model ${i}`, connector });
      expect(res.status).toBe(201);
    }
  });

  test('rejects an unknown connector', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'foo', label: 'Foo', connector: 'unknown-brand' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connector must be one of/i);
  });

  test('rejects missing model_id', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ label: 'MK4', connector: 'prusa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('rejects missing label', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'mk4', connector: 'prusa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('rejects missing connector', async () => {
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'mk4', label: 'MK4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('returns 409 on duplicate model_id', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'mk4', label: 'MK4 dupe', connector: 'prusa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('duplicate check uses normalized model_id', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    const res = await request(app)
      .post('/api/models')
      .send({ model_id: 'MK4', label: 'MK4 caps', connector: 'prusa' });
    expect(res.status).toBe(409);
  });
});

// ── DELETE /api/models/:model_id ─────────────────────────────────────────────

describe('DELETE /api/models/:model_id', () => {
  test('deletes a model and returns ok', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    const res = await request(app).delete('/api/models/mk4');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get('mk4')).toBeUndefined();
  });

  test('returns 404 for non-existent model', async () => {
    const res = await request(app).delete('/api/models/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('blocks delete when active printers use the model', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    db.exec(`INSERT INTO printers (model, is_active) VALUES ('mk4', 1)`);
    const res = await request(app).delete('/api/models/mk4');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active printer/i);
  });

  test('allows delete when only inactive printers use the model', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    db.exec(`INSERT INTO printers (model, is_active) VALUES ('mk4', 0)`);
    const res = await request(app).delete('/api/models/mk4');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('block message includes the count of affected printers', async () => {
    db.exec(`INSERT INTO printer_models VALUES ('mk4', 'MK4', 'prusa')`);
    db.exec(`INSERT INTO printers (model, is_active) VALUES ('mk4', 1)`);
    db.exec(`INSERT INTO printers (model, is_active) VALUES ('mk4', 1)`);
    const res = await request(app).delete('/api/models/mk4');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 active printer/i);
  });
});
