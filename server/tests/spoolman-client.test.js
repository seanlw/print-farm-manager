// Unit tests for server/integrations/spoolman.js
// All network calls are mocked, no real Spoolman instance needed.

jest.mock('axios');
const axios = require('axios');

const Database = require('better-sqlite3');
const spoolman = require('../integrations/spoolman');

let db;

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
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
