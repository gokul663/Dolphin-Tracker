# Store model v2 — field spec from the IBC sheet

Source: the user's sample sheet (header row below) and their field list, 2026-10-16. This replaces the
placeholder default schema in `AGENT-HANDOFF.md` §3.1. The questions in §7 were answered by the user on 2026-10-16 and the answers are applied throughout. Two
reviewer defaults the user has not been asked about are still marked **assumption** inline (legacy `external_id`
fallback in §4.4, sheet coordinates kept on geocode failure in §6).

Sample header (tab-separated in the original):
`Date, IBC#, STATUS, Shipment / Device status, Technician, Notes, CMS details added, SITE ACCOUNT Created,
SCREENS added, DAgent Added, Google Drive Made, Renamed in ESPR, PICTURES ADDED, CMS credentials given, sent to BO,
payment initiated (only for self install), No of Sticks, Stick Number, Venue ID, CMS NAME, Store Name, Store Address,
Latitude, Longitude, City, State, Zip, Regional Manager, Regional Manager email, Regional Manager phone number,
Store Owner Name, Store Owner Number, Store Owner Email, Outlet Status, Best Contact Time, Preferred Language,
Does the store need TVs?, How many screens does store want?, How many TVs are in the store?, TV OR SCREEN,
Confirmed for Mounting (Yes/No/Unsure), Service Type, Preferred Area In Store, Spot Visible From Most Of Store?,
Power Outlet Within 6 Ft of Install Spot, Can Ethernet Be Run To Install Spot, Is Low-Volume Audio Acceptable,
Is Ceiling Suitable For Mounting?, Ceiling Type, Approx. Ceiling Height, Nearest Power Outlet, Ethernet Cable Route,
Store SSID, Store SSID Password, Account Program Pictures: Image URL, Days / Times Cannot Install,
Blocked Dates / Notes, Preferred Install Date/Time, On-site Contact Name, On-site Contact Phone, On-Screen Features,
Products / Content to Avoid, Installation comments, Installation area`

---

## 1. Principles

