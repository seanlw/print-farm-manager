const pako = require('pako');
const { HeatshrinkDecoder } = require('heatshrink-ts');
const JSZip = require('jszip');

// bgcode block types (see https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md)
const BLOCK_TYPE_GCODE = 1;
const BLOCK_TYPE_PRINTER_METADATA = 3; // printer model, nozzle diameter, etc. -- INI key=value text
const BLOCK_TYPE_PRINT_METADATA = 4;   // this print job's own stats (time, filament used) -- INI key=value text
const BLOCK_TYPE_THUMBNAIL = 5;

const COMPRESSION_NONE = 0;
const COMPRESSION_DEFLATE = 1;
const COMPRESSION_HEATSHRINK_11 = 2;
const COMPRESSION_HEATSHRINK_12 = 3;

const GCODE_ENCODING_NONE = 0;
const GCODE_ENCODING_MEATPACK = 1;
const GCODE_ENCODING_MEATPACK_COMMENTS = 2;

class GcodeDecodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Upper bound on decompressed G-code text, enforced independent of what a block/entry claims
// its own size is. DEFLATE and Heatshrink's compression ratio scales with how repetitive the
// input is, not with the compressed size itself — a file only a few hundred KB on disk can
// expand to hundreds of MB to GB in memory in well under a second. Chosen generously above any
// real slicer's plain G-code output (the demo parts in this app are well under 1MB) while still
// bounding the worst case.
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

function tooLargeError(maxBytes) {
  return new GcodeDecodeError('DECOMPRESSED_TOO_LARGE', `Decompressed G-code exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`);
}

// MeatPack lookup table — see Prusa-Firmware-MeatPack's meatpack.cpp for the authoritative
// table this mirrors. Index 15 (0b1111) is reserved as the full-width-character escape flag,
// never a real output character.
const MEATPACK_TABLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ' ', '\n', 'G', 'X'];

// Feeds `payload` through pako's streaming Inflate a chunk at a time (rather than the one-shot
// `pako.inflateRaw`), so cumulative output can be checked — and decompression aborted — before
// the rest of a decompression bomb is processed, instead of only finding out how large the
// result is after it's already been fully inflated into memory. `raw: true` decodes headerless
// deflate (RFC 1951); `raw: false` expects a 2-byte zlib wrapper (RFC 1950) around the same
// deflate stream. Real bgcode files mix both under the same "Deflate" compression code: this
// repo's own PrusaSlicer-generated test fixture uses zlib-wrapped Deflate for its Print
// Metadata block despite the format only having one compression code for "Deflate", so the
// wrapper must be detected per-payload, not assumed from the compression code alone.
function inflateDeflateCapped(payload, maxBytes) {
  const inflator = new pako.Inflate({ raw: !isZlibWrapped(payload) });
  const chunks = [];
  let total = 0;
  let exceeded = false;
  inflator.onData = (chunk) => {
    if (exceeded) return;
    total += chunk.length;
    if (total > maxBytes) { exceeded = true; return; }
    chunks.push(Buffer.from(chunk));
  };

  const STEP = 65536;
  let offset = 0;
  do {
    const end = Math.min(offset + STEP, payload.length);
    inflator.push(payload.subarray(offset, end), end >= payload.length);
    offset = end;
  } while (offset < payload.length && !exceeded);

  if (exceeded) throw tooLargeError(maxBytes);
  if (inflator.err) throw new Error(inflator.msg || 'Deflate decompression failed');
  return Buffer.concat(chunks);
}

// zlib-wrapped deflate (RFC 1950) starts with a 2-byte header whose big-endian value is always
// a multiple of 31 by construction (a checksum built into the format itself) -- an extremely
// reliable way to tell it apart from headerless raw deflate, which has no such structure and
// essentially never coincides with a valid header by chance.
function isZlibWrapped(payload) {
  if (payload.length < 2) return false;
  const header = (payload[0] << 8) | payload[1];
  return (payload[0] & 0x0f) === 0x08 && header % 31 === 0;
}

