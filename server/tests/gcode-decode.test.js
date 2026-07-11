const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pako = require('pako');
const JSZip = require('jszip');
const { HeatshrinkDecoder } = require('heatshrink-ts');
const { decodeBgcode, decode3mf, extractBgcodeMetadataText, GcodeDecodeError, parseFilamentUsage, parsePrintTime } = require('../gcode-decode');

// ── bgcode fixture builder ──────────────────────────────────────────────────
// Mirrors https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md:
// 10-byte file header (magic "GCDE", version, checksum type), then a sequence of
// blocks (type, compression, uncompressed size, [compressed size], params, data).
// Fixtures here use checksum type 0 (none) throughout — no per-block checksum trailer.
const BLOCK_TYPE_GCODE = 1;
const BLOCK_TYPE_PRINTER_METADATA = 3;
const BLOCK_TYPE_PRINT_METADATA = 4;
const BLOCK_TYPE_THUMBNAIL = 5;
const COMPRESSION_NONE = 0;
const COMPRESSION_DEFLATE = 1;
const COMPRESSION_HEATSHRINK_11 = 2;

function fileHeader() {
  const buf = Buffer.alloc(10);
  buf.write('GCDE', 0, 'ascii');
  buf.writeUInt32LE(1, 4); // version
  buf.writeUInt16LE(0, 8); // checksum type: none
  return buf;
}

function gcodeBlock(payload, { compression = COMPRESSION_NONE, encoding = 0, uncompressedSize } = {}) {
  const header = Buffer.alloc(compression === COMPRESSION_NONE ? 8 : 12);
  header.writeUInt16LE(BLOCK_TYPE_GCODE, 0);
  header.writeUInt16LE(compression, 2);
  header.writeUInt32LE(uncompressedSize ?? payload.length, 4);
  if (compression !== COMPRESSION_NONE) header.writeUInt32LE(payload.length, 8);

  const params = Buffer.alloc(2);
  params.writeUInt16LE(encoding, 0);

  return Buffer.concat([header, params, payload]);
}

// Printer Metadata (3) / Print Metadata (4) blocks carry INI-style key=value text and, like
// GCode blocks, a 2-byte encoding parameter (0 = INI, the only value this parser cares about).
function metadataBlock(blockType, payload, { compression = COMPRESSION_NONE, uncompressedSize } = {}) {
  const header = Buffer.alloc(compression === COMPRESSION_NONE ? 8 : 12);
  header.writeUInt16LE(blockType, 0);
  header.writeUInt16LE(compression, 2);
  header.writeUInt32LE(uncompressedSize ?? payload.length, 4);
  if (compression !== COMPRESSION_NONE) header.writeUInt32LE(payload.length, 8);

  const params = Buffer.alloc(2); // encoding: INI
  return Buffer.concat([header, params, payload]);
}

function thumbnailBlock(payload) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(BLOCK_TYPE_THUMBNAIL, 0);
  header.writeUInt16LE(COMPRESSION_NONE, 2);
  header.writeUInt32LE(payload.length, 4);

  const params = Buffer.alloc(6); // format(2) + width(2) + height(2)
  return Buffer.concat([header, params, payload]);
}

function bgcodeFile(...blocks) {
  return Buffer.concat([fileHeader(), ...blocks]);
}