1. **Three required fields:** `external_id` (IBC#), `store_name`, `addr`. Everything else is optional; if the
   sheet has it we store it, if not it stays empty.
2. **Fixed, first-class fields** for everything the user listed (§3). The generic `field_schema` / `fields` map
   stays only for columns we do not recognise ("Other imported data"), so nothing from a sheet is lost. Create
   and append add a text entry to `field_schema` for each such column the project does not list yet.
3. **PA is project-level.** Editable on the project (create and Settings). A store carries `pa` only when the
   sheet has a PA column; it is never editable in the planner.
4. **Multiple sheets per project.** The same upload flow runs for the first and every later sheet. Duplicates are
   skipped by `external_id` first, then by normalised address, against rows earlier in the same sheet and against
   stores already in the project. The result reports every skipped row and why.
5. **Status is per screen.** A store has one or more screen rows; the store's status is derived (§4).
6. **Address is validated on save** (geocode), split into street / city / state / zip, and editable in the planner.
7. **Audit later.** `updated_at` and `updated_by` are stored on every write now; the audit log is a later phase.

---

## 2. Stop item (DynamoDB `PROJECT#<id>` / `STOP#<uid>`), v2 attributes

| Attribute | Type | Source column | Editable in planner | Notes |
|-----------|------|---------------|---------------------|-------|
| `external_id` * | str | IBC# | **no** | set on import only; marker item `SK=EXT#<normalised>` enforces uniqueness per project |
| `store_name` * | str | Store Name | yes | |
| `addr` * | str | Store Address (street part) | yes | geocoded on save |
| `city`, `state`, `zip` | str | City, State, Zip (fallback: parsed from Store Address) | yes | state stored as 2-letter code |
| `lat`, `lng` | float | Latitude, Longitude (fallback: geocode) | via geocode only | |
| `geocoded` | str | geocode formatted address | no | |
| `pa` | str | PA (only if present) | **no** | display falls back to `project.pa` |
| `dma` | str | DMA (only if present) | yes | lookup API later |
| `venue_type` | str | Venue Type (only if present) | yes | |
| `source_date` | date | Date | no | sheet row date |
| `installer_name` | str | Technician | yes (progress) | "self install" is a valid value |
| `onsite_contact_name` | str | On-site Contact Name | yes | |
| `onsite_contact_phone` | phone | On-site Contact Phone | yes | |
| `owner_name` | str | Store Owner Name | yes | |
| `owner_phone` | phone | Store Owner Number | yes | |
| `owner_email` | email | Store Owner Email | yes | |
| `best_contact_time` | str | Best Contact Time | yes | |
| `preferred_language` | str | Preferred Language | yes | |
| `products_to_avoid` | text | Products / Content to Avoid | yes | |
| `store_ssid` | str | Store SSID | yes | |
| `store_ssid_password` | str | Store SSID Password | yes | masked in the table, revealed in the drawer |
| `installation_notes` | text | Installation comments | yes | multi-line |
| `image_url` | url | Account Program Pictures: Image URL | yes | may contain several URLs; keep the raw string, render each `http` token as a link |
| `cms_details_added` | bool | CMS details added | yes | |
| `outlet_status` | select New / Existing | Outlet Status | yes | |
| `committed_dolphin_screens` | int | How many screens does store want? | yes | committed value from the sheet; the *actual* count is the number of screen rows with `is_dolphin_screen` |
| `committed_store_tvs` | int | How many TVs are in the store? | yes | committed value from the sheet; the *actual* count is the number of screen rows without `is_dolphin_screen` |
| `preferred_area` | str | Preferred Area In Store | yes | comments group |
| `ceiling_type` | str | Ceiling Type | yes | comments group |
| `ceiling_height` | str | Approx. Ceiling Height | yes | comments group, free text ("10ft", "16-18") |
| `nearest_power_outlet` | str | Nearest Power Outlet | yes | comments group |
| `ethernet_route` | str | Ethernet Cable Route | yes | comments group |
| `blocked_dates_notes` | str | Blocked Dates / Notes | yes | comments group |
| `preferred_install_datetime` | str | Preferred Install Date/Time | yes | comments group, free text as in the sheet |
| `spot_visible` | bool? | Spot Visible From Most Of Store? | yes | tri-state: Yes / No / blank=unknown |
| `power_within_6ft` | bool? | Power Outlet Within 6 Ft of Install Spot | yes | tri-state |
| `ethernet_possible` | bool? | Can Ethernet Be Run To Install Spot | yes | tri-state |
| `low_volume_audio_ok` | bool? | Is Low-Volume Audio Acceptable | yes | tri-state |
| `ceiling_suitable` | bool? | Is Ceiling Suitable For Mounting? | yes | tri-state |
| `screens` | list | see §4 | yes | at least one row |
| `fields` | map | every other column | shown read-only under "Other imported data" | keyed by normalised header |
| routing: `installer`, `day`, `seq`, `route_stale` | | | routing writes only | unchanged |
| `comment`, `additional_task` | | | yes (progress) | unchanged from v1 |
| `updated_at`, `updated_by` | | | set on every write | audit later |

Removed from first-class: `venue_code` (the sheet's Venue ID is per screen, §4), `payee_name` (keep as an extra
field if a sheet has it), `display_id` stays for humans, `status` on the stop becomes **derived** (§4).

Tri-state booleans import `Yes`/`TRUE` → true, `No`/`FALSE` → false, anything else → null (unknown).

---

## 3. Fixed field groups for the store modal (order to display)

The store opens in a large modal (it was a side drawer until 2026-10-19) with every group collapsible. WiFi,
Identity & address, Screens and Pictures start open; a group with a validation problem is always open.

0. **WiFi:** store_ssid, store_ssid_password (masked, with a show button). First, because the installer needs it on site.
1. **Identity & address:** external_id, store_name, addr, city, state, zip (geocode on save; show the formatted
   result and suggestions on a 422), pa (read-only), dma, venue_type, source_date (read-only).
2. **Contacts:** onsite_contact_name, onsite_contact_phone, owner_name, owner_phone, owner_email,
   best_contact_time, preferred_language.
3. **Installation:** products_to_avoid, installation_notes, cms_details_added, outlet_status.
4. **Site notes (comments group):** preferred_area, ceiling_type, ceiling_height, nearest_power_outlet,
   ethernet_route, blocked_dates_notes, preferred_install_datetime.
5. **Site checklist (tri-state checkboxes):** spot_visible, power_within_6ft, ethernet_possible,
   low_volume_audio_ok, ceiling_suitable.
6. **Screens:** committed counts (editable, labelled "committed") shown next to the actual counts derived from the
   rows (Dolphin screens = rows with `is_dolphin_screen`, store TVs = the rest), then the screen rows (§4) with an
   "Add screen (+)" button.
7. **Progress:** installer_name, additional_task, comment (unchanged behaviour).
8. **Other imported data:** the `fields` map, read-only.
9. **Pictures:** image_url, last; each link is previewed as an image under the field (Google Drive and Dropbox
   share links are turned into their image forms; a link that is not an image falls back to a plain link).

The registry (`domain/validation.py`) keeps sheet order for the CSV export; only the modal reorders the groups.

---

## 4. Screens and status

### 4.1 Screen row

```
Screen = {
  id: str (uuid, server-minted),
  stick_number: str,            # from "Stick Number" (comma-separated list in the sheet)
  venue_id: str,                # from "Venue ID" (comma-separated list, aligned with stick numbers); the "DD code"
  screen_size: str,             # free text ("24in"); empty on import
  is_dolphin_screen: bool,      # default true
  has_mount: bool,              # default false
  has_ceiling_mount: bool,      # default false; false means wall mount, the default
  status: ScreenStatus,         # §4.2
}
```

Import builds the rows: split "Stick Number" and "Venue ID" on commas, strip, zip them (pad the shorter list);
if both are empty use `max(1, parsed "No of Sticks")` rows with empty identifiers ("Only 1 Stick" parses as 1).
Every imported row takes the sheet's status (§4.3). A store always has ≥ 1 screen row.

The planner edits screens through `PUT /projects/{id}/stores/{uid}/screens` (full replace of the list, each row
validated, ids preserved when sent back). Adding a row defaults to `Upcoming`, dolphin screen, wall mount.

### 4.2 Status enum (replaces v1's four values)

`Upcoming` (default) · `Invitation Email Sent` · `Shipped` · `Delivered` · `Completed` · `Offline` · `Archived` ·
`Cancelled`.

**Pending set** (store still needs a technician visit, so it is routed): `Upcoming`, `Invitation Email Sent`,
`Shipped`, `Delivered`. `Offline` is not routed; it shows in a separate KPI.

**Derived store status** = the least-progressed screen, using this precedence (first match wins):
`Upcoming` → `Invitation Email Sent` → `Shipped` → `Delivered` → `Offline` → `Completed` → `Archived` → `Cancelled`.
So a store with one Completed and one Upcoming screen is Upcoming; Completed + Cancelled is Completed; all
Cancelled is Cancelled. The derived value is stored on the stop as `status` (recomputed on every screen write) so
filters, KPIs, routing and the map keep reading one attribute.

### 4.3 Sheet status aliases (case-insensitive, after trim)

| Sheet value(s) | Status |
|----------------|--------|
| completed, complete, installed, done | Completed |
| technician, upcoming, incomplete, pending, scheduled, (blank) | Upcoming |
| invitation email sent, invited, invitation sent | Invitation Email Sent |
| shipped | Shipped |
| delivered | Delivered |
| offline | Offline |
| archived | Archived |
| cancelled, canceled | Cancelled |

Precedence between the two sheet columns: `STATUS` first; if it is blank, `Shipment / Device status`. Unknown
values default to Upcoming and are flagged in the review step exactly as today (`status_valid=false`).

### 4.4 Migration from v1 statuses

`Incomplete` → Upcoming, `Complete` → Completed, `Technical Issue` → Offline (the original value is appended to
`comment`), `Other` → Upcoming with the comment kept. Each v1 stop
becomes one screen row with `venue_id = venue_code`. `external_id` = v1 `venue_code` when present, otherwise
`LEGACY-<display_id>` (**assumption**).

---

## 5. Filters, map, KPIs

**Filters** on the Stores tab and the map, in this order: Status, Installer, PA, State, City, DMA, Venue type,
DD code (`screens[].venue_id`), Screen size (`screens[].screen_size`). A filter is disabled (greyed, with "no
values") when no store in the project has a value for it. `GET /projects/{id}/stores/filters` returns the distinct
values per filter so the UI can grey out without loading every store.

**Map panel:** next to the map, a bar chart "Top states by upcoming installs" (stores whose derived status is in
the pending set, grouped by `state`, top 10). Clicking a bar sets the State filter to that state; the map and the
table show only that state, every other active filter is kept, and the bar stays highlighted. Clicking it again
clears the State filter. Served by `GET /projects/{id}/stores/by-state?pending=true`.

**KPIs** (project card and project header):
- stores by derived status (all eight) and the pending total;
- screens by status (sum over screen rows);
- committed totals (`committed_dolphin_screens`, `committed_store_tvs`) next to actual totals derived from screen
  rows (Dolphin = rows with `is_dolphin_screen`, store TVs = the rest), per project and per store.

---

## 6. Import mapping for the sample sheet

Header → field, after `normalize_column` (`IBC#` → `ibc`, `Store Address` → `store_address`, etc.). Columns not
listed land in `fields` under their normalised header.

| Normalised header | Field |
|-------------------|-------|
| ibc, ibc_number, external_id, id | external_id |
| store_name, store, site_name, name | store_name |
| store_address, address, addr, street_address | addr (city/state/zip parsed out when the City/State/Zip columns are empty) |
| city / state / zip, zipcode, postal_code | city / state / zip |
| latitude, lat / longitude, lng, long | lat / lng |
| pa, pa_name, principal_agent | pa |
| dma, dma_name, market | dma |
| venue_type, venue, site_type | venue_type |
| date | source_date |
| status | screen status (§4.3) |
| shipment_device_status | screen status fallback |
| technician | installer_name |
| no_of_sticks, number_of_sticks | screen row count fallback |
| stick_number, stick_numbers | screens[].stick_number (comma list) |
| venue_id, venue_ids, dd_code | screens[].venue_id (comma list) |
| store_owner_name, owner_name | owner_name |
| store_owner_number, owner_phone, owner_number | owner_phone |
| store_owner_email, owner_email | owner_email |
| on_site_contact_name, onsite_contact_name | onsite_contact_name |
| on_site_contact_phone, onsite_contact_phone | onsite_contact_phone |
| outlet_status | outlet_status |
| best_contact_time | best_contact_time |
| preferred_language | preferred_language |
| how_many_screens_does_store_want | committed_dolphin_screens (int; blank → null) |
| how_many_tvs_are_in_the_store | committed_store_tvs (int; blank → null) |
| preferred_area_in_store | preferred_area |
| spot_visible_from_most_of_store | spot_visible (tri-state) |
| power_outlet_within_6_ft_of_install_spot | power_within_6ft |
| can_ethernet_be_run_to_install_spot | ethernet_possible |
| is_low_volume_audio_acceptable | low_volume_audio_ok |
| is_ceiling_suitable_for_mounting | ceiling_suitable |
| ceiling_type | ceiling_type |
| approx_ceiling_height | ceiling_height |
| nearest_power_outlet | nearest_power_outlet |
| ethernet_cable_route | ethernet_route |
| store_ssid | store_ssid |
| store_ssid_password | store_ssid_password |
| account_program_pictures_image_url, image_url | image_url |
| blocked_dates_notes | blocked_dates_notes |
| preferred_install_date_time | preferred_install_datetime |
| products_content_to_avoid | products_to_avoid |
| installation_comments, installation_notes | installation_notes |
| cms_details_added | cms_details_added (TRUE/FALSE) |

The review step shows the detected mapping and lets the user re-point a column before saving; the mapping used
is stored on the project (`import_mappings`, by normalised header) so the next sheet of the same shape maps the
same way without asking.

Rows with a `Latitude`/`Longitude` are still geocoded to validate the address, but when geocoding fails the sheet
coordinates are kept and the row is marked `needs_review` rather than `invalid` (**assumption**: the sheet's
coordinates are trustworthy enough to place a pin).

---

## 7. Decisions (answered by the user, 2026-10-16)

| # | Question | Decision |
|---|----------|----------|
| 1 | Committed screen counts editable in the planner? | **Editable.** The actual counts are always derived by summing the screen rows and shown beside the committed values. |
| 2 | Does `Offline` put a store back on a route? | **No.** |
| 3 | Migration of v1 `Technical Issue` | **→ Offline.** The v1 sheets rarely carry that value. |
| 4 | "DD code" filter source | **`screens[].venue_id`.** |
| 5 | `external_id` editable in the planner? | **No.** Set on import only; fix typos by re-importing. |
| 6 | New screen rows default to `is_dolphin_screen = true`? | **Yes.** |