// Same idea as inflateDeflateCapped, but for Heatshrink: feed the compressed payload to the decoder
// in small pieces and drain+check output after each one, rather than processing the whole
// payload in a single call (which would fully decompress a bomb before we ever get a chance to
// look at how much output it produced).
function heatshrinkInflateCapped(payload, windowBits, maxBytes) {
  const CHUNK = 4096;
  const decoder = new HeatshrinkDecoder(windowBits, 4, CHUNK);
  const chunks = [];
  let total = 0;

  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    decoder.process(payload.subarray(offset, Math.min(offset + CHUNK, payload.length)));
    const out = decoder.getOutput();
    if (out.length > 0) {
      total += out.length;
      if (total > maxBytes) throw tooLargeError(maxBytes);
      chunks.push(Buffer.from(out));
    }
  }
  return Buffer.concat(chunks);
}

function decompressBlock(payload, compression) {
  switch (compression) {
    case COMPRESSION_NONE:
      // No amplification risk here (the payload's own size is already bounded by the upload
      // size limit), but capped anyway for a single consistent ceiling on what downstream
      // processing (decodeMeatpack, encoding to text) ever has to handle.
      if (payload.length > MAX_DECOMPRESSED_BYTES) throw tooLargeError(MAX_DECOMPRESSED_BYTES);
      return payload;
    case COMPRESSION_DEFLATE:
      return inflateDeflateCapped(payload, MAX_DECOMPRESSED_BYTES);
    case COMPRESSION_HEATSHRINK_11:
    case COMPRESSION_HEATSHRINK_12: {
      const windowBits = compression === COMPRESSION_HEATSHRINK_11 ? 11 : 12;
      return heatshrinkInflateCapped(payload, windowBits, MAX_DECOMPRESSED_BYTES);
    }
    default:
      throw new GcodeDecodeError('UNSUPPORTED_COMPRESSION', `Unknown bgcode compression type ${compression}`);
  }
}

const MP_COMMAND_ENABLE_PACKING = 251;
const MP_COMMAND_DISABLE_PACKING = 250;
const MP_COMMAND_RESET_ALL = 249;
const MP_COMMAND_ENABLE_NO_SPACES = 247;
const MP_COMMAND_DISABLE_NO_SPACES = 246;

// G-code line-parameter letters that need a reinserted space in front of them when the
// encoder stripped whitespace (Flag_OmitWhitespaces / "no spaces" mode) — mirrors
// libbgcode's own is_gline_parameter list exactly.
const GLINE_PARAMETERS = new Set(['X', 'Y', 'Z', 'E', 'F', 'I', 'J', 'R', 'S', 'G', 'P', 'W', 'H', 'C', 'A']);