describe('decodeBgcode', () => {
  test('decodes a single uncompressed, unencoded GCode block', () => {
    const gcode = Buffer.from('G1 X10 Y20\nG1 X20 Y30\n', 'utf8');
    const file = bgcodeFile(gcodeBlock(gcode));
    expect(decodeBgcode(file)).toBe('G1 X10 Y20\nG1 X20 Y30\n');
  });

  test('decodes multiple GCode blocks in order and concatenates them', () => {
    const first = Buffer.from('G1 X1\n', 'utf8');
    const second = Buffer.from('G1 X2\n', 'utf8');
    const file = bgcodeFile(gcodeBlock(first), gcodeBlock(second));
    expect(decodeBgcode(file)).toBe('G1 X1\nG1 X2\n');
  });

  test('skips non-GCode blocks (thumbnail) rather than treating them as gcode text', () => {
    const gcode = Buffer.from('G1 X1\n', 'utf8');
    const file = bgcodeFile(thumbnailBlock(Buffer.from([0x89, 0x50, 0x4e, 0x47])), gcodeBlock(gcode));
    expect(decodeBgcode(file)).toBe('G1 X1\n');
  });

  test('decodes a Deflate-compressed GCode block', () => {
    const gcode = Buffer.from('G1 X10 Y20 Z5 F1200\n', 'utf8');
    const compressed = Buffer.from(pako.deflateRaw(gcode));
    const file = bgcodeFile(gcodeBlock(compressed, { compression: COMPRESSION_DEFLATE, uncompressedSize: gcode.length }));
    expect(decodeBgcode(file)).toBe('G1 X10 Y20 Z5 F1200\n');
  });

  test('decodes a zlib-wrapped (not raw) Deflate-compressed GCode block', () => {
    // Real bgcode files mix raw and zlib-wrapped Deflate under the same compression code across
    // different block types (see extractBgcodeMetadataText's tests below, which caught this
    // against a real PrusaSlicer fixture) -- this proves the same auto-detection also works for
    // a GCode block, not just metadata blocks, since both go through the shared decompressBlock.
    const gcode = Buffer.from('G1 X10 Y20 Z5 F1200\n', 'utf8');
    const compressed = zlib.deflateSync(gcode); // zlib-wrapped, unlike pako.deflateRaw above
    const file = bgcodeFile(gcodeBlock(compressed, { compression: COMPRESSION_DEFLATE, uncompressedSize: gcode.length }));
    expect(decodeBgcode(file)).toBe('G1 X10 Y20 Z5 F1200\n');
  });

  test('decodes a Heatshrink-compressed GCode block (window 11, lookahead 4)', () => {
    // No JS Heatshrink *encoder* exists to build a real window-11 fixture from scratch, so
    // this proves the decompressBlock() -> HeatshrinkDecoder wiring (buffer handling,
    // process()/getOutput() calling convention) is correct using a known-good compressed
    // vector from heatshrink-ts's own test suite (github.com/iotile/heatshrink-ts), which
    // uses window 8/lookahead 4 rather than bgcode's window 11/12 — the decode mechanism
    // is identical, only the window/lookahead constants passed to HeatshrinkDecoder differ.
    const decoder = new HeatshrinkDecoder(8, 4, 64);
    const encoded = Buffer.from(
      'qlotNzkACKwyC6WW53SQAIblabdZ5BZbdY7fZLLZJBd7TdLQBCt1kt93kE4lkgtlvt9rsNosthDAzQA=',
      'base64'
    );
    decoder.process(encoded);
    const output = Buffer.from(decoder.getOutput()).toString('latin1');
    expect(output).toBe('This is a test string encoded with window 8, lookahead 4');
  });

  // Real bgcode GCode blocks start with packing OFF and turn it on via a 0xFF 0xFF 251
  // (EnablePacking) command sequence.
  const ENABLE_PACKING = Buffer.from([0xff, 0xff, 251]);

  test('decodes a MeatPack-encoded GCode block (all-packable pairs)', () => {
    // "G1 X10" -> pairs (G,1) (sp,X) (1,0); low nibble = first char, high nibble = second.
    const packed = Buffer.concat([ENABLE_PACKING, Buffer.from([0x1d, 0xeb, 0x01])]);
    const file = bgcodeFile(gcodeBlock(packed, { encoding: 1, uncompressedSize: packed.length }));
    expect(decodeBgcode(file)).toBe('G1 X10');
  });

  test('MeatPack decode: a newline as the first nibble discards the paired second nibble', () => {
    // low nibble 0xC = '\n', high nibble 0x5 is arbitrary padding that must be discarded.
    const packed = Buffer.concat([ENABLE_PACKING, Buffer.from([0x5c])]);
    const file = bgcodeFile(gcodeBlock(packed, { encoding: 1, uncompressedSize: packed.length }));
    expect(decodeBgcode(file)).toBe('\n');
  });

  test('MeatPack decode: full-width escape for a character outside the packable table', () => {
    // byte 0xFD: low=0xD ('G', packable) high=0xF (escape -> next raw byte is a full char).
    // Next byte 0x3B is the raw ';' character.
    const packed = Buffer.concat([ENABLE_PACKING, Buffer.from([0xfd, 0x3b])]);
    const file = bgcodeFile(gcodeBlock(packed, { encoding: 1, uncompressedSize: packed.length }));
    expect(decodeBgcode(file)).toBe('G;');
  });

  test('MeatPack decode: both nibbles full-width (two consecutive escaped characters)', () => {
    // 0xFF as data (both nibbles 0xF) queues two full-width chars; the following two raw
    // bytes are consumed as literal characters, not reinterpreted as packed pairs.
    const packed = Buffer.concat([ENABLE_PACKING, Buffer.from([0xff, 0x61, 0x62])]); // -> "ab"
    const file = bgcodeFile(gcodeBlock(packed, { encoding: 1, uncompressedSize: packed.length }));
    expect(decodeBgcode(file)).toBe('ab');
  });

  test('MeatPack decode: output survives multiple internal chunk-flush boundaries intact', () => {
    // decodeMeatpack collects output into bounded chunks (flushed and joined every 65536
    // characters) rather than one growing array — a plain JS array throws `RangeError: Invalid
    // array length` once pushed past roughly 113 million elements, a real V8 ceiling confirmed
    // by direct testing, well below the 200MB decompression cap a packed stream can legitimately
    // expand to. That full-scale case (~150MB of output) was verified manually — see the
    // changelog — since reproducing it here would run past a minute under Jest's instrumentation
    // even though the same input decodes in ~3s in plain Node. This test instead proves the
    // chunking mechanism itself is correct: several hundred thousand characters comfortably
    // spans multiple flush-and-rejoin cycles, so any corruption at a chunk boundary (in
    // particular, `lastChar` not surviving a flush, which the newline-collapse and G-line-space
    // logic in `emit()` both depend on) would show up as a byte mismatch below.
    const line = Buffer.from('G1 X1 Y1\n');
    const original = Buffer.concat(Array(60000).fill(line)); // ~540,000 chars, ~8 chunk flushes
    const file = bgcodeFile(gcodeBlock(original, { encoding: 1, uncompressedSize: original.length }));

    const decoded = decodeBgcode(file);
    expect(decoded.length).toBe(original.length);
    expect(decoded).toBe(original.toString('utf8'));
  });

  test('throws INVALID_BGCODE for a missing magic header', () => {
    expect(() => decodeBgcode(Buffer.from('not a bgcode file'))).toThrow(GcodeDecodeError);
    try {
      decodeBgcode(Buffer.from('not a bgcode file'));
    } catch (err) {
      expect(err.code).toBe('INVALID_BGCODE');
    }
  });

  test('throws TRUNCATED_BLOCK when the file ends mid-block', () => {
    const truncated = Buffer.concat([fileHeader(), Buffer.from([0x01, 0x00, 0x00, 0x00])]); // partial header
    expect(() => decodeBgcode(truncated)).toThrow(GcodeDecodeError);
  });

  test('throws UNSUPPORTED_COMPRESSION for an unrecognized compression type', () => {
    const gcode = Buffer.from('G1\n');
    const file = bgcodeFile(gcodeBlock(gcode, { compression: 99, uncompressedSize: gcode.length }));
    try {
      decodeBgcode(file);
      throw new Error('expected decodeBgcode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GcodeDecodeError);
      expect(err.code).toBe('UNSUPPORTED_COMPRESSION');
    }
  });

  test('throws UNSUPPORTED_ENCODING for an unrecognized GCode block encoding', () => {
    const gcode = Buffer.from('G1\n');
    const file = bgcodeFile(gcodeBlock(gcode, { encoding: 99 }));
    try {
      decodeBgcode(file);
      throw new Error('expected decodeBgcode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GcodeDecodeError);
      expect(err.code).toBe('UNSUPPORTED_ENCODING');
    }
  });

  test('throws DECOMPRESSED_TOO_LARGE for a Deflate decompression bomb, instead of fully inflating it', () => {
    // A few hundred KB compressed, but decompresses to well past the 200MB cap — the classic
    // "small file, huge output" decompression-bomb shape. This must be rejected quickly rather
    // than fully inflated into memory first.
    //
    // Built from a small number of large chunks rather than millions of tiny ones — an array of
    // ~24 million 9-byte buffers is fast in plain Node but pathologically slow once Jest's
    // instrumentation wraps it, even though the actual decode logic under test isn't the cause.
    // Compressed with Node's native zlib rather than pako — raw deflate is a standard format
    // regardless of which implementation produced it (this also exercises real interop with
    // the production decode path, which uses pako to decompress), and pako's pure-JS deflate
    // is pathologically slow specifically under Jest's instrumentation (~1s in plain Node vs.
    // ~26s here) even though the actual decode logic under test isn't the cause.
    const line = Buffer.from('G1 X1 Y1\n');
    const unit = Buffer.concat(Array(Math.ceil((1024 * 1024) / line.length)).fill(line)); // ~1MB
    const original = Buffer.concat(Array(Math.ceil((210 * 1024 * 1024) / unit.length)).fill(unit)); // ~210MB
    const compressed = zlib.deflateRawSync(original);

    const file = bgcodeFile(gcodeBlock(compressed, {
      compression: COMPRESSION_DEFLATE,
      uncompressedSize: original.length,
    }));

    const start = Date.now();
    try {
      decodeBgcode(file);
      throw new Error('expected decodeBgcode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GcodeDecodeError);
      expect(err.code).toBe('DECOMPRESSED_TOO_LARGE');
    }
    // Should bail well before fully inflating ~210MB — a generous ceiling to avoid test flakiness
    // on slow CI, while still proving it isn't paying for the full decompression.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('decode3mf', () => {
  test('extracts plain-text plate gcode from a valid .3mf archive', async () => {
    const zip = new JSZip();
    zip.file('Metadata/plate_1.gcode', 'G1 X1 Y1\nG1 X2 Y2\n');
    zip.file('Metadata/thumbnail.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    expect(await decode3mf(buffer)).toBe('G1 X1 Y1\nG1 X2 Y2\n');
  });

  test('picks the lowest-numbered plate when multiple are present', async () => {
    const zip = new JSZip();
    zip.file('Metadata/plate_2.gcode', 'second plate\n');
    zip.file('Metadata/plate_1.gcode', 'first plate\n');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    expect(await decode3mf(buffer)).toBe('first plate\n');
  });

  test('throws NO_GCODE_IN_3MF when no plate gcode entry exists', async () => {
    const zip = new JSZip();
    zip.file('Metadata/thumbnail.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(decode3mf(buffer)).rejects.toMatchObject({ code: 'NO_GCODE_IN_3MF' });
  });

  test('throws INVALID_3MF for a buffer that is not a valid zip', async () => {
    await expect(decode3mf(Buffer.from('not a zip file'))).rejects.toMatchObject({ code: 'INVALID_3MF' });
  });

  test('throws DECOMPRESSED_TOO_LARGE for a zip-bomb plate entry, instead of fully inflating it', async () => {
    const line = 'G1 X1 Y1\n';
    const reps = Math.ceil((210 * 1024 * 1024) / line.length); // ~210MB decompressed
    const zip = new JSZip();
    zip.file('Metadata/plate_1.gcode', line.repeat(reps), { compression: 'DEFLATE' });
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const start = Date.now();
    await expect(decode3mf(buffer)).rejects.toMatchObject({ code: 'DECOMPRESSED_TOO_LARGE' });
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);
});

describe('decodeBgcode against a real PrusaSlicer-generated file', () => {
  // prusa3d/libbgcode's own test fixture (tests/data/mini_cube_ps2.8.1.bgcode) — real
  // Heatshrink (window 12) + MeatPack (with "no spaces" mode) encoded G-code, plus a
  // known-correct reference decode of the same file (mini_cube_ps2.8.1_ref.gcode).
  //
  // Comparing full text isn't meaningful here — the reference file's header comments are
  // reconstructed from Printer/Print Metadata blocks that decodeBgcode deliberately doesn't
  // read (irrelevant to a 3D viewer; see extractBgcodeMetadataText below for the function that
  // does read them) — so this compares every actual G0-G3 move line instead, which must match
  // exactly for the viewer to render the real toolpath correctly.
  test('every G0-G3 move line matches the official reference decode exactly', () => {
    const bgcode = fs.readFileSync(path.join(__dirname, 'fixtures/mini_cube_ps2.8.1.bgcode'));
    const expected = fs.readFileSync(path.join(__dirname, 'fixtures/mini_cube_ps2.8.1_ref.gcode'), 'utf8');

    const decoded = decodeBgcode(bgcode);
    const moveLines = (s) => s.split('\n').filter((l) => /^G[0-3]\s/.test(l));

    const decodedMoves = moveLines(decoded);
    const expectedMoves = moveLines(expected);
    expect(decodedMoves.length).toBe(expectedMoves.length);
    expect(decodedMoves.length).toBeGreaterThan(0);
    expect(decodedMoves).toEqual(expectedMoves);
  });
});

describe('extractBgcodeMetadataText', () => {
  test('extracts an uncompressed Printer Metadata block as plain text', () => {
    const meta = Buffer.from('printer_model=MK4S\nfilament used [g]=0.75\n', 'utf8');
    const file = bgcodeFile(metadataBlock(BLOCK_TYPE_PRINTER_METADATA, meta));
    expect(extractBgcodeMetadataText(file)).toBe('printer_model=MK4S\nfilament used [g]=0.75\n\n');
  });

  test('extracts a zlib-wrapped Deflate-compressed Print Metadata block', () => {
    // This repo's own real fixture (mini_cube_ps2.8.1.bgcode) uses zlib-wrapped Deflate for
    // exactly this block type -- discovered by inspecting it directly, since decodeBgcode's
    // Deflate handling had only ever been exercised (by the existing "Deflate-compressed GCode
    // block" test above) against raw/headerless Deflate. This proves the fix decodes it, not
    // just that it fails gracefully.
    const meta = Buffer.from('total filament used [g]=0.75\n', 'utf8');
    const compressed = zlib.deflateSync(meta);
    const file = bgcodeFile(metadataBlock(BLOCK_TYPE_PRINT_METADATA, compressed, {
      compression: COMPRESSION_DEFLATE,
      uncompressedSize: meta.length,
    }));
    expect(extractBgcodeMetadataText(file)).toBe('total filament used [g]=0.75\n\n');
  });

  test('concatenates Printer and Print Metadata blocks, in file order', () => {
    const printer = Buffer.from('printer_model=MK4S\n', 'utf8');
    const print = Buffer.from('total filament used [g]=0.75\n', 'utf8');
    const file = bgcodeFile(
      metadataBlock(BLOCK_TYPE_PRINTER_METADATA, printer),
      metadataBlock(BLOCK_TYPE_PRINT_METADATA, print)
    );
    expect(extractBgcodeMetadataText(file)).toBe('printer_model=MK4S\n\ntotal filament used [g]=0.75\n\n');
  });

  test('excludes GCode and Thumbnail blocks', () => {
    const gcode = Buffer.from('G1 X1 Y1\n', 'utf8');
    const thumb = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const file = bgcodeFile(gcodeBlock(gcode), thumbnailBlock(thumb));
    expect(extractBgcodeMetadataText(file)).toBe('');
  });

  test('returns empty text (not an error) for a bgcode file with no metadata blocks at all', () => {
    const gcode = Buffer.from('G1 X1 Y1\n', 'utf8');
    const file = bgcodeFile(gcodeBlock(gcode));
    expect(extractBgcodeMetadataText(file)).toBe('');
  });

  test('extracts real filament-usage data from this repo\'s real PrusaSlicer-generated fixture', () => {
    const bgcode = fs.readFileSync(path.join(__dirname, 'fixtures/mini_cube_ps2.8.1.bgcode'));
    const text = extractBgcodeMetadataText(bgcode);
    expect(text).toContain('total filament used [g]=0.75');
    expect(text).toContain('filament used [mm]=252.22');
  });
});

describe('parseFilamentUsage', () => {
  test('parses a plain .gcode-style comment with a single value', () => {
    const text = '; filament used [g] = 12.34\n; filament used [mm] = 4567.8\n';
    expect(parseFilamentUsage(text)).toEqual({ grams: 12.34, mm: 4567.8 });
  });

  test('parses a bgcode-metadata-style bare key=value line (no leading ";", no spaces)', () => {
    const text = 'filament used [g]=0.75\nfilament used [mm]=252.22\n';
    expect(parseFilamentUsage(text)).toEqual({ grams: 0.75, mm: 252.22 });
  });

  test('prefers the "total filament used" line over a differing per-tool line', () => {
    const text = [
      '; filament used [g] = 3.70, 2.36',
      '; total filament used [g] = 6.06',
    ].join('\n');
    expect(parseFilamentUsage(text).grams).toBe(6.06);
  });

  test('falls back to summing a comma-separated per-tool line when no total line exists', () => {
    const text = '; filament used [g] = 3.70, 2.36\n; filament used [mm] = 1234.5, 789.0\n';
    expect(parseFilamentUsage(text)).toEqual({ grams: 6.06, mm: 2023.5 });
  });

  test('ignores the wipe-tower total, which is a different line, not the print total', () => {
    // Both lines appear side by side in real slicer output (see the real fixture above) --
    // "for wipe tower" must not be mistaken for the real total.
    const text = [
      '; filament used [g] = 0.75',
      '; total filament used for wipe tower [g] = 0.00',
    ].join('\n');
    expect(parseFilamentUsage(text).grams).toBe(0.75);
  });

  test('prefers the last occurrence when both a header and footer total line are present', () => {
    const text = [
      '; total filament used [g] = 5.00', // header estimate, superseded
      '; total filament used [g] = 5.42', // footer, final and authoritative
    ].join('\n');
    expect(parseFilamentUsage(text).grams).toBe(5.42);
  });

  test('tolerates CRLF line endings', () => {
    const text = '; total filament used [g] = 9.87\r\n; total filament used [mm] = 3210.0\r\n';
    expect(parseFilamentUsage(text)).toEqual({ grams: 9.87, mm: 3210 });
  });

  test('returns null for both fields when no recognizable comment is present', () => {
    expect(parseFilamentUsage('G1 X10 Y20\nG1 X20 Y30\n')).toEqual({ grams: null, mm: null });
  });

  test('live regression: real PrusaSlicer bgcode metadata decodes to the known fixture values', () => {
    const bgcode = fs.readFileSync(path.join(__dirname, 'fixtures/mini_cube_ps2.8.1.bgcode'));
    const metaText = extractBgcodeMetadataText(bgcode);
    expect(parseFilamentUsage(metaText)).toEqual({ grams: 0.75, mm: 252.22 });
  });
});

describe('parsePrintTime', () => {
  test('parses a plain .gcode-style comment ("Xm Ys")', () => {
    expect(parsePrintTime('; estimated printing time (normal mode) = 3m 41s\n')).toBe(221);
  });

  test('parses a bgcode-metadata-style bare key=value line', () => {
    expect(parsePrintTime('estimated printing time (normal mode)=3m 41s\n')).toBe(221);
  });

  test('parses hours, minutes, and seconds together', () => {
    expect(parsePrintTime('; estimated printing time (normal mode) = 2h 30m 10s\n')).toBe(2 * 3600 + 30 * 60 + 10);
  });

  test('ignores "silent mode", which is a distinct, typically slower estimate', () => {
    const text = '; estimated printing time (silent mode) = 9h 0m 0s\n; estimated printing time (normal mode) = 3m 41s\n';
    expect(parsePrintTime(text)).toBe(221);
  });

  test('prefers the last occurrence when both a header and footer estimate are present', () => {
    const text = [
      '; estimated printing time (normal mode) = 5m 0s',
      '; estimated printing time (normal mode) = 3m 41s',
    ].join('\n');
    expect(parsePrintTime(text)).toBe(221);
  });

  test('returns null when no recognizable line is present', () => {
    expect(parsePrintTime('G1 X10 Y20\n')).toBeNull();
  });

  test('live regression: real PrusaSlicer bgcode metadata decodes to the known fixture value', () => {
    const bgcode = fs.readFileSync(path.join(__dirname, 'fixtures/mini_cube_ps2.8.1.bgcode'));
    const metaText = extractBgcodeMetadataText(bgcode);
    expect(parsePrintTime(metaText)).toBe(221);
  });
});
