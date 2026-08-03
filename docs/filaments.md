# Filament Library

Administrator-managed canonical lists of filament types and filament colors. These lists are the single source of truth for what materials and colors exist in the farm — printers and G-codes select from them rather than entering free text.

## Tables

### `filament_types`

| Column | Type    | Notes |
|--------|---------|-------|
| `id`   | INTEGER | PK, autoincrement |
| `name` | TEXT    | Unique, e.g. "PLA", "PETG", "ASA" |

### `filament_colors`

| Column      | Type    | Notes |
|-------------|---------|-------|
| `id`        | INTEGER | PK, autoincrement |
| `type_id`   | INTEGER | FK → `filament_types.id` (NOT NULL). A color belongs to exactly one type. |
| `name`      | TEXT    | Unique per type, e.g. "Black", "Galaxy Red". `UNIQUE(type_id, name)`. |
| `hex_color` | TEXT    | Optional hex code, e.g. "#FF0000". Shown as a color swatch in the Settings table. |

## API Endpoints — `server/routes/filaments.js`

All endpoints are mounted at `/api/filaments`.

### `GET /api/filaments/types`
Returns all filament types ordered by name.
```json
[{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }]
```

### `POST /api/filaments/types`
Add a new filament type.
- Body: `{ "name": "ASA" }`
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/types/:id`
Remove a filament type by ID.
- No foreign-key block — deleting a type does not clear printers or G-codes that reference it by name. The stored name string remains; the operator resolves via the printer/gcode form on next edit.
- Returns 404 if not found.

### `GET /api/filaments/colors`
Returns all filament colors ordered by name.
```json
[{ "id": 1, "name": "Black", "hex_color": "#000000" }, { "id": 2, "name": "Galaxy Red", "hex_color": null }]
```

### `POST /api/filaments/colors`
Add a new filament color.
- Body: `{ "type_id": 1, "name": "Galaxy Red", "hex_color": "#C0392B" }` — `hex_color` is optional; `type_id` is required.
- Returns: the created row with `type_name` included (201)
- Errors: 400 if name or type_id missing / type not found, 409 if name already exists for that type

### `DELETE /api/filaments/colors/:id`
Remove a filament color by ID. Same non-blocking behavior as type deletion.

## Where filament data is used

| Location | Field | Meaning |
|----------|-------|---------|
| `printers.loaded_material` | type name | What material is currently loaded on the printer |
| `printers.loaded_color` | color name | What color is currently loaded on the printer |
| `gcodes.required_material` | type name | Material required to print this G-code |
| `gcodes.required_color` | color name | Color required to print this G-code |

The scheduler uses `required_material` and `required_color` to match G-codes to printers with matching `loaded_material` / `loaded_color`.

## Settings UI

The **Filament Library** section in Settings has two sub-sections:

**Filament Types** — table of all types with delete buttons; add form with a required name field.

**Filament Colors** — table of all colors (with hex swatch if provided) and delete buttons; add form with a required name field and optional hex color picker.

## Client usage

All client pages that show material/color pickers (Settings add-printer form, Printers bulk edit, PrinterDetail edit form, Projects G-code upload and edit) source their options through the shared `useFilamentLibrary()` hook (`client/src/useFilamentLibrary.js`) rather than fetching `/api/filaments/types`/`/api/filaments/colors` directly, and render `<select>` dropdowns rather than free-text `<input>` elements.

## Spoolman mode

When the [Spoolman integration](spoolman.md) is enabled, `useFilamentLibrary()` sources every picker's options from Spoolman's live filament list instead of this page's manual tables, and the Filament Library section in Settings becomes read-only (the local `filament_types`/`filament_colors` tables and their CRUD endpoints are untouched underneath; disabling the integration instantly restores manual editing). This is a full mode switch, not a per-field toggle: while enabled, every picker on the farm reads from Spoolman, none from the local library.

Two differences to know about while in this mode:

- **Color values become hex, not names.** Spoolman has no separate "color name" concept, only a hex code (`Filament.color_hex`, stored without a leading `#`). The picker renders it with a leading `#` added, to match this table's own `hex_color` convention, and that hex string (e.g. `#1A1A1A`) becomes the actual `loaded_color`/`required_color` value stored on the printer or G-code, not a friendly name.
- **Matching stays case-sensitive plain-string equality**, unchanged in the scheduler. A `required_color` typed by hand under Spoolman mode must match the picker's hex value exactly, including case.

Multi-color filaments (Spoolman's `multi_color_hexes`, used when `color_hex` is null) are not supported by any picker; such a filament shows up as a type with no selectable color.

**Printer-level pickers are further restricted.** `loaded_material`/`loaded_color` represent what's physically on a printer, so while Spoolman is enabled those two fields can only be set by [binding a spool](spoolman.md#loaded-spool-binding) via PrinterDetail: the Add Printer form (Settings) and the Printers page's bulk-edit bar drop their Material/Color controls entirely, and PrinterDetail's own edit form renders them read-only. This restriction does not apply to `required_material`/`required_color` on G-codes and projects (Projects page): those remain free `<select>` pickers sourced from Spoolman's filament list, since a G-code requirement is a matching criterion, not a physical spool binding.