// Decodes a MeatPack-packed byte stream back into plain ASCII G-code text. Ported from
// libbgcode's own reference decoder (src/LibBGCode/binarize/meatpack.cpp `unbinarize()`).
// Packing toggles on and off via 0xFF 0xFF <command> sequences — comment lines are written
// raw, with packing disabled around them — and when "no spaces" mode was used to encode,
// whitespace between G-code parameters is stripped before packing and must be reinserted here.
function decodeMeatpack(buffer) {
  // Output is collected into bounded chunks rather than one array of single characters. A
  // plain JS array throws `RangeError: Invalid array length` once it grows past roughly 113
  // million elements (a real, verified V8 engine ceiling, well below the 200MB decompression
  // cap a packed stream can legitimately expand to after Deflate/Heatshrink) — a large but
  // entirely legitimate MeatPack-encoded file could hit that ceiling well before any actual
  // corruption or abuse. `lastChar` tracks the most recently emitted character directly, since
  // `emit()`'s logic below needs to peek at it without indexing into whichever chunk it landed in.
  const CHUNK_SIZE = 65536;
  const chunks = [];
  let chunk = [];
  let lastChar = null;
  let unbinarizing = false;
  let noSpaceEnabled = false;
  let cmdActive = false;
  let cmdCount = 0;
  let fullCharQueue = 0;
  let charBuf = null;
  let addSpace = false;

  function output(c) {
    chunk.push(c);
    lastChar = c;
    if (chunk.length >= CHUNK_SIZE) {
      chunks.push(chunk.join(''));
      chunk = [];
    }
  }

  function charFor(nibble) {
    return nibble === 0xB ? (noSpaceEnabled ? 'E' : ' ') : MEATPACK_TABLE[nibble];
  }

  function handleCommand(c) {
    switch (c) {
      case MP_COMMAND_ENABLE_PACKING: unbinarizing = true; break;
      case MP_COMMAND_DISABLE_PACKING: unbinarizing = false; break;
      case MP_COMMAND_RESET_ALL: unbinarizing = false; break;
      case MP_COMMAND_ENABLE_NO_SPACES: noSpaceEnabled = true; break;
      case MP_COMMAND_DISABLE_NO_SPACES: noSpaceEnabled = false; break;
      default: break;
    }
  }

  function emit(c) {
    // Reinserts the space between G-code parameters that "no spaces" mode stripped before
    // packing, and collapses accidental duplicate newlines — matching libbgcode's own
    // post-processing (needed because its GCodeReader can't parse unspaced parameters).
    const last = lastChar;
    let newLine = false;
    if (c === 'G' && (last === null || last === '\n')) {
      addSpace = true;
      newLine = true;
    } else if (c === '\n') {
      addSpace = false;
    }

    if (!newLine && addSpace && last !== ' ' && last !== null && GLINE_PARAMETERS.has(c)) {
      output(' ');
    }

    if (c !== '\n' || lastChar !== '\n') {
      output(c);
    }
  }

  function handleRxChar(c) {
    if (!unbinarizing) {
      emit(String.fromCharCode(c));
      return;
    }

    if (fullCharQueue > 0) {
      emit(String.fromCharCode(c));
      if (charBuf !== null) {
        emit(charBuf);
        charBuf = null;
      }
      fullCharQueue -= 1;
      return;
    }

    const low = c & 0xF;
    const high = (c >> 4) & 0xF;
    const firstIsFull = low === 0xF;
    const secondIsFull = high === 0xF;

    if (firstIsFull) {
      fullCharQueue += 1;
      if (secondIsFull) {
        fullCharQueue += 1;
      } else {
        charBuf = charFor(high);
      }
    } else {
      const firstChar = charFor(low);
      emit(firstChar);
      if (firstChar !== '\n') {
        if (secondIsFull) {
          fullCharQueue += 1;
        } else {
          emit(charFor(high));
        }
      }
    }
  }

  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === 0xFF) {
      if (cmdCount > 0) {
        cmdActive = true;
        cmdCount = 0;
      } else {
        cmdCount += 1;
      }
      continue;
    }
    if (cmdActive) {
      handleCommand(c);
      cmdActive = false;
      continue;
    }
    if (cmdCount > 0) {
      handleRxChar(0xFF);
      cmdCount = 0;
    }
    handleRxChar(c);
  }

  if (chunk.length > 0) chunks.push(chunk.join(''));
  return chunks.join('');
}

// Walks a bgcode buffer's block sequence (see
// https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md) and returns an array of
// { blockType, compression, gcodeEncoding, payload } entries, still compressed at this point.
// Shared by decodeBgcode (GCode blocks) and extractBgcodeMetadataText (Printer/Print Metadata
// blocks) so the header/checksum/param-skip parsing (the fiddly, easy-to-get-wrong part) is
// written and tested in exactly one place.
function parseBgcodeBlocks(buffer) {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 4) !== 'GCDE') {
    throw new GcodeDecodeError('INVALID_BGCODE', 'Not a valid bgcode file (missing GCDE magic header)');
  }

  let offset = 10; // magic(4) + version(4) + checksum type(2)
  const checksumType = buffer.readUInt16LE(8);
  const checksumSize = checksumType === 0 ? 0 : 4;
  const blocks = [];

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode file ends mid-block header');
    }
    const blockType = buffer.readUInt16LE(offset);
    const compression = buffer.readUInt16LE(offset + 2);
    const uncompressedSize = buffer.readUInt32LE(offset + 4);
    offset += 8;

    let compressedSize = uncompressedSize;
    if (compression !== COMPRESSION_NONE) {
      if (offset + 4 > buffer.length) {
        throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode file ends mid-block header');
      }
      compressedSize = buffer.readUInt32LE(offset);
      offset += 4;
    }

    // Block parameters: GCode blocks carry a 2-byte encoding field; Thumbnail blocks carry
    // format+width+height (6 bytes); every other block type (File/Slicer/Printer/Print
    // Metadata) carries a 2-byte encoding field too (0 = INI text, per the spec), which this
    // parser doesn't need to interpret since all of ours use plain INI text.
    let gcodeEncoding = GCODE_ENCODING_NONE;
    if (blockType === BLOCK_TYPE_GCODE) {
      if (offset + 2 > buffer.length) {
        throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode file ends mid-block parameters');
      }
      gcodeEncoding = buffer.readUInt16LE(offset);
      offset += 2;
    } else {
      offset += blockType === BLOCK_TYPE_THUMBNAIL ? 6 : 2;
    }

    if (offset + compressedSize > buffer.length) {
      throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode block data runs past end of file');
    }
    const payload = buffer.subarray(offset, offset + compressedSize);
    offset += compressedSize;
    offset += checksumSize;

    blocks.push({ blockType, compression, gcodeEncoding, payload });
  }

  return blocks;
}

