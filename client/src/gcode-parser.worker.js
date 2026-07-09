// Parses plain-text G-code into a flat Float32Array of extrusion-move vertex pairs (start/end
// per segment), off the main thread so large files don't freeze the UI. Travel (non-extruding)
// moves are discarded — the viewer only renders the printed material itself. Only G0/G1/G2/G3
// linear/arc moves are considered; arcs are approximated as a single segment from the current
// point to the arc's endpoint (no arc interpolation) — a reasonable simplification for a
// preview, not a print-accuracy tool.
//
// X/Y/Z positioning mode (G90/G91) and extruder mode (M82/M83) are independent axes in real
// G-code — PrusaSlicer's standard output is `G90` (absolute XYZ) followed by `M83` (relative
// E), so E deltas must be accumulated onto a running total even while X/Y/Z stay absolute.
// Tracking both under one flag misreads every E value as an absolute position instead of a
// small per-move delta, which makes the extrusion-vs-travel check below essentially random.

self.onmessage = (e) => {
  const text = e.data;
  const lines = text.split('\n');

  const extrude = [];

  let x = 0, y = 0, z = 0, e_ = 0;
  let relative = false;
  let eRelative = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const semi = line.indexOf(';');
    const cmd = (semi === -1 ? line : line.slice(0, semi)).trim();
    if (!cmd) continue;

    const first = cmd[0];
    if (first === 'M' || first === 'm') {
      const spaceIdx = cmd.indexOf(' ');
      const code = spaceIdx === -1 ? cmd.slice(1) : cmd.slice(1, spaceIdx);
      if (code === '83') eRelative = true;
      else if (code === '82') eRelative = false;
      continue;
    }
    if (first !== 'G' && first !== 'g') continue;

    const spaceIdx = cmd.indexOf(' ');
    const code = spaceIdx === -1 ? cmd.slice(1) : cmd.slice(1, spaceIdx);

    if (code === '91') { relative = true; continue; }
    if (code === '90') { relative = false; continue; }
    if (code === '92') {
      // Set Position — redefines the current coordinate for whichever axes are given,
      // independent of relative/absolute mode, without moving the toolhead. Slicers commonly
      // emit `G92 E0` every so often (even under M83/relative E) to reset the extruder's
      // position register; skipping this line entirely left the tracked E value stale, so the
      // next real extrusion move could compare against a much larger prior value and be
      // misclassified as a non-extruding travel.
      for (const p of cmd.split(/\s+/).slice(1)) {
        const axis = p[0];
        const value = parseFloat(p.slice(1));
        if (Number.isNaN(value)) continue;
        switch (axis) {
          case 'X': case 'x': x = value; break;
          case 'Y': case 'y': y = value; break;
          case 'Z': case 'z': z = value; break;
          case 'E': case 'e': e_ = value; break;
          default: break;
        }
      }
      continue;
    }
    if (code !== '0' && code !== '1' && code !== '2' && code !== '3') continue;

    const prevX = x, prevY = y, prevZ = z, prevE = e_;

    const parts = cmd.split(/\s+/).slice(1);
    let hasXY = false;
    for (const p of parts) {
      const axis = p[0];
      const value = parseFloat(p.slice(1));
      if (Number.isNaN(value)) continue;
      switch (axis) {
        case 'X': case 'x': x = relative ? x + value : value; hasXY = true; break;
        case 'Y': case 'y': y = relative ? y + value : value; hasXY = true; break;
        case 'Z': case 'z': z = relative ? z + value : value; break;
        case 'E': case 'e': e_ = eRelative ? e_ + value : value; break;
        default: break;
      }
    }

    if (!hasXY && z === prevZ) continue; // no actual movement (e.g. bare E retraction)

    if (e_ > prevE) {
      extrude.push(prevX, prevZ, prevY, x, z, y); // Y/Z swapped: three.js Y is "up"
    }
  }

  const extrudeArr = new Float32Array(extrude);
  self.postMessage({ extrude: extrudeArr }, [extrudeArr.buffer]);
};
