# Device sync and review: architecture, decision flows, review findings

Covers the "dolphin status sync" feature: `domain/device.py`, `domain/device_sync.py`, `services/device_sync.py`,
`repositories/device_data.py`, `repositories/device_review.py`, `handlers/device_data.py`, the worker's daily task,
`api/routers/device_sync.py`, the infra for it, and `frontend/src/features/device/*`.

Reviewed 2026-11-16 at commit `ec7a6b8`. Findings marked **confirmed** were reproduced against the in-memory
repositories; the rest come from reading the code.

## 1. Architecture

```mermaid
flowchart LR
  subgraph Browser
    PP["ProjectPage<br/>useAutoDeviceSync"]
    DS["Settings · DeviceSettings<br/>PA, Sync now, Overwrite all"]
    RD["ReviewDialog<br/>Add / Not now"]
    SD["StoreDrawer · StoreDeviceSection<br/>Overwrite, Ignore alert"]
  end

  subgraph AWS
    GW["HTTP API<br/>30 s limit"]
    API["API Lambda · FastAPI<br/>29 s"]
    WK["Worker Lambda<br/>15 min"]
    DD["Device-data Lambda<br/>25 s · only holder of the Mongo URI"]
    EB["EventBridge<br/>daily 12:00 UTC"]
    SSM["SSM SecureString<br/>mongodb-uri"]
    DB[("DynamoDB, one table")]
  end

  MG[("MongoDB · CMS<br/>dolphin-internal-report<br/>one row per venue per day")]
  GG["Google Geocoding / Places"]

  PP & DS & RD & SD --> GW --> API
  EB -- "task: device_sync_all" --> WK
  API -- "invoke: latest_date, list_pas, snapshot" --> DD
  WK -- "invoke" --> DD
  DD --> SSM
  DD -- "read only" --> MG
  API & WK --> DB
  API -- "Add from review" --> GG
```

Code layers (all three entry points run the same `DeviceSyncService`):

```mermaid
flowchart TB
  R["api/routers/device_sync.py"] --> S
  W["handlers/worker.py · sync_all_devices"] --> S
  S["services/device_sync.py<br/>DeviceSyncService"] --> D["domain/device_sync.py<br/>pure rules"]
  S --> SS["services/stores.py<br/>append, update_screens"]
  S --> SRC["repositories/device_data.py<br/>LambdaDeviceData or MongoDeviceData"]
  S --> RV["repositories/device_review.py"]
  S --> ST["repositories/stores.py<br/>update_device_many, update_fields"]
  S --> PR["repositories/projects.py"]
  SRC -. "AWS" .-> H["handlers/device_data.py"] --> M["MongoDeviceData"]
```

What is stored where (all under `PK = PROJECT#<id>`):

| Item | Written by the sync | Notes |
| --- | --- | --- |
| `META` · `device_pa` | Settings | "" = no sync |
| `META` · `device_sync` | sync, `_recount` | pa, snapshot_date, ingested_at, synced_at, counters |
| `STOP#` · `screens[].device`, `screens[].status`, `status_changed_at` | sync, add | per-screen overlay and work status |
| `STOP#` · `device` | sync, add | store overlay from the first matched screen |
| `STOP#` · `needs_attention` | sync, ignore, overwrite | `not_reporting`, `dd_code_review` |
| `STOP#` · `device_alert_ignored` | ignore | the report day the alert was ignored for |
| `STOP#` · `dma`, `venue_type` | sync | only when blank |
| `DEVREVIEW#<venue key>` | sync (replace), snooze, add (delete) | one item per unknown venue |

## 2. Decision flows

### 2.1 When a sync runs

```mermaid
flowchart TD
  A["Project opened in the browser"] --> A1{"device_pa set?"}
  A1 -- no --> X["No sync"]
  A1 -- yes --> A2["POST device-sync?only_if_stale=true<br/>once per project + PA per page load"]
  B["Sync now, or Save and sync"] --> F["POST device-sync, forced"]
  C["EventBridge 12:00 UTC"] --> C1["Worker: every project with a PA<br/>only_if_stale=true"]
  A2 --> G
  C1 --> G
  G{"state exists, same PA,<br/>state.snapshot_date >= report's newest day?"}
  G -- yes --> SK["Skip: synced=false"]
  G -- no --> RUN["Run the sync"]
  F --> RUN
```