// Returns the concatenated plain-text G-code from every GCode-type block. Non-GCode blocks
// (metadata, thumbnails) are skipped; see extractBgcodeMetadataText for the metadata blocks.
function decodeBgcode(buffer) {
  const blocks = parseBgcodeBlocks(buffer);
  let gcodeText = '';

  for (const { blockType, compression, gcodeEncoding, payload } of blocks) {
    if (blockType !== BLOCK_TYPE_GCODE) continue;

    const decompressed = decompressBlock(payload, compression);
    if (gcodeEncoding === GCODE_ENCODING_MEATPACK || gcodeEncoding === GCODE_ENCODING_MEATPACK_COMMENTS) {
      gcodeText += decodeMeatpack(decompressed);
    } else if (gcodeEncoding === GCODE_ENCODING_NONE) {
      gcodeText += decompressed.toString('utf8');
    } else {
      throw new GcodeDecodeError('UNSUPPORTED_ENCODING', `Unknown bgcode GCode block encoding ${gcodeEncoding}`);
    }
    // decompressBlock caps each individual block's own output, but a file with many blocks
    // that each stay just under that cap could still sum to an unbounded total — check the
    // running total too.
    if (gcodeText.length > MAX_DECOMPRESSED_BYTES) throw tooLargeError(MAX_DECOMPRESSED_BYTES);
  }

  return gcodeText;
}

// Returns the concatenated plain-text (INI-style `key=value` lines) content of a bgcode file's
// Printer Metadata and Print Metadata blocks. This is where PrusaSlicer's binary bgcode format
// actually stores filament-usage stats ("filament used [g]", "total filament used [g]", print
// time, etc.), verified empirically against this repo's real mini_cube_ps2.8.1.bgcode fixture,
// where decodeBgcode's GCode-block text contains zero occurrences of "filament used"; it's
// entirely in these metadata blocks instead, in a `key=value` shape (no leading `;`, no spaces
// around `=`) distinct from a plain .gcode file's `; key = value` comment style.
function extractBgcodeMetadataText(buffer) {
  const blocks = parseBgcodeBlocks(buffer);
  let text = '';

  for (const { blockType, compression, payload } of blocks) {
    if (blockType !== BLOCK_TYPE_PRINTER_METADATA && blockType !== BLOCK_TYPE_PRINT_METADATA) continue;

    text += decompressBlock(payload, compression).toString('utf8') + '\n';
    if (text.length > MAX_DECOMPRESSED_BYTES) throw tooLargeError(MAX_DECOMPRESSED_BYTES);
  }

  return text;
}

// Reads a zip entry's text via JSZip's streaming API instead of `.async('string')`, so
// cumulative output can be checked — and the read aborted — before a zip-bomb entry (a small
// compressed size that decompresses to a huge amount of text) is fully inflated into memory.
function readZipEntryTextCapped(zipObject, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let exceeded = false;
    const chunks = [];
    const stream = zipObject.internalStream('string');
    stream
      .on('data', (chunk) => {
        if (exceeded) return;
        total += chunk.length;
        if (total > maxBytes) {
          exceeded = true;
          stream.pause();
          reject(tooLargeError(maxBytes));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err) => { if (!exceeded) reject(err); })
      .on('end', () => { if (!exceeded) resolve(chunks.join('')); })
      .resume();
  });
}

// Extracts plain-text plate G-code from a .3mf project archive (a zip container).
// Bambu Studio/Bambu Suite store sliced plate G-code as plain text at Metadata/plate_*.gcode.
async function decode3mf(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new GcodeDecodeError('INVALID_3MF', 'Not a valid .3mf file (failed to open as a zip archive)');
  }

  const gcodeEntry = Object.keys(zip.files)
    .sort()
    .find((name) => /^Metadata\/plate_\d+\.gcode$/i.test(name));

  if (!gcodeEntry) {
    throw new GcodeDecodeError('NO_GCODE_IN_3MF', 'No plate G-code found inside this .3mf file');
  }

  return readZipEntryTextCapped(zip.files[gcodeEntry], MAX_DECOMPRESSED_BYTES);
}

