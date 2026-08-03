import { useState, useEffect, useCallback } from 'react';

// Sources material/color pickers from either the local Filament Library or, when the
// Spoolman integration is enabled, Spoolman's live filament list. Same output shape
// either way: { id, name } for types, { id, name, hex_color, type_name } for colors,
// so every picker built against this hook needs no changes based on which mode is
// active (see client/src/pages/Settings.jsx, PrinterDetail.jsx, Printers.jsx,
// Projects.jsx for the picker JSX itself).
//
// Spoolman has no separate "color name" concept. The picker's value (and label) for a
// Spoolman-sourced color is the filament's own `name` field (e.g. "Prusament PETG Signal
// Red"), not its hex code: a hex string is unreadable in a dropdown, and printers.js's
// spoolman-bind/spoolman-sync derive a bound printer's loaded_color from the same
// filament.name field, so the scheduler's plain-string equality match (loaded_color vs
// required_color) still lines up correctly. `hex_color` is carried along for reference
// only (e.g. a swatch), never used as the matching value. Filaments with no single
// color_hex (multi-color filaments) are skipped from the color list rather than guessed.
export function useFilamentLibrary() {
  const [filamentTypes, setFilamentTypes] = useState([]);
  const [filamentColors, setFilamentColors] = useState([]);
  const [librarySource, setLibrarySource] = useState('local');

  const refetchFilamentLibrary = useCallback(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(settings => {
        if (settings.spoolman_enabled === 'true') {
          setLibrarySource('spoolman');
          return fetch('/api/spoolman/filaments')
            .then(r => (r.ok ? r.json() : []))
            .then(filaments => {
              const types = new Map();
              const colors = new Map();
              for (const f of filaments) {
                if (!f.material) continue;
                if (!types.has(f.material)) types.set(f.material, { id: f.material, name: f.material });
                if (f.color_hex && f.name) {
                  const hex = '#' + f.color_hex.toUpperCase();
                  const key = `${f.material}|${f.name}`;
                  if (!colors.has(key)) {
                    colors.set(key, { id: key, name: f.name, hex_color: hex, type_name: f.material });
                  }
                }
              }
              setFilamentTypes([...types.values()].sort((a, b) => a.name.localeCompare(b.name)));
              setFilamentColors([...colors.values()].sort((a, b) => a.name.localeCompare(b.name)));
            });
        }
        setLibrarySource('local');
        return Promise.all([
          fetch('/api/filaments/types').then(r => r.json()),
          fetch('/api/filaments/colors').then(r => r.json()),
        ]).then(([types, colors]) => {
          setFilamentTypes(types);
          setFilamentColors(colors);
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refetchFilamentLibrary(); }, [refetchFilamentLibrary]);

  return { filamentTypes, filamentColors, librarySource, refetchFilamentLibrary };
}
