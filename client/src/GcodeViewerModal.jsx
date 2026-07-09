import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const WARN_BYTES = 20 * 1024 * 1024;  // 20 MB
const BLOCK_BYTES = 100 * 1024 * 1024; // 100 MB

export default function GcodeViewerModal({ gcode, partName, onClose }) {
  const mountRef = useRef(null);
  const navRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | error | ready | blocked
  const [error, setError] = useState(null);
  const [proceedAnyway, setProceedAnyway] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tooLarge = gcode.file_size != null && gcode.file_size > BLOCK_BYTES && !proceedAnyway;
  const showWarning = gcode.file_size != null && gcode.file_size > WARN_BYTES && gcode.file_size <= BLOCK_BYTES;

  useEffect(() => {
    if (tooLarge) {
      setStatus('blocked');
      return;
    }

    let cancelled = false;
    let worker;
    let renderer, scene, camera, controls, animId;
    const mount = mountRef.current;

    setStatus('loading');
    setError(null);

    fetch(`/api/gcodes/${gcode.id}/preview`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to load G-code (${res.status})`);
        }
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        worker = new Worker(new URL('./gcode-parser.worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          if (cancelled) return;
          const { extrude } = e.data;
          setStatus('ready');
          requestAnimationFrame(() => {
            if (cancelled || !mountRef.current) return;
            const cleanup = renderScene(mountRef.current, extrude);
            renderer = cleanup.renderer;
            scene = cleanup.scene;
            camera = cleanup.camera;
            controls = cleanup.controls;
            animId = cleanup.animId;
            navRef.current = {
              resetView: cleanup.resetView, goIso: cleanup.goIso,
              zoomBy: cleanup.zoomBy, rotateBy: cleanup.rotateBy,
            };
          });
          worker.terminate();
        };
        worker.postMessage(text);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(err.message);
      });

    return () => {
      cancelled = true;
      navRef.current = null;
      if (worker) worker.terminate();
      if (animId) cancelAnimationFrame(animId);
      if (controls) controls.dispose();
      if (scene) {
        // WebGLRenderer.dispose() only frees the renderer's own internal state (program
        // cache, render lists, etc.) — it does not free the geometries/materials attached to
        // objects in the scene graph. Without this, every open of the viewer (a part can be
        // reopened repeatedly, or a project can have many parts) leaks the GPU buffers backing
        // the fat-line geometry and material.
        scene.traverse((obj) => {
          obj.geometry?.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m) => m?.dispose());
        });
      }
      if (renderer) {
        renderer.dispose();
        if (mount && renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcode.id, tooLarge]);

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        backdropFilter: 'blur(3px)',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`3D preview — ${partName} (${gcode.filename})`}
        style={{
          background: '#1e2433',
          border: '1px solid #334155',
          borderRadius: 10,
          padding: 20,
          width: '90vw', height: '80vh',
          maxWidth: 1400,
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          animation: 'modalIn 0.15s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>3D Preview — {partName} ({gcode.filename})</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}
          >×</button>
        </div>

        {showWarning && status === 'ready' && (
          <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
            This is a large file ({formatBytes(gcode.file_size)}) — rendering may be slow on lower-end hardware.
          </div>
        )}

        <div style={{ flex: 1, position: 'relative', borderRadius: 6, overflow: 'hidden', background: '#0a0f1a' }}>
          {status === 'loading' && (
            <div style={centeredStyle}>Loading preview…</div>
          )}
          {status === 'error' && (
            <div style={{ ...centeredStyle, color: '#ef4444', textAlign: 'center', padding: 20 }}>
              Couldn't load 3D preview.<br />{error}
            </div>
          )}
          {status === 'blocked' && (
            <div style={{ ...centeredStyle, color: '#94a3b8', textAlign: 'center', padding: 20 }}>
              This file is {formatBytes(gcode.file_size)} — too large to preview safely in-browser.
              <div style={{ marginTop: 12 }}>
                <button
                  onClick={() => setProceedAnyway(true)}
                  style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >Try anyway</button>
              </div>
            </div>
          )}
          <div ref={mountRef} style={{ position: 'absolute', inset: 0, display: status === 'ready' ? 'block' : 'none' }} />

          {status === 'ready' && (
            <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
              <NavPad
                onRotate={(dTheta, dPhi) => navRef.current?.rotateBy(dTheta, dPhi)}
                onZoomIn={() => navRef.current?.zoomBy(0.8)}
                onZoomOut={() => navRef.current?.zoomBy(1.25)}
                onReset={() => navRef.current?.resetView()}
                onIso={() => navRef.current?.goIso()}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Camera control pad matching the classic "D-pad + zoom + reset/iso" layout found in most CAD
// and model-viewer UIs (e.g. printables.com's viewer): a ring of four rotate wedges around a
// zoom in/out circle, with reset and isometric-view buttons below. Built as one SVG so the pie
// wedges, semicircle zoom halves, and cube icon can be laid out with exact geometry rather than
// approximated with rectangular buttons.
const PAD_CX = 57, PAD_CY = 57, PAD_INNER_R = 23;
const wedgeIdle = { fill: '#131a2a', stroke: '#334155', cursor: 'pointer' };
const wedgeHoverFill = '#1e2b45';

function NavPad({ onRotate, onZoomIn, onZoomOut, onReset, onIso }) {
  const [hovered, setHovered] = useState(null);

  function wedgeStyle(id) {
    return { ...wedgeIdle, fill: hovered === id ? wedgeHoverFill : wedgeIdle.fill };
  }
  const hoverProps = (id) => ({
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered(h => (h === id ? null : h)),
  });

  const ROTATE_STEP = Math.PI / 12; // 15° per click

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg width={114} height={114} viewBox="0 0 114 114">
        {/* Up: tilt camera up */}
        <path
          d="M 20.23 20.23 A 52 52 0 0 1 93.77 20.23 L 73.26 40.74 A 23 23 0 0 0 40.74 40.74 Z"
          style={wedgeStyle('up')} {...hoverProps('up')}
          onClick={() => onRotate(0, -ROTATE_STEP)}
        />
        <path
          d="M 57 15.4 l -6.5 10.4 l 13 0 Z" fill="#94a3b8" pointerEvents="none"
        />
        {/* Right: orbit right */}
        <path
          d="M 93.77 20.23 A 52 52 0 0 1 93.77 93.77 L 73.26 73.26 A 23 23 0 0 0 73.26 40.74 Z"
          style={wedgeStyle('right')} {...hoverProps('right')}
          onClick={() => onRotate(ROTATE_STEP, 0)}
        />
        <path d="M 98.6 57 l -10.4 -6.5 l 0 13 Z" fill="#94a3b8" pointerEvents="none" />
        {/* Down: tilt camera down */}
        <path
          d="M 93.77 93.77 A 52 52 0 0 1 20.23 93.77 L 40.74 73.26 A 23 23 0 0 0 73.26 73.26 Z"
          style={wedgeStyle('down')} {...hoverProps('down')}
          onClick={() => onRotate(0, ROTATE_STEP)}
        />
        <path d="M 57 98.6 l 6.5 -10.4 l -13 0 Z" fill="#94a3b8" pointerEvents="none" />
        {/* Left: orbit left */}
        <path
          d="M 20.23 93.77 A 52 52 0 0 1 20.23 20.23 L 40.74 40.74 A 23 23 0 0 0 40.74 73.26 Z"
          style={wedgeStyle('left')} {...hoverProps('left')}
          onClick={() => onRotate(-ROTATE_STEP, 0)}
        />
        <path d="M 15.4 57 l 10.4 6.5 l 0 -13 Z" fill="#94a3b8" pointerEvents="none" />

        {/* Center: zoom in (top half) / zoom out (bottom half) */}
        <path
          d={`M ${PAD_CX - PAD_INNER_R} ${PAD_CY} A ${PAD_INNER_R} ${PAD_INNER_R} 0 1 1 ${PAD_CX + PAD_INNER_R} ${PAD_CY} Z`}
          style={wedgeStyle('zoomin')} {...hoverProps('zoomin')} onClick={onZoomIn}
        />
        <path
          d={`M ${PAD_CX - PAD_INNER_R} ${PAD_CY} A ${PAD_INNER_R} ${PAD_INNER_R} 0 1 0 ${PAD_CX + PAD_INNER_R} ${PAD_CY} Z`}
          style={wedgeStyle('zoomout')} {...hoverProps('zoomout')} onClick={onZoomOut}
        />
        <line x1={PAD_CX - 7.8} y1={PAD_CY - 11.5} x2={PAD_CX + 7.8} y2={PAD_CY - 11.5} stroke="#94a3b8" strokeWidth={2} pointerEvents="none" />
        <line x1={PAD_CX} y1={PAD_CY - 19.3} x2={PAD_CX} y2={PAD_CY - 3.7} stroke="#94a3b8" strokeWidth={2} pointerEvents="none" />
        <line x1={PAD_CX - 7.8} y1={PAD_CY + 11.5} x2={PAD_CX + 7.8} y2={PAD_CY + 11.5} stroke="#94a3b8" strokeWidth={2} pointerEvents="none" />
      </svg>

      <div style={{ display: 'flex', gap: 5 }}>
        <button onClick={onReset} title="Reset view" style={iconButtonStyle}>
          <svg width={20} height={20} viewBox="0 0 16 16">
            <path d="M 13 8 A 5 5 0 1 1 11.5 4.3" fill="none" stroke="#94a3b8" strokeWidth={1.8} />
            <path d="M 13.5 2.5 L 13 5.5 L 10 5" fill="none" stroke="#94a3b8" strokeWidth={1.8} strokeLinejoin="round" />
          </svg>
        </button>
        <button onClick={onIso} title="Isometric view" style={iconButtonStyle}>
          <svg width={20} height={20} viewBox="0 0 16 16">
            <path d="M 8 2 L 13 5 L 13 11 L 8 14 L 3 11 L 3 5 Z" fill="none" stroke="#94a3b8" strokeWidth={1.6} />
            <path d="M 8 2 L 8 8 M 3 5 L 8 8 M 13 5 L 8 8" fill="none" stroke="#94a3b8" strokeWidth={1.6} />
          </svg>
        </button>
      </div>
    </div>
  );
}

const iconButtonStyle = {
  background: '#131a2a', border: '1px solid #334155', borderRadius: 4,
  width: 44, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
};

const centeredStyle = {
  position: 'absolute', inset: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#94a3b8', fontSize: 14,
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Screen-space line width, in CSS pixels — not a world-space (mm) size. This matches how
// OctoPrint-PrettyGCode renders toolpaths (THREE.LineMaterial with a plain `linewidth`, no
// `worldUnits`): a fat line's thickness stays a constant number of pixels regardless of zoom
// or model scale, so it visually bridges the small (sub-mm) gaps between disconnected segments
// — real travel moves and the flat-cap seams at corners alike — at whatever zoom level the
// model is actually being viewed at. A fixed world-space tube radius can't do this: gaps wider
// than the tube's own diameter stay visible, and the fixed mm size doesn't adapt to zoom the
// way a pixel width does.
//
// PrettyGCode's own `linewidth: 3` renders visually thicker than 3px in practice — its
// LineMaterial.resolution is hardcoded to a stale 500x500 (the actual window-resize call is
// commented out in its source, "todo. handle window resize"), and a fat line's on-screen width
// scales with (actualViewportSize / resolution-told-to-the-shader). Since its real viewport is
// typically larger than 500px, its lines end up inflated well past the nominal value. Our own
// `resolution` is kept dimensionally correct (set to the real container size on every resize),
// so matching its visual result takes a genuinely larger nominal width rather than 3.
const LINE_WIDTH_PX = 5;

function renderScene(mount, extrude) {
  const width = mount.clientWidth;
  const height = mount.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0f1a');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  mount.appendChild(renderer.domElement);

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  function expandBounds(x, y, z) {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }

  const segmentCount = Math.floor(extrude.length / 6);
  let lineMaterial;
  if (segmentCount > 0) {
    let minHeight = Infinity, maxHeight = -Infinity;
    for (let i = 1; i < extrude.length; i += 3) {
      if (extrude[i] < minHeight) minHeight = extrude[i];
      if (extrude[i] > maxHeight) maxHeight = extrude[i];
    }
    const heightRange = Math.max(maxHeight - minHeight, 0.001);

    const color = new THREE.Color();
    const low = new THREE.Color(0x3b82f6);
    const high = new THREE.Color(0xfbbf24);
    const colors = new Float32Array(segmentCount * 6);

    for (let s = 0; s < segmentCount; s++) {
      const o = s * 6;
      expandBounds(extrude[o], extrude[o + 1], extrude[o + 2]);
      expandBounds(extrude[o + 3], extrude[o + 4], extrude[o + 5]);

      const tStart = (extrude[o + 1] - minHeight) / heightRange;
      color.copy(low).lerp(high, tStart);
      colors[o] = color.r; colors[o + 1] = color.g; colors[o + 2] = color.b;

      const tEnd = (extrude[o + 4] - minHeight) / heightRange;
      color.copy(low).lerp(high, tEnd);
      colors[o + 3] = color.r; colors[o + 4] = color.g; colors[o + 5] = color.b;
    }

    const geom = new LineSegmentsGeometry();
    geom.setPositions(extrude);
    geom.setColors(colors);

    lineMaterial = new LineMaterial({
      linewidth: LINE_WIDTH_PX,
      vertexColors: true,
      worldUnits: false,
    });
    lineMaterial.resolution.set(width, height);

    const lines = new LineSegments2(geom, lineMaterial);
    lines.computeLineDistances();
    scene.add(lines);
  } else {
    // No extrusion moves parsed at all — fall back to a small default box so the camera has
    // somewhere sane to look, rather than computing from empty (Infinity/-Infinity) bounds.
    Object.assign(bounds, { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 });
  }

  const center = new THREE.Vector3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  );
  const maxDim = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 1);

  // Near/far scaled to the model's actual size rather than fixed constants — a depth buffer
  // has limited precision, and a near/far ratio as extreme as a fixed 0.1-10000 range would be
  // for a print that's only tens of millimeters across causes z-fighting between overlapping
  // surfaces.
  const camera = new THREE.PerspectiveCamera(50, width / height, maxDim / 1000, maxDim * 20);

  const isoOffset = new THREE.Vector3(maxDim, maxDim, maxDim);
  camera.position.copy(center).add(isoOffset);
  camera.lookAt(center);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Without these, nothing stops the camera from crossing the near/far planes — OrbitControls'
  // own defaults are minDistance: 0 / maxDistance: Infinity, so both the NavPad's zoom buttons
  // and native mouse-wheel/pinch zoom can push the camera arbitrarily close (clipping through
  // the model into a nonsensical close-up) or arbitrarily far (clipping the model out of view
  // entirely, past `camera.far`, with no error and no visual explanation — Reset is the only
  // way back). Kept well inside the actual near/far planes rather than flush with them so
  // clipping never happens right at the clamped edge.
  controls.minDistance = maxDim * 0.05;
  controls.maxDistance = maxDim * 10;
  controls.update();

  function resetView() {
    // Full reset: both the isometric angle and the original zoom distance.
    camera.position.copy(center).add(isoOffset);
    controls.target.copy(center);
    controls.update();
  }

  function goIso() {
    // Reorients to the standard isometric angle but keeps whatever zoom level the operator
    // is currently at — distinct from Reset, which also snaps zoom back to the default.
    const distance = camera.position.distanceTo(controls.target);
    const dir = isoOffset.clone().normalize().multiplyScalar(distance);
    camera.position.copy(controls.target).add(dir);
    controls.update();
  }

  function zoomBy(factor) {
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  // Orbits the camera around its current target by a fixed step, driven by the D-pad's
  // rotate wedges — deltaTheta orbits horizontally (around the vertical axis), deltaPhi tilts
  // vertically. Clamped away from the poles (phi near 0/PI) since OrbitControls' own spherical
  // math is unstable exactly at a straight-up/straight-down look direction.
  function rotateBy(deltaTheta, deltaPhi) {
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += deltaTheta;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaPhi, 0.05, Math.PI - 0.05);
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }

  let animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  function handleResize() {
    const w = mount.clientWidth, h = mount.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (lineMaterial) lineMaterial.resolution.set(w, h);
  }
  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(mount);

  const originalDispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    resizeObserver.disconnect();
    originalDispose();
  };

  return { renderer, scene, camera, controls, animId, resetView, goIso, zoomBy, rotateBy };
}