// Parses slicer-authored filament-usage stats out of already-decoded text. Handles two real
// shapes: a plain .gcode/.3mf file's `; filament used [g] = N` comments (PrusaSlicer/OrcaSlicer
// convention, leading `;`, spaced `=`), and a bgcode file's Printer/Print Metadata block INI
// text (see extractBgcodeMetadataText), which states the same facts as bare `filament used
// [g]=N` lines with no leading `;` and no spaces. Prefers the LAST-occurring "total filament
// used" line -- real slicer/bgcode output only ever writes this after every tool/object/wipe-
// tower's usage has been tallied, making it the authoritative aggregate for multi-tool/
// multi-color prints -- and falls back to summing a non-"total" "filament used" line's
// comma-separated per-tool values (also taking the last such occurrence) when no total line
// exists at all. Returns { grams: null, mm: null }, never throws, when nothing recognizable is
// present (e.g. hand-written G-code with no slicer metadata) -- this must never break the
// /preview response or the 3D render path. The separator between the unit bracket and the
// number is tolerant (=, :, or bare whitespace) to opportunistically catch slicer variants
// beyond PrusaSlicer's exact format; only verified against real PrusaSlicer/OrcaSlicer/bgcode
// output, not Bambu Studio's differently-shaped native key.
function parseFilamentUsage(text) {
  return { grams: parseFilamentUnit(text, 'g'), mm: parseFilamentUnit(text, 'mm') };
}

function parseFilamentUnit(text, unit) {
  const total = lastRegexMatch(text, `^;?\\s*total filament used\\s*\\[${unit}\\]\\s*[:=]?\\s*([\\d.]+)`, 'im');
  if (total) {
    const v = parseFloat(total[1]);
    if (Number.isFinite(v)) return v;
  }
  // (?!total\s) excludes the total line itself and lines like
  // "; total filament used for wipe tower [g] = 0.00" / "total filament used for wipe tower
  // [g]=0.00" from this fallback.
  const perTool = lastRegexMatch(text, `^;?\\s*(?!total\\s)filament used\\s*\\[${unit}\\]\\s*[:=]?\\s*([\\d.,\\s]+)$`, 'im');
  return perTool ? sumCommaList(perTool[1]) : null;
}

// Parses the slicer's own "estimated printing time (normal mode)" line (same two comment
// shapes as parseFilamentUsage: a plain .gcode's spaced, semicolon-prefixed comment, or a
// bgcode metadata block's bare key=value line) into whole seconds. "Silent mode" is a distinct,
// typically slower estimate for quieter fan profiles and is intentionally not used here.
// Returns null, never throws, when no such line is present.
function parsePrintTime(text) {
  const match = lastRegexMatch(text, `^;?\\s*estimated printing time \\(normal mode\\)\\s*[:=]?\\s*(.+)$`, 'im');
  return match ? parseDurationToSeconds(match[1].trim()) : null;
}

// Parses a slicer-style duration like "3m 41s", "1h 5m", or "2h 30m 10s" into whole seconds.
function parseDurationToSeconds(raw) {
  let total = 0;
  let found = false;
  let m = raw.match(/(\d+)h/); if (m) { total += parseInt(m[1], 10) * 3600; found = true; }
  m = raw.match(/(\d+)m/); if (m) { total += parseInt(m[1], 10) * 60; found = true; }
  m = raw.match(/(\d+)s/); if (m) { total += parseInt(m[1], 10); found = true; }
  return found ? total : null;
}

// Builds a fresh RegExp per call rather than a shared module-level one -- a `g`-flagged
// RegExp carries mutable `lastIndex` state across `.exec()` calls, and decode3mf's async path
// means concurrent preview requests can genuinely interleave within this process.
function lastRegexMatch(text, source, flags) {
  const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m;
  return last;
}

function sumCommaList(raw) {
  const nums = raw.split(',').map((s) => parseFloat(s.trim())).filter(Number.isFinite);
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round(sum * 1000) / 1000; // avoid float artifacts from summing (e.g. 5.2+3.1+2.0)
}

module.exports = { decodeBgcode, decode3mf, extractBgcodeMetadataText, GcodeDecodeError, parseFilamentUsage, parsePrintTime };