### 2.2 What one sync does

```mermaid
flowchart TD
  S1["snapshot = every record of the PA on the newest day"] --> S2["codes = records by venue key<br/>DD-ABC = dd_abc = DD_ABC"]
  S2 --> S3["For each store: sync_stop"]
  S3 --> S4["Write changed stores only<br/>update_device_many, 16 threads"]
  S4 --> S5["Review list = records whose code no screen has<br/>minus Archived; keep Not now of the same day"]
  S5 --> S6["reviews.replace: write the diff, delete the rest"]
  S6 --> S7["META.device_sync = date, ingested_at, counters"]
```

### 2.3 Per screen: overlay and work status

```mermaid
flowchart TD
  P0{"Screen's DD code in the report?"}
  P0 -- no --> P1["device = none<br/>status untouched"]
  P0 -- yes --> P2["device = report values"]
  P2 --> P3{"Report status"}
  P3 -- Online --> T1["target = Completed"]
  P3 -- Offline --> T2["target = Offline"]
  P3 -- Archived --> T3["target = Archived"]
  P3 -- "Not Registered, Testing,<br/>Unclassified, other" --> P4["Show only"]
  T1 & T2 & T3 --> P5{"Tracker status is<br/>Cancelled or Archived?"}
  P5 -- yes --> P6["Keep the tracker's status"]
  P5 -- no --> P7{"target differs?"}
  P7 -- yes --> P8["status = target<br/>status_changed_at = now"]
  P7 -- no --> P9["No change"]
```

A packed entry ("DD-A. DD-B") matches nothing: the store gets `dd_code_review`, and its codes are kept out of the
review list.

### 2.4 Per store: "not in Dolphin data" alert

```mermaid
flowchart TD
  N0{"device_alert_ignored == this report day?"}
  N0 -- yes --> NO["No alert"]
  N0 -- no --> N1{"Any screen: Completed, has one DD code,<br/>code missing from the report?"}
  N1 -- no --> NO
  N1 -- yes --> N2{"status_changed_at known, ingested_at known,<br/>and changed after ingested_at?"}
  N2 -- yes --> NO2["No alert: newer than the report"]
  N2 -- no --> YES["needs_attention += not_reporting"]
```

### 2.5 Review: Add and Not now

```mermaid
flowchart TD
  R0["Add"] --> R1{"Store with the same ExtID,<br/>else the same address<br/>(sheet or Dolphin data)?"}
  R1 -- yes --> J["Add the stick as a new screen of that store"]
  R1 -- no --> R2{"Place picked?"}
  R2 -- yes --> L["Located at the place"]
  R2 -- no --> R3{"Typed or reported address<br/>verified by Google?"}
  R3 -- yes --> L
  R3 -- no --> R4{"add_anyway?"}
  R4 -- no --> E["422 with Google's suggestions"]
  R4 -- yes --> C2["Create the store, flagged: address"]
  L --> R5{"A store at the verified address?"}
  R5 -- yes --> J
  R5 -- no --> C1["Create the store<br/>flag external_id / store_name when missing"]
  J & C1 & C2 --> AP["Apply the record to that screen<br/>delete the review item, recount"]
  Z0["Not now"] --> Z1["snoozed_date = snapshot_date<br/>hidden until a newer report day"]
```

### 2.6 Overwrite

```mermaid
flowchart TD
  O0["Fields chosen: store_name, addr, city, state, zip, location"] --> O1{"Store has Dolphin data?"}
  O1 -- no --> ON["Nothing"]
  O1 -- yes --> O2{"Field"}
  O2 -- "text field" --> O3{"Report has a value and it differs?"}
  O3 -- yes --> O4["Copy it; store_name clears the store_name flag"]
  O2 -- location --> O5{"Report has lat/lng and it differs?"}
  O5 -- yes --> O6["Copy lat/lng, geocoded = report address,<br/>route_stale = true, clear the address flag"]
```

### 2.7 A project from the Dolphin data alone (no sheet)

