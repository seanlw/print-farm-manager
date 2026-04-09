// Unit tests for server/drivers/bambu.js
// mqtt and basic-ftp are mocked — no real network connections needed.
//
// Each test uses a unique printer ID to avoid sharing the module-level
// connection cache (Map of id → conn) between test cases.

jest.mock('mqtt');
jest.mock('basic-ftp');

const mqtt = require('mqtt');
const ftp  = require('basic-ftp');
const bambu = require('../drivers/bambu');

// ─── Mock setup ───────────────────────────────────────────────────────────────

let mockPublish;
let mockSubscribe;
let mockMqttClient;
let messageHandler; // captured from client.on('message', handler)

let mockFtpClient;

beforeEach(() => {
  messageHandler = null;

  mockPublish   = jest.fn();
  mockSubscribe = jest.fn();

  mockMqttClient = {
    // Fire 'connect' synchronously so conn.connected = true immediately.
    // Capture 'message' handler for AMS state injection in tests.
    on: jest.fn((event, handler) => {
      if (event === 'connect') handler();
      if (event === 'message') messageHandler = handler;
    }),
    publish:   mockPublish,
    subscribe: mockSubscribe,
    end:       jest.fn(),
  };
  mqtt.connect.mockReturnValue(mockMqttClient);

  mockFtpClient = {
    ftp:        { verbose: false },
    access:     jest.fn().mockResolvedValue(undefined),
    uploadFrom: jest.fn().mockResolvedValue(undefined),
    close:      jest.fn(),
  };
  ftp.Client.mockImplementation(() => mockFtpClient);
});

afterEach(() => jest.clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 300;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `Bambu_${id}`, ip: '192.168.1.50', api_key: 'TESTCODE',
           serial_number: `SN${id}`, model: 'x1c', type: 'bambu' };
}

// Establish a connection for the printer (populates the internal Map)
// then inject a status push to set conn.latestPrint.
function pushStatus(printer, printData) {
  bambu.getStatus(printer); // creates connection, registers message handler
  expect(messageHandler).not.toBeNull();
  messageHandler(null, Buffer.from(JSON.stringify({ print: printData })));
}

// Parse the MQTT payload from the first publish call that matches a command.
function findPayload(command) {
  const call = mockPublish.mock.calls.find(c => {
    try { return JSON.parse(c[1]).print?.command === command; } catch { return false; }
  });
  return call ? JSON.parse(call[1]).print : null;
}

// ─── getAmsSlots ──────────────────────────────────────────────────────────────

describe('getAmsSlots', () => {
  test('returns null when printer has no connection yet', () => {
    expect(bambu.getAmsSlots(nextPrinter())).toBeNull();
  });

  test('returns null when connected but no status received yet', () => {
    const printer = nextPrinter();
    bambu.getStatus(printer); // creates connection; latestPrint is still null
    expect(bambu.getAmsSlots(printer)).toBeNull();
  });

  test('returns loaded AMS trays, skipping empty slots', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [{
          id: '0',
          tray: [
            { id: '0' },                                             // empty — no tray_type
            { id: '1', tray_type: 'PLA', tray_color: 'FFFFFFFF' }, // loaded
          ],
        }],
      },
      vt_tray: { tray_type: 'PETG', tray_color: 'FF0000FF' },
    });

    const slots = bambu.getAmsSlots(printer);
    // AMS unit 0, tray 1 → compound slot (0*4)+1 = 1
    expect(slots).toContainEqual({ slot: 1, type: 'PLA', color: 'FFFFFFFF' });
    // Empty tray (id 0) must be excluded
    expect(slots.find(s => s.slot === 0 && s.type)).toBeUndefined();
  });

  test('always includes external spool as slot -1', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams:     { ams: [] },
      vt_tray: { tray_type: 'ABS', tray_color: '000000FF' },
    });
    expect(bambu.getAmsSlots(printer)).toContainEqual(
      { slot: -1, type: 'ABS', color: '000000FF' }
    );
  });

  test('includes external spool even when no filament is loaded', () => {
    const printer = nextPrinter();
    pushStatus(printer, { ams: { ams: [] }, vt_tray: {} });
    const ext = bambu.getAmsSlots(printer).find(s => s.slot === -1);
    expect(ext).toBeDefined();
    expect(ext.type).toBe('');
  });

  test('computes compound slot IDs for multi-unit AMS', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [
          { id: '0', tray: [{ id: '0', tray_type: 'PLA',  tray_color: 'FFFF00FF' }] },
          { id: '1', tray: [{ id: '2', tray_type: 'ABS',  tray_color: '000000FF' }] },
        ],
      },
      vt_tray: {},
    });
    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFF00FF' }); // (0*4)+0
    expect(slots).toContainEqual({ slot: 6, type: 'ABS', color: '000000FF' }); // (1*4)+2
  });
});

// ─── uploadAndPrint — .3mf ────────────────────────────────────────────────────

describe('uploadAndPrint — .3mf (project_file)', () => {
  test('uses project_file MQTT command', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file')).not.toBeNull();
  });

  test('URL is ftp:///filename (per OpenBambuAPI spec)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file').url).toBe('ftp:///1234_part.3mf');
  });

  test('AMS slot 0: use_ams true, ams_mapping [-1,-1,-1,-1,0]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([-1, -1, -1, -1, 0]);
  });

  test('AMS slot 3: ams_mapping uses correct index', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 3 });

    expect(findPayload('project_file').ams_mapping).toEqual([-1, -1, -1, -1, 3]);
  });

  test('external spool (amsSlot: -1): use_ams false, ams_mapping empty string', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: -1 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toBe('');
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: null });

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('omitting options entirely defaults to use_ams false', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf');

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('uploads to FTP root (no ensureDir for .3mf)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith('/tmp/1234_part.3mf', '1234_part.3mf');
  });

  test('throws when MQTT is not connected', async () => {
    const printer = nextPrinter();
    // Override: suppress 'connect' so conn.connected stays false
    mockMqttClient.on = jest.fn((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/MQTT not connected/);
  });

  test('throws when serial_number is missing', async () => {
    const printer = { ...nextPrinter(), serial_number: '' };
    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/no serial number/);
  });
});

// ─── uploadAndPrint — .gcode ──────────────────────────────────────────────────

describe('uploadAndPrint — .gcode (gcode_file)', () => {
  test('uses gcode_file MQTT command', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode');

    expect(findPayload('gcode_file')).not.toBeNull();
  });

  test('param is the bare filename (no path prefix)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode');

    expect(findPayload('gcode_file').param).toBe('1234_part.gcode');
  });

  test('uploads to FTP root', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode');

    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith(
      '/tmp/1234_part.gcode', '1234_part.gcode'
    );
  });

  test('.bgcode also uses gcode_file command', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.bgcode', 'part.bgcode');

    expect(findPayload('gcode_file')).not.toBeNull();
  });
});
