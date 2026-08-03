// Route tests for server/routes/spoolman.js: the proxy layer between the browser
// and a Spoolman instance. All network calls are mocked.

jest.mock('axios');
const axios = require('axios');

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const spoolman = require('../integrations/spoolman');

let db;
let app;

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  setSetting('spoolman_enabled', 'false');
  spoolman.invalidateCache();
  jest.clearAllMocks();

  app = express();
  app.use(express.json());
  app.use('/api/spoolman', require('../routes/spoolman')(db));
});

describe('when Spoolman is disabled', () => {
  test.each([
    ['/api/spoolman/status'],
    ['/api/spoolman/vendors'],
    ['/api/spoolman/filaments'],
    ['/api/spoolman/spools'],
    ['/api/spoolman/spools/1'],
  ])('GET %s returns 400', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('when Spoolman is enabled', () => {
  beforeEach(() => {
    setSetting('spoolman_enabled', 'true');
    setSetting('spoolman_base_url', 'http://spoolman.local:7912');
  });

  test('GET /status reports reachable on success', async () => {
    axios.get.mockResolvedValueOnce({ data: { version: '0.23.1' } });
    const res = await request(app).get('/api/spoolman/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, base_url: 'http://spoolman.local:7912', reachable: true });
  });

  test('GET /vendors proxies Spoolman and returns 200', async () => {
    axios.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Polymaker' }] });
    const res = await request(app).get('/api/spoolman/vendors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Polymaker' }]);
  });

  test('GET /vendors returns 502 when Spoolman is unreachable', async () => {
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).get('/api/spoolman/vendors');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });

  test('GET /filaments proxies Spoolman and returns 200', async () => {
    axios.get.mockResolvedValueOnce({ data: [{ id: 1, material: 'PLA' }] });
    const res = await request(app).get('/api/spoolman/filaments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, material: 'PLA' }]);
  });

  test('GET /spools passes query filters through', async () => {
    axios.get.mockResolvedValueOnce({ data: [] });
    const res = await request(app).get('/api/spoolman/spools?allow_archived=false');
    expect(res.status).toBe(200);
    expect(axios.get).toHaveBeenCalledWith(
      'http://spoolman.local:7912/api/v1/spool?allow_archived=false',
      expect.anything()
    );
  });

  test('GET /spools/:id returns 404 when Spoolman reports the spool missing', async () => {
    axios.get.mockRejectedValueOnce({ message: 'Request failed', response: { status: 404 } });
    const res = await request(app).get('/api/spoolman/spools/999');
    expect(res.status).toBe(404);
  });

  test('repeated GET /vendors within the cache TTL only hits Spoolman once', async () => {
    axios.get.mockResolvedValue({ data: [] });
    await request(app).get('/api/spoolman/vendors');
    await request(app).get('/api/spoolman/vendors');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});
