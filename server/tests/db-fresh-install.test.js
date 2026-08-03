const fs = require('fs');
const path = require('path');

// server/db.js is deliberately never imported by other test files (see CLAUDE.md:
// tests build an in-memory schema instead), because it opens a real on-disk file
// and runs the full startup migration chain. That is exactly what this file needs
// to exercise: a bug where a Spoolman column addition ran before an older
// gcode_id-nullable rebuild migration broke that rebuild on every fresh install
// (a brand-new database always has gcode_id NOT NULL, so the rebuild always fires).
// Copying db.js into its own scratch directory keeps this isolated from every
// other test's expectations while still requiring the real migration code.
describe('server/db.js: fresh-install migration ordering', () => {
  const scratchDir = path.join(__dirname, '.tmp-fresh-install');
  let db;

  afterAll(() => {
    if (db) db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  test('a brand-new database ends up with a nullable gcode_id and the spoolman columns on jobs', () => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'db.js'), path.join(scratchDir, 'db.js'));

    db = require(path.join(scratchDir, 'db.js'));

    const cols = db.prepare("PRAGMA table_info(jobs)").all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName.gcode_id.notnull).toBe(0);
    expect(byName.spoolman_spool_id).toBeDefined();
    expect(byName.spoolman_reported_at).toBeDefined();
    expect(cols).toHaveLength(11);
  });
});
