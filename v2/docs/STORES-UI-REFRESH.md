# Stores UI refresh — detailed plan (2026-11-15)

Status: **implemented 2026-11-15** (stages 1–5; uncommitted). Decisions taken with the user: Archived rolls up with Cancelled; map uses per-status
bubbles; sheet status values all stay Upcoming, install type is its own column; DMA comes from the report's `DMA`
field (verified: e.g. "Atlanta", "Austin"; `DMA Code` holds 500…).

No stored data changes meaning: the nine screen statuses stay as they are (routing, device sync, history unchanged).
Everything new is additive with safe defaults, so existing items need no migration.

## Stage 1 — Backend

### 1.1 Status buckets (`domain/statuses.py`, `domain/kpi.py`)
- `StatusBucket` enum + `BUCKET_OF: dict[ScreenStatus, StatusBucket]`:
  - Completed ← Completed
  - Upcoming ← Upcoming
  - In Progress ← Invitation Email Sent, Shipped, Delivered, Serviced - Needs More Work
  - Offline ← Offline
  - Cancelled ← Cancelled, Archived
- `Kpi` gains `by_bucket` (stores) and `screens_by_bucket` (screens), plus `by_installer_bucket:
  {name: {done, upcoming}}` for the per-technician bubbles. Existing fields stay (dashboard uses them).
- Store filter accepts `bucket=` (expands to the statuses); the `status=` param keeps working.
- Sheet aliases: add `"cancelled location"` → Cancelled. Unrecognised sheet values stay Upcoming but are **no
  longer flagged for review** when they are install-type words (see 1.2).

### 1.2 Install type + technician (`domain/models.py`, `import_mapping.py`, `validation.py`)
- `Stop.install_type: "" | "Technician" | "Self install" | "Rep install"` (store level, editable).
- Import: sheet status `technician` → Technician; any value not in {completed, archived, cancelled location,
  offline, technician} and not blank → Self install; Rep install is set by hand. Status itself stays Upcoming.
- Technician name: the existing `installer_name` (already mapped from the sheet's "Technician" header). Add
  header aliases so column E maps whatever it is titled; shown as a table column.
- Filter facet `install_type`; table column; editable in the drawer.

### 1.3 Needs mount (`Screen`)
- `Screen.needs_mount: bool = False` — a mount must be brought/installed; independent of `has_mount`
  (already there) and `has_ceiling_mount`.
- Store-level derived `needs_mount_count` in list rows + filter facet "Needs mount" so route prep can see it.

### 1.4 Fulfilled flag
- Derived per store (list rows + pins): `fulfilled = committed_dolphin_screens + committed_store_tvs > 0 and
  installed >= committed`, where installed = screens with status Completed. Facet `fulfilled`.

### 1.5 DMA from the Dolphin report (`repositories/device_data.py`, `domain/device*.py`)
- Read `DMA` (+ `DMA Code`) into `DeviceRecord` and `StoreDevice`.
- Sync writes `dma` onto the store **only when the store's `dma` is blank** (sheet wins, like name/address);
  the report value also shows in the device section. Re-sync fills the backlog.

### 1.6 Tests
- Bucket mapping and KPI counts, `bucket` filter, import install-type rules + `cancelled location`,
  needs-mount default/round-trip, fulfilled derivation, DMA fill-if-blank (and never overwrite).

## Stage 2 — Stores tab layout (`StoresTab.tsx`, `StoresToolbar`, `FilterBar`, `ProjectKpis`)

1. **Header bubbles** (Atlanta style): Total screens · Completed · Upcoming · In Progress · Offline ·
   Cancelled · one `done/upcoming` bubble per technician · Need attention (existing). Big tabular number, small
   mono caps label, bucket colour. Clicking a bucket bubble toggles that bucket filter.
2. **Filter row**: bucket chips (with counts) move here from the map legend, next to the existing facets
   (PA, State, City, DMA, Venue type, Install type, Needs mount, Fulfilled) and search. Table, map and chart all
   follow this one selection.
3. **Map row**: map 75% | top-states chart 25% (stacks on narrow screens). The map legend keeps its checkboxes
   as a *visual* hide/show on pins only (does not refetch the table).
4. **Table below**, full width, paginated as today. New columns: Install type, Technician, Screens
   (`installed/committed`). Row tint light green when fulfilled; status column unchanged.

## Stage 3 — Map markers (`MapView.tsx`, `pins.ts`)
- One `MarkerClusterer` per bucket instead of one shared clusterer, so bubbles never mix statuses.
- Bubble colour = bucket colour, shade by count on a log scale (light for few, dark for many): light red few
  offline → deep red many; light → dark green for completed; etc.
- Past `CLUSTER_MAX_ZOOM` every store is its own pin in its status colour (as now). Same-address stacks unchanged.
- Legend checkbox hides a bucket's clusterer (cheap, no refetch).

## Stage 4 — Store drawer (`StoreDrawer.tsx`) → two-column like the Log Entry panel
- Wider dialog (`max-w-6xl`), two columns on `lg`, one column below.
- **Left (edit)**, top to bottom: header (status, route, Log visit) → Identity & address → **Screens** (right
  under the address) → Screen counts (committed) → Install (type, technician) → Pictures.
- **Right (read-only reference, scrolls separately)**: WiFi (still editable via its Edit button as in the visit
  form), Contacts, Site notes, Site checklist, Other imported data, Device data, Servicing history, Progress.
- Sections and validation logic reused; only placement changes.

## Stage 5 — Screen editor (`ScreensEditor.tsx`)
- Size picker as large tiles: 24″ (monitor icon), 32″, 43″, 55″, 65″ (TV icon), Other (free text). Lucide
  `Monitor` for ≤32″, `Tv` for larger; tile shows icon + size in big type; selected tile outlined in brand.
- Per-screen toggles: Dolphin screen / store TV, Has mount, Ceiling mount, **Needs mount** (amber when on).
- Status select keeps all nine statuses, grouped by bucket.

## Order & checkpoints
Stage 1 → 2 → 3 → 4 → 5, each with tests (`pytest`, `vitest`, typecheck) green before the next. Stage 1 also
needs the OpenAPI types regenerated (`schema.d.ts`). Nothing is deployed or committed without asking.

## Open (non-blocking)
- The report also has `Screen Dimension`; could pre-fill screen size later.