Added 2026-11-24. New project → "Stores from: Dolphin data only" sends `POST /projects` with `device_pa` and no
stops (the project's `pa` defaults to it), then `POST /projects/{id}/device-sync/populate`. Settings → "Add stores
from Dolphin data" calls the same endpoint again, to retry or to take in new venues.

```mermaid
flowchart TD
  Q0["snapshot of the PA's newest day (one read)"] --> Q1["records no screen has, minus Archived"]
  Q1 --> Q2{"store_for_record finds a store<br/>already in the project?"}
  Q2 -- yes --> Q3["Skip: stays in review, Add joins it"]
  Q2 -- no --> Q4["Group: same ExtID, else same address<br/>one store per group, a screen per record"]
  Q4 --> Q5["Store at the report's lat/lng (no Google check)<br/>a value the store rules refuse is left blank<br/>flags: address (no location), external_id, store_name"]
  Q5 --> Q6["StoreService.append"] --> Q7["the sync of 2.2 on the same snapshot"]
```

## 3. Findings

### Bugs

1. **A sync during the CMS's nightly load wipes the overlay and sticks for the day. (confirmed; accepted
   2026-11-16: "Sync now" repairs it, no change planned)**
   `MongoDeviceData._newest_raw_date` takes the newest `Date` across every PA
   (`repositories/device_data.py:58`), and `snapshot` reads the PA's rows for that day. If the new day exists but this
   PA's rows are not loaded yet (or only partly), the sync sees zero or few records: every screen loses `device`,
   every Completed store is flagged `not_reporting`, the review list is emptied. `state.snapshot_date` is then the
   new day, so `only_if_stale` (`services/device_sync.py:102`) skips every later attempt that day, including the
   12:00 UTC schedule. Only "Sync now" repairs it. The on-open sync can fire at any hour.
   Whether the load is atomic is not visible from this repo; if it is not, this will happen.
   Fix: have the staleness check also compare `ingested_at` (a finished load has a newer one), and refuse to apply a
   snapshot with zero records when the last sync matched some.

2. **Fixed 2026-11-16.** **Overwrite of store name + location together leaves the `store_name` flag. (confirmed)**
   In `overwrite_changes` (`domain/device_sync.py:158`) the `location` branch rebuilds `needs_attention` from
   `stop.needs_attention`, discarding what the `store_name` branch just removed. The frontend sends the fields in
   that order. Fix: start from `changes.get("needs_attention", ...)` like the other branch.

3. **Fixed 2026-11-16** (Add returns the store that already has the code; typing a code another store has is
   refused). **Add from review can put one DD code in two stores. (confirmed)**
   The review list is only rebuilt by a sync. If someone types the code into a store by hand, the item stays listed
   (and counted), and Add then attaches the same code to whatever store matches by ExtID or address
   (`services/device_sync.py:193`). Fix: in `add_from_review`, check the code against all screens first; if a store
   already has it, delete the item and return that store.

4. **Changing a screen's DD code keeps the old venue's device data. (confirmed)**
   `StoreService.update_screens` carries `device` over by screen id (`services/stores.py:537`), not by code. The
   screen shows the previous venue's status, serial and last-seen until the next report day, since the on-open sync
   is skipped as not stale. Fix: drop `device` when `venue_code_key` changed.

5. **Turning the sync off (or it never running again) leaves everything in place. (confirmed)**
   `ProjectService.update` clears only `META.device_sync` (`services/projects.py:170`). Stores keep `device`, screens
   keep `device`, `not_reporting` flags stay, `DEVREVIEW#` items stay, and the map and table keep showing the report's
   name and location with no way to remove them. Fix: clear the overlays and review items when `device_pa` becomes "".

6. **Sync bookkeeping bumps the project's `version`. (confirmed)**
   `ProjectRepository.update` increments `version` on every call (`repositories/projects.py:97`). Each sync, snooze,
   add and ignore does so, and so does the daily schedule. A Settings form opened before that saves with a stale
   `expected_version` and gets "modified concurrently" for an edit that did not conflict. It also moves `updated_at`,
   which `begin_routing` uses to detect a stale build. Fix: write `device_sync` with its own update that leaves
   `version` and `updated_at` alone.

7. **Review dialog can strand on an empty page.** `ReviewDialog.tsx:19` keeps a stack of offset cursors. Add or
   snooze the last item of the last page and the page comes back empty; when the total is now ≤ 25 the pager is
   hidden (`:122`), so there is no way back, and the state survives closing the dialog. Fix: reset to the first page
   when the page is empty and on close.

