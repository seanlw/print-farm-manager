#!/usr/bin/env node
// Temporary diagnostic script — test different gcode_file MQTT payload formats
// against a Bambu printer without going through the full dispatch cycle.
//
// Usage (run from repo root on the print farm server):
//   node scripts/test-bambu-print.js <printer-name> <filename-on-sdcard>
//
// Example:
//   node scripts/test-bambu-print.js "A2L" "1782781677115_Body_23_PLA_3h43m.gcode"
//
// The script connects to MQTT, waits for the first status push to confirm
// the connection is live, then lets you pick a variant to send interactively.

const path     = require('path');
const mqtt     = require('mqtt');
const Database = require('better-sqlite3');
const readline = require('readline');

const [,, printerName, filename] = process.argv;
if (!printerName || !filename) {
  console.error('Usage: node scripts/test-bambu-print.js <printer-name> <filename-on-sdcard>');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '../server/data/farm.db'));
const printer = db.prepare(
  "SELECT * FROM printers WHERE name = ? COLLATE NOCASE"
).get(printerName);

if (!printer) {
  console.error(`Printer "${printerName}" not found in DB.`);
  process.exit(1);
}

if (!printer.serial_number || !printer.api_key || !printer.ip) {
  console.error(`Printer "${printerName}" is missing ip, api_key, or serial_number.`);
  process.exit(1);
}

const { ip, api_key, serial_number, name } = printer;

console.log(`\nPrinter : ${name}`);
console.log(`IP      : ${ip}`);
console.log(`Serial  : ${serial_number}`);
console.log(`File    : ${filename}`);
console.log('\nConnecting to MQTT...\n');

const client = mqtt.connect(`mqtts://${ip}:8883`, {
  username:           'bblp',
  password:           api_key,
  rejectUnauthorized: false,
  connectTimeout:     10000,
  reconnectPeriod:    0,  // no auto-reconnect in test script
});

// Payload variants to try — numbered so user can pick
const variants = [
  {
    label: 'gcode_file — bare filename (current code)',
    payload: {
      sequence_id: '0',
      command:     'gcode_file',
      param:       filename,
    },
  },
  {
    label: 'gcode_file — gcodes/ prefix',
    payload: {
      sequence_id: '0',
      command:     'gcode_file',
      param:       `gcodes/${filename}`,
    },
  },
  {
    label: 'gcode_file — absolute /mnt/sdcard/gcodes/ path',
    payload: {
      sequence_id: '0',
      command:     'gcode_file',
      param:       `/mnt/sdcard/gcodes/${filename}`,
    },
  },
  {
    label: 'project_file — ftp:///gcodes/<file> (treats gcode like a project)',
    payload: {
      sequence_id:    '0',
      command:        'project_file',
      param:          filename,
      subtask_name:   path.basename(filename, path.extname(filename)),
      url:            `ftp:///gcodes/${filename}`,
      bed_type:       'auto',
      timelapse:      false,
      bed_leveling:   true,
      flow_cali:      false,
      vibration_cali: true,
      layer_inspect:  false,
      use_ams:        false,
      ams_mapping:    [],
      profile_id:     '0',
      project_id:     '0',
      subtask_id:     '0',
      task_id:        '0',
    },
  },
];

function printMenu() {
  console.log('\nPick a variant to send (or q to quit):');
  variants.forEach((v, i) => {
    console.log(`  ${i + 1}. ${v.label}`);
  });
  process.stdout.write('\n> ');
}

function send(variant) {
  const body = JSON.stringify({ print: variant.payload });
  console.log(`\nSending: ${body}`);
  client.publish(`device/${serial_number}/request`, body, { qos: 0 }, (err) => {
    if (err) console.error('Publish error:', err.message);
    else console.log('Published. Watch the printer — did it start?\n');
    printMenu();
  });
}

client.on('connect', () => {
  console.log('MQTT connected. Subscribing to status topic...');
  client.subscribe(`device/${serial_number}/report`, (err) => {
    if (err) console.error('Subscribe error:', err.message);
  });
  // Request a full status dump to confirm two-way comms
  client.publish(`device/${serial_number}/request`, JSON.stringify({
    pushing: { sequence_id: '0', command: 'pushall', push_target: 1 },
  }));
});

let firstStatus = false;
client.on('message', (_topic, msg) => {
  if (!firstStatus) {
    firstStatus = true;
    console.log('Status received from printer — connection is live.');
    printMenu();
  }
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const input = line.trim().toLowerCase();
  if (input === 'q') {
    client.end();
    rl.close();
    process.exit(0);
  }
  const idx = parseInt(input, 10) - 1;
  if (idx >= 0 && idx < variants.length) {
    send(variants[idx]);
  } else {
    console.log('Invalid choice.');
    printMenu();
  }
});
