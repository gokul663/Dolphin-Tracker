# Route Planner + servicing visits — high-level plan

Status: **draft for approval** (2026-11-06). Detailed plan and code come after this is agreed.

## 1. What the user asked for

1. Split the app in two: **Projects** (Home → project list → a project's stores/map/settings) and a separate
   **Route Planner**. A route can cover stores from several projects (e.g. everything pending in one state).
2. Planning flow: *Plan a Route* → choose installers → give each one a starting location → set stops per day
   (e.g. 10); extra stores roll into later days, and more stores can be added later → set a start date.
   At the end of each day a **Plan next day** button recalculates the rest, with a new date and start location.
3. Projects view colours stores that are **in a route** and stores that have been **serviced** (from the
   servicing history).
4. On site, the installer fills in the **New Log Entry** form (the screenshot from offline.dolphin-one.com). The
   other sheet columns show beside it as a read-only side panel.

## 2. Decisions (user, 2026-11-06)

| Topic | Decision |
|---|---|
| Servicing history | Tracker stores visits itself. The offline portal (offline.dolphin-one.com) **has no API**, so there is nothing to read from it; history is Tracker-only. The servicing logic may move to the offline portal later, so visits stay behind their own service + repository, which can be swapped. |
| Visit vs status | **Separate.** A visit only records that someone went there. It never changes a screen's status: a visit can end with the issue unfixed. Status is still set in the store modal. |
| Visit level | **One visit per stick** (screen row). Store-level and address-level visits are a later to-do (§10). |
| Installers, Dolphin managers | Pick from a list; a name not in the list can be typed and is **added** to it. One global list each. |
| Categories | Nine categories, each holding the offline-fix reasons as subcategories (§5). Overlapping reasons are all **kept**. |
| Who logs visits | **Dolphin managers**, not installers. The form is desktop-first and still usable on a phone. |
| Contacts on the form | Owner name, phone, email **and** store contact name, phone. They are **locked**; one **Edit** button above the whole contact area unlocks it, so a change is deliberate. A saved change updates the store. |
| Optimizer edges | **Approved:** each cluster goes to the installer whose start is nearest; day 1 is ordered from the installer's start (§7). |
| New status | **Serviced - Needs More Work** joins the per-stick status list (§6). |
| Per-project Routes tab | **Removed.** Routes exist only in the Route Planner. A project shows which of its stores are in a plan and links to that plan. |
| Start location | **One per installer** (home or hotel), editable on every *Plan next day*. |
| Next day's start | The *Plan next day* dialog asks. It **defaults to the installer's last visited stop**, and the planner can type a new address. |

## 3. Concepts

- **Route plan:** a named plan with a start date, a stops-per-day cap (1–50) and its installers, each with a
  start location. It has a **pool** of stores from any project and the **days** built from that pool.
- **Plan day:** a date. For each installer it holds an ordered list of stops. Day 1 is the start date; each
  *Plan next day* creates the next one.
- **Visit:** one submitted log entry, the form in the screenshot, for **one stick** (one screen row: one DD code
  and one stick number). A store with three sticks gets three visits. A visit records the route plan and day when
  it was made from a plan. It does not change status.
- **In route:** the store is in the pool of an active plan and has no visit on that plan yet.
- **Status vs visits.** Status is per stick and is set by hand (the store shows its least-progressed stick).
  Visits are a separate record. *Serviced* is **not** a status; it is the visit overlay described in §6.

A store can be in **one active plan at a time** (enforced on write), so two plans never send two installers.

## 4. The flow

**Plan a Route (wizard)**
1. **Stores:** a cross-project map and table filtered by State, City, Project, Status, PA and DMA. Pending
   stores are preselected; stores already in another active plan are shown but locked, with a link to it.
2. **Installers:** pick from a global installer list (or type a new name). One row per installer.
3. **Start locations:** an address with autocomplete for each installer, or a click on the map.
4. **Stops per day** (default 10) and **start date**.
5. **Preview:** days per installer on the map, with miles per day. Create the plan.

**Running a plan (plan page)**
- Tabs per installer → day cards. The current day is highlighted; later days are a forecast.
- Each stop opens the **visit form**. Submitting it marks the stop visited. A stop can also be **skipped**
  with a reason, so it goes back to the pool.
- **Add stores:** go back to the store picker. New stores join the pool and the forecast days are rebuilt
  (days already started are left alone).
- **Plan next day:** a dialog with the date (defaults to the next working day) and, per installer, a start
  location (defaults to their last visited stop) and an optional new cap. Unvisited stops from the day being
  closed go back to the pool. The remaining pool is re-optimised from the new starts, and the result becomes
  the new current day plus forecast.
- **Close plan:** the remaining stores leave the pool and lose the *in route* colour.

Everything the Routes tab does today moves here, so nothing is lost: reassign with confirmation, rebalance,
Google Maps route links, copy addresses, per-day and full CSV export, per-installer totals, stop comments.

## 5. Visit form

Laid out like the screenshot. Prefilled where the Tracker already has the value:

| Form field | Source | Editable |
|---|---|---|
| Date | today, or the plan day | yes |
| DD_Code | the stick's `venue_id`. The stop shows one row per stick; each opens its own form | no |
| Venue Name | the screen's CMS name if present, otherwise blank | yes |
| Store name, Address | store | no (edit on the store) |
| PA, FA | store `pa` → project PA; project FA | no |
| Installer | plan installer; pick from the list or type a new name (added to the list) | yes |
| Stick number | the screen's `stick_number` | yes |
| Dolphin Manager | new; pick from the list or type a new name (added to the list) | yes |
| Network type | new: WiFi / Ethernet / LTE | yes |
| Latest APK, Set Kiosk Mode | new: Yes / No | yes |
| Category → Subcategory, Detailed comments | new; the lists below | yes |
| **Contacts** (locked, one Edit button for the group): Owner name, Owner phone, Owner email, Store contact name, Store contact phone | store `owner_*` and `onsite_contact_*` (the sheet's "On-site Contact", labelled **Store contact**) | only after **Edit**; saving updates the store |

**Categories and subcategories.** The categories are the offline portal's nine. The 48 offline-fix reasons
(user, 2026-11-06) are their subcategories. They are kept exactly as given, so they match the portal's
values. The grouping is **my proposal; please check the rows marked †**. Both lists can be edited in Settings.

| Category | Subcategories |
|---|---|
| Network Issues | Modem need to be replaced · Store Wifi changed · Wifi Disconnects itself · Weak WIFI Connection · Unplugged & WiFi Password issue † |
| Power Issues | screen was unplugged · Power disconnected · Power Supply issue · Wasn't plugged in properly · Usb cord was removed · Turned off · TV Off |
| Stick / Device Issues | Old android box · Player keep Rebooting · Screen in recovery mode · TMV not working · android crash · Stick Replaced With · Stick Replace & Shift · Old Stick Missing · TMV stick replaced · stick was loose |
| Display Issues | Screen display not working · Screen malfunction · Screen Error · No Signal Issue † · HDMI cable faulty · Loose cable connect † · screen replaced with · Screen & Stick replaced † |
| Configuration | Home screen † · TMV updated · TMV & APK updated |
| Store Issues | Permanently closed · Temporarily closed · Store closed · Renovation process · Owner Changed · Owner Changed Store · Dont want screen · Owner wants the screen · Payment issue |
| Removal | Removed · Reallocated Screen · Moved to another location · Missing Screen † |
| Issue Not Resolved (Follow-up Required) | screen was not fixed |
| Other | New screen Added † |

† Could fit elsewhere:
- **Unplugged & WiFi Password issue:** Network, or Power?
- **No Signal Issue:** the TV shows "No Signal", so Display; or Network?
- **Loose cable connect:** Display, or Power?
- **Screen & Stick replaced:** Display, or Stick?
- **Home screen:** the device sits on its home screen instead of the content (kiosk mode), so Configuration.
- **Missing Screen:** Removal, or Display?
- **New screen Added:** Other, or Display?

**"Replaced with" reasons** (screen replaced with, Stick Replaced With) show an extra "Replaced with" box, so the
new stick or screen number is recorded in its own field.

A **read-only side panel** shows everything else the store has: WiFi first, then site notes, the checklist,
and "Other imported data". On a narrow screen it becomes a collapsible section under the form.

The store modal gains a **Servicing history** section: a timeline of visits, newest first, grouped by stick.

## 6. Projects view colours and the new status

**New status: Serviced - Needs More Work** (stored with a plain hyphen). It is a per-stick value, set by hand like every other status: a
visit never sets it. It is in the **pending set**, so the stick still gets routed. In the derived store status
it sits right after Delivered:
`Upcoming → Invitation Email Sent → Shipped → Delivered → Serviced - Needs More Work → Offline → Completed →
Archived → Cancelled`. Sheet aliases: "needs more work", "Serviced. Needs More Work". `STORE-MODEL.md` §4.2–4.3 updated.

**Overlays.** Map pins and table rows get overlays on top of the status colours:
- **In route:** the store is in an active plan. The tooltip shows the plan and day, with a link.
- **Visited:** every stick has a visit. Hovering shows the last visit date.
- **Partly visited:** some sticks have a visit, others not.

There are filters for all three, so you can show "not visited, not in a route". The colours are a design
choice to make with the status palette (Round 2 question 10).

## 7. Data and API (sketch; the detailed plan will pin it down)

Same single table, same thin router → service → repository layers.

| Item | PK | SK | Notes |
|---|---|---|---|
| Route plan | `ROUTEPLAN#<id>` | `META` | name, start date, cap, installers + starts, current day, status (active/closed); `GSI1PK=ROUTEPLAN` lists plans |
| Plan stop | `ROUTEPLAN#<id>` | `STOP#<project_id>#<uid>` | snapshot (name, address, lat/lng, state), installer, day, date, seq, state (pool/planned/visited/skipped) |
| Visit | `PROJECT#<id>` | `VISIT#<uid>#<screen id>#<iso ts>` | the form fields, stick number and DD code at visit time, plan id/day |
| Lists | `LIST#<installers\|managers\|categories>` | `ITEM#<value>` | the select lists; typing a new installer or manager adds an item |
| Store (existing) | `PROJECT#<id>` | `STOP#<uid>` | **adds** `route_plan_id` + `last_planned_at` (for *in route* and the visit window) and `screen_visits` + `last_visit_at` (per-stick visit times); a conditional write keeps one active plan per store. The overlay tooltip shows the plan's name (not its day, which changes on every replan) |

- **Cross-project pool query (as built, RP4):** no new index. The search reads each project's stores (a few
  projected attributes) and filters in memory, then pages with an offset cursor. That keeps every store write
  unchanged and is fine for thousands of stores; a GSI on `state` is the next step if it is ever slow.
- **API (as built):** `GET/POST /route-plans`, `POST /route-plans/preview`, `GET/PATCH /route-plans/{id}`,
  `POST /route-plans/{id}/stores`, `DELETE /route-plans/{id}/stops/{project}/{uid}`,
  `POST /route-plans/{id}/stops/{project}/{uid}/reassign`, `POST /route-plans/{id}/next-day`,
  `POST /route-plans/{id}/close`, `GET /store-search` (+ `/pins`, `/facets`),
  `GET/POST /projects/{id}/stores/{uid}/visits`, `/lists/{installers|managers}`, `/lists/categories`.
  Plans are rebuilt inside the request (≤ 2000 stores), not as worker jobs.
- **Day sizes.** The optimizer splits a batch evenly under the cap (23 stores at 10 a day → 8, 8, 7). That is the
  same number of days as filling each day to 10, just balanced.
- **Reassign** moves a stop to another installer on the same day; both days are reordered.

**Optimizer.** The clustering, day batching and 2-opt code stays unchanged. Two small changes at its edges
(**approved 2026-11-06**):
1. **Matching clusters to installers.** Today clusters are handed to installers in list order. With home
   bases, each cluster should go to the installer whose start is nearest (a small matching step).
2. **Day 1 starts from the installer's start.** Day 1 is ordered from that start point, using the
   `anchor` the optimizer already supports.

**Existing project routes.** A one-off migration turns each project's current routing (installer/day/seq) into
an active route plan, so ongoing work is not lost. The project-level `installers` and `stops_per_day` settings
move to plans.

## 8. Phases

| Phase | Content |
|---|---|
| P1 | Backend: route plan + plan stop items, the GSI, the pool search, create/preview/next-day/add/skip/close, one-plan-per-store guard, optimizer edge changes. Tests with fakes. |
| P2 | Frontend: Route Planner nav entry, wizard, plan page (installer tabs, day cards, Plan next day, Add stores), carry-over of every Routes tab feature. |
| P3 | Visit form (one per stick), side panel, visits API, servicing history in the store modal, the installer / manager / category lists. |
| P4 | Projects view colours + filters; remove the Routes tab; migrate existing project routes to plans. |

## 9. Open questions

1. **Category grouping:** check the † rows in §5.
2. **Overlay window:** does "Visited" count any visit ever, or only visits since the store's latest plan
   started? Default if unanswered: since the latest plan (ever, if the store was never in a plan), so a store
   that is planned again does not look done already.

## 10. To-do later (not in this round)

- **Store-level and address-level visits.** Besides the per-stick visit, record a visit at the store level and at
  the address level. Then, if a store changes its name (or owner), we can still tell that we have already been to
  that location. Needs a normalised-address key shared across stores and projects.
- **Moving servicing to the offline portal.** If that happens, the visit service is the one place to change.
- **Old offline portal logs.** With no API, past logs could only come in through a one-off CSV export, if the
  portal can produce one.