8. **Timeouts do not line up.** `sync` makes two Lambda invokes (`latest_date`, then `snapshot`), and `snapshot`
   repeats the `distinct("Date")`: up to three 20 s Mongo queries against a 25 s Lambda and a 29 s API
   (`infra/stacks/api_stack.py:100`). The comment there ("a slow Mongo fails the call cleanly") holds for one query
   only; otherwise the browser gets API Gateway's bare 503. Fix: one invoke, see simplification 1.

### Inconsistencies

9. **A manual status newer than the report is respected by the alert but not by the status rule.** `not_reporting`
   skips a screen changed after `ingested_at`; `sync_screen` (`domain/device_sync.py:71`) does not look at
   `status_changed_at`, so a screen someone set by hand this morning goes back to the report's status on the next
   sync. Decide which rule is intended and apply it in both places.

10. **`sync_all` reports skipped projects as synced. (confirmed)** `services/device_sync.py:143` counts every call
    that did not raise. Use the result's `synced`.

11. **Stored counters drift.** `review_count` and `not_reporting` on `META` are only recomputed by sync, snooze, add
    and ignore. A manual screen edit, a store delete or finding 3 leaves the header badge wrong until the next sync.

12. **`DEVICE_FIELDS` is described as "written only by the device sync"** (`domain/models.py:317`), but `screens`,
    `status`, `needs_attention`, `dma` and `venue_type` are also written by the store edits. The sync writes whole
    values computed from an earlier `list_all` with no condition, so an edit landing in between is overwritten. The
    window is short (the Mongo read happens first), but the "disjoint write groups" comment is not true here.

13. **PA names are trimmed for the list but matched exactly.** `list_pas` strips whitespace
    (`repositories/device_data.py:80`); `snapshot` queries `"PA Name": pa` verbatim. A name stored with stray
    whitespace would be offered and then match nothing.

14. **Timestamps are compared as text.** `status_changed_at < ingested_at` and `max(ingested_at_utc)` assume one
    ISO shape. `utc_iso` passes strings through unchanged, and the tests already cover a text `Last Seen`; a text
    `ingested_at_utc` would compare wrongly on the load day.

15. **Small ones.** The dialog says "Add creates the store" though it may join one. The sync schedule comment says
    the load is at about 03:00 UTC while the rule is at 12:00 (fine, but the nine hours are what finding 1 relies on
    for the schedule only). `Screen.status_changed_at`'s comment says "after the report's day"; the code compares
    with the load time.

### Risks to keep in mind

- A snapshot comes back through a synchronous Lambda invoke, capped at 6 MB. At roughly 600 bytes a record that is
  about 10,000 venues in one PA.
- One future-dated or mistyped `Date` in the report becomes "the newest day" for every project.

## 4. Simplifications

1. **One device-data call per sync.** Let `snapshot` take the date the caller already has and answer "not newer"
   without reading rows. Removes `latest_date`, one invoke and one `distinct` per sync, and fixes finding 8. Carry
   `ingested_at` in the same answer for finding 1.
2. **Derive the counters instead of storing them** (or recount inside the two writes that change them). Removes
   `_recount`, its extra `reviews.list` + `list_projected` on every snooze, add and ignore, and finding 11.
3. **`add_record_changes` has an unused `snapshot` parameter**; `add_from_review` builds a `DeviceSnapshot` only to
   pass it (`services/device_sync.py:215`). Drop both.
4. **`update_routing_many`, `update_progress_many` and `update_device_many` have the same body**
   (`repositories/stores.py:257`). One `_write_many(check, changes)`.
5. **`sync_stop` scans the screens three times** for the first matched record, the first DMA and the first venue
   type. Build the matched records once.
6. **Overwrite field names are validated three times**: the request model's `Literal`, the service's set check and
   the domain's `ValueError`. Keep the request model and one guard.
7. **`_create_store` re-reads every store to find the one it just appended**, the third full read in one Add. Have
   `append` return the new stops.
8. **`sync` reads the review list twice** (once for the snoozed keys, once inside `replace`). Let `replace` take the
   current items, or return them.
9. **The worker wires `DeviceSyncService` by hand** (`handlers/worker.py:71`) apart from `deps.py`. One factory used
   by both.
10. **Frontend: the status dot is implemented twice** (`ScreenDeviceLine` in `DeviceBits.tsx`, `DolphinCell` in
    `ScreensEditor.tsx`), and `splitCodes` duplicates the server's `split_codes` with no shared test cases.
