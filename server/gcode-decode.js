const pako = require('pako');
const { HeatshrinkDecoder } = require('heatshrink-ts');
const JSZip = require('jszip');

// bgcode block types (see https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md)
const BLOCK_TYPE_GCODE = 1;

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

// MeatPack lookup table — see Prusa-Firmware-MeatPack's meatpack.cpp for the authoritative
// table this mirrors. Index 15 (0b1111) is reserved as the full-width-character escape flag,
// never a real output character.
const MEATPACK_TABLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ' ', '\n', 'G', 'X'];

function decompressBlock(payload, compression, uncompressedSize) {
  switch (compression) {
    case COMPRESSION_NONE:
      return payload;
    case COMPRESSION_DEFLATE:
      return Buffer.from(pako.inflateRaw(payload));
    case COMPRESSION_HEATSHRINK_11:
    case COMPRESSION_HEATSHRINK_12: {
      const windowBits = compression === COMPRESSION_HEATSHRINK_11 ? 11 : 12;
      const decoder = new HeatshrinkDecoder(windowBits, 4, Math.max(uncompressedSize, 64));
      decoder.process(payload);
      return Buffer.from(decoder.getOutput());
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
  const out = [];
  let unbinarizing = false;
  let noSpaceEnabled = false;
  let cmdActive = false;
  let cmdCount = 0;
  let fullCharQueue = 0;
  let charBuf = null;
  let addSpace = false;

  function output(c) {
    out.push(c);
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
    const last = out.length > 0 ? out[out.length - 1] : null;
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

    if (c !== '\n' || out.length === 0 || out[out.length - 1] !== '\n') {
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

  return out.join('');
}

// Parses a bgcode buffer (see https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md)
// and returns the concatenated plain-text G-code from every GCode-type block. Non-GCode blocks
// (metadata, thumbnails) are skipped.
function decodeBgcode(buffer) {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 4) !== 'GCDE') {
    throw new GcodeDecodeError('INVALID_BGCODE', 'Not a valid bgcode file (missing GCDE magic header)');
  }

  let offset = 10; // magic(4) + version(4) + checksum type(2)
  const checksumType = buffer.readUInt16LE(8);
  const checksumSize = checksumType === 0 ? 0 : 4;

  let gcodeText = '';

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

    // Block parameters
    let gcodeEncoding = GCODE_ENCODING_NONE;
    if (blockType === BLOCK_TYPE_GCODE) {
      if (offset + 2 > buffer.length) {
        throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode file ends mid-block parameters');
      }
      gcodeEncoding = buffer.readUInt16LE(offset);
      offset += 2;
    } else {
      // Metadata blocks (encoding, 2 bytes) / Thumbnail blocks (format+width+height, 6 bytes) —
      // skip their parameter bytes; we don't need their content for this feature.
      offset += blockType === 5 /* thumbnail */ ? 6 : 2;
    }

    if (offset + compressedSize > buffer.length) {
      throw new GcodeDecodeError('TRUNCATED_BLOCK', 'bgcode block data runs past end of file');
    }
    const payload = buffer.subarray(offset, offset + compressedSize);
    offset += compressedSize;
    offset += checksumSize;

    if (blockType === BLOCK_TYPE_GCODE) {
      const decompressed = decompressBlock(payload, compression, uncompressedSize);
      if (gcodeEncoding === GCODE_ENCODING_MEATPACK || gcodeEncoding === GCODE_ENCODING_MEATPACK_COMMENTS) {
        gcodeText += decodeMeatpack(decompressed);
      } else if (gcodeEncoding === GCODE_ENCODING_NONE) {
        gcodeText += decompressed.toString('utf8');
      } else {
        throw new GcodeDecodeError('UNSUPPORTED_ENCODING', `Unknown bgcode GCode block encoding ${gcodeEncoding}`);
      }
    }
  }

  return gcodeText;
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

  return zip.files[gcodeEntry].async('string');
}

module.exports = { decodeBgcode, decode3mf, GcodeDecodeError };
