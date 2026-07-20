"""
Atlanta Route Planner — HTML Generator
=======================================
Reads the Excel file, runs geo-balancing + route optimisation,
and writes index.html — a fully standalone file that
opens in any browser with no server needed.

Usage:
    python generate_route_planner.py

Output:
    route_planner.html

Requirements:
    pip install pandas openpyxl
"""

import math
import json
from pathlib import Path

import pandas as pd

# ── CONFIG ────────────────────────────────────────────────────────────────
# Default input path (common local location). If your file lives elsewhere,
# either update this value or pass a path when calling `resolve_input_file`.
INPUT_FILE  = "data/DSB_ACTIVE_LIST_2026_with_store_names.xlsx"  # put the Excel file here, or same folder as this script
OUTPUT_FILE = "index.html"

STOPS_PER_DAY = 9
TECHS         = ["Murugan", "Abubaker", "Xak"]

REGION_MAP = {
    "Murugan":  "Central Atlanta",
    "Abubaker": "North/East Atlanta",
    "Xak":      "South/West Atlanta",
}


def resolve_input_file(path: str) -> str:
    """Find the Excel file from the configured path or common local/upload locations."""
    candidates = [
        Path(path),
        Path(Path(path).name),
    # also check repo-local api/data and api/ locations where sample files often live
    Path('api') / Path(Path(path).name),
    Path('api') / 'data' / Path(Path(path).name),
        Path("/mnt/data/DSB_ACTIVE_LIST_2026_with_store_names(1).xlsx"),
        Path("/mnt/data/DSB_ACTIVE_LIST_2026_with_store_names.xlsx"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    raise FileNotFoundError(
        "Could not find the Excel input file. Expected one of: "
        + ", ".join(str(p) for p in candidates)
    )


# ── HELPERS ───────────────────────────────────────────────────────────────
def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 3958.8
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def esc(v) -> str:
    """Escape a value for embedding inside a JS single-quoted string."""
    return (str(v) if v is not None else "") \
        .replace("\\", "\\\\") \
        .replace("'",  "\\'") \
        .replace("\n", " ") \
        .replace("\r", "")


# ── STEP 1 — LOAD & CLEAN ─────────────────────────────────────────────────
def load_data(path: str) -> pd.DataFrame:
    df = pd.read_excel(path, engine="openpyxl")
    df.columns = df.columns.str.strip()

    df["lat"] = pd.to_numeric(df["input_lat"],    errors="coerce").fillna(
                pd.to_numeric(df["business_lat"], errors="coerce"))
    df["lng"] = pd.to_numeric(df["input_lng"],    errors="coerce").fillna(
                pd.to_numeric(df["business_lng"], errors="coerce"))

    df = df.dropna(subset=["lat", "lng"]).copy()
    df["CITY"]       = df["CITY"].astype(str).str.strip().str.title()
    df["ZIPCODE"]    = df["ZIPCODE"].astype(str).str.strip().str.zfill(5)
    df["store_name"] = df["store_name"].fillna(df["Brand"]).fillna("Unknown")
    df["id"]         = df["ARA/PBA NUMBER"].astype(str).str.strip()
    df["addr"]       = df["ARA/PBA STORE ADDRESS (A)"].astype(str).str.strip()
    df["state"]      = df.get("STATE", pd.Series(["GA"] * len(df))).fillna("GA")
    df["brand"]      = df["Brand"].fillna("").astype(str)
    df["geocoded"]   = df.get("geocoded_address", pd.Series([""] * len(df))).fillna("")
    df["place_types"]= df.get("place_types",      pd.Series([""] * len(df))).fillna("")
    df.reset_index(drop=True, inplace=True)
    print(f"  Loaded {len(df)} locations with valid coordinates.")
    return df


# ── STEP 2 — BALANCED GEO ASSIGNMENT ─────────────────────────────────────
def balanced_kmeans(df: pd.DataFrame, k: int = 3, max_iter: int = 40) -> list:
    n      = len(df)
    target = n // k
    points = list(zip(df["lat"], df["lng"]))

    centroids = [
        (33.98, -84.50),   # NW / West  → Murugan
        (34.07, -83.84),   # NE         → Abubaker
        (33.49, -84.32),   # South      → Xak
    ]
    assignments = [0] * n

    for _ in range(max_iter):
        dists = [[haversine(p[0], p[1], c[0], c[1]) for c in centroids]
                 for p in points]

        order = sorted(range(n),
                       key=lambda i: dists[i][sorted(range(k),
                           key=lambda c: dists[i][c])[0]]
                           - dists[i][sorted(range(k),
                           key=lambda c: dists[i][c])[-1]])

        counts, new_asgn = [0] * k, [-1] * n
        for i in order:
            ranked = sorted(range(k), key=lambda c: dists[i][c])
            for c in ranked:
                if counts[c] < target + (n % k):
                    new_asgn[i] = c; counts[c] += 1; break
            if new_asgn[i] == -1:
                c = min(range(k), key=lambda c: counts[c])
                new_asgn[i] = c; counts[c] += 1

        if new_asgn == assignments:
            break
        assignments = new_asgn

        for c in range(k):
            pts = [points[i] for i in range(n) if assignments[i] == c]
            if pts:
                centroids[c] = (sum(p[0] for p in pts) / len(pts),
                                sum(p[1] for p in pts) / len(pts))

    return assignments


def assign_technicians(df: pd.DataFrame) -> pd.DataFrame:
    labels   = balanced_kmeans(df)
    tech_map = {0: "Murugan", 1: "Abubaker", 2: "Xak"}
    df["installer"]       = [tech_map[l] for l in labels]
    df["assigned_region"] = df["installer"].map(REGION_MAP)
    return df


# ── STEP 3 — ROUTE OPTIMISATION ──────────────────────────────────────────
def route_len(route: list) -> float:
    if len(route) < 2:
        return 0.0
    return sum(
        haversine(route[k-1]["lat"], route[k-1]["lng"],
                  route[k]["lat"],   route[k]["lng"])
        for k in range(1, len(route))
    )


def geo_center(rows: list) -> tuple:
    return (
        sum(r["lat"] for r in rows) / len(rows),
        sum(r["lng"] for r in rows) / len(rows),
    )


def nn_best_start(locs: list) -> list:
    if len(locs) <= 2:
        return locs[:]
    best_route, best_len = None, float("inf")
    for start in range(len(locs)):
        unvisited = list(range(len(locs)))
        route_idx = [start]
        unvisited.remove(start)
        while unvisited:
            last = route_idx[-1]
            nxt  = min(unvisited, key=lambda i: haversine(
                locs[last]["lat"], locs[last]["lng"],
                locs[i]["lat"],    locs[i]["lng"]))
            route_idx.append(nxt)
            unvisited.remove(nxt)
        candidate     = [locs[i] for i in route_idx]
        candidate_len = route_len(candidate)
        if candidate_len < best_len:
            best_len   = candidate_len
            best_route = candidate
    return best_route


def two_opt(route: list, max_passes: int = 50) -> list:
    if len(route) <= 3:
        return route[:]
    best     = route[:]
    best_len = route_len(best)
    for _ in range(max_passes):
        improved = False
        for i in range(1, len(best) - 2):
            for j in range(i + 1, len(best) - 1):
                candidate     = best[:i] + best[i:j+1][::-1] + best[j+1:]
                candidate_len = route_len(candidate)
                if candidate_len + 1e-6 < best_len:
                    best, best_len, improved = candidate, candidate_len, True
        if not improved:
            break
    return best


def dist_row(a: dict, b: dict) -> float:
    return haversine(a["lat"], a["lng"], b["lat"], b["lng"])


def dist_anchor_to_row(anchor: dict | None, row: dict) -> float:
    if anchor is None:
        return 0.0
    return haversine(anchor["lat"], anchor["lng"], row["lat"], row["lng"])


def route_len_with_anchor(anchor: dict | None, route: list) -> float:
    if not route:
        return 0.0
    return route_len(route) + dist_anchor_to_row(anchor, route[0])


def nn_from_anchor(locs: list, anchor: dict | None = None) -> list:
    """Nearest-neighbour route that starts near the previous day's endpoint."""
    if len(locs) <= 2:
        if anchor is None or len(locs) <= 1:
            return locs[:]
        return sorted(locs, key=lambda r: dist_anchor_to_row(anchor, r))

    # First day: test every possible start. Later days: start closest to previous end.
    if anchor is None:
        return nn_best_start(locs)

    unvisited = locs[:]
    first = min(unvisited, key=lambda r: dist_anchor_to_row(anchor, r))
    route = [first]
    unvisited.remove(first)

    while unvisited:
        last = route[-1]
        nxt = min(unvisited, key=lambda r: dist_row(last, r))
        route.append(nxt)
        unvisited.remove(nxt)
    return route


def optimize_stop_order(day: list) -> list:
    return two_opt(nn_best_start(day))


def optimize_stop_order_from_anchor(day: list, anchor: dict | None) -> list:
    """Optimize a day's stops while keeping its first stop close to anchor."""
    if not day:
        return []
    if anchor is None:
        return optimize_stop_order(day)
    return two_opt(nn_from_anchor(day, anchor))


def schedule_continuity_miles(days: list) -> float:
    """Miles between previous day end and next day start, excluding in-day driving."""
    total = 0.0
    for i in range(1, len(days)):
        if days[i - 1] and days[i]:
            total += dist_row(days[i - 1][-1], days[i][0])
    return total


def total_schedule_miles(days: list) -> float:
    """In-day route miles plus day-to-day transition miles."""
    return sum(route_len(d) for d in days) + schedule_continuity_miles(days)


def order_days_for_continuity(day_clusters: list) -> list:
    """
    Reorder the daily clusters so Day N+1 starts near Day N's final stop.
    This prevents the same technician from jumping north/south/east/west across days.
    """
    clusters = [c[:] for c in day_clusters if c]
    if len(clusters) <= 1:
        return [optimize_stop_order(c) for c in clusters]

    best_days = None
    best_score = float("inf")

    # Try every cluster as Day 1, then greedily chain the next closest day.
    for start_idx in range(len(clusters)):
        remaining = list(range(len(clusters)))
        remaining.remove(start_idx)

        first_day = optimize_stop_order(clusters[start_idx])
        candidate_days = [first_day]
        anchor = first_day[-1] if first_day else None
        score = route_len(first_day)

        while remaining:
            best_next = None
            for idx in remaining:
                route = optimize_stop_order_from_anchor(clusters[idx], anchor)
                jump = dist_anchor_to_row(anchor, route[0]) if route else 0.0
                candidate_score = jump + route_len(route)
                if best_next is None or candidate_score < best_next[0]:
                    best_next = (candidate_score, idx, route, jump)

            _, idx, route, jump = best_next
            candidate_days.append(route)
            score += jump + route_len(route)
            anchor = route[-1] if route else anchor
            remaining.remove(idx)

        if score < best_score:
            best_score = score
            best_days = candidate_days

    return best_days


def split_sizes(n: int, per_day: int) -> list:
    num_days = math.ceil(n / per_day)
    base, extra = n // num_days, n % num_days
    return [base + 1 if i < extra else base for i in range(num_days)]


def farthest_first_seeds(rows: list, k: int) -> list:
    if k <= 0:       return []
    if k >= len(rows): return rows[:]
    c_lat, c_lng = geo_center(rows)
    first  = max(rows, key=lambda r: haversine(c_lat, c_lng, r["lat"], r["lng"]))
    seeds  = [first]
    while len(seeds) < k:
        nxt = max(rows, key=lambda r: min(
            haversine(r["lat"], r["lng"], s["lat"], s["lng"]) for s in seeds))
        if nxt["id"] in {s["id"] for s in seeds}:
            break
        seeds.append(nxt)
    return seeds


def assign_to_capacity_clusters(rows: list, centers: list, sizes: list) -> list:
    k = len(centers)
    remaining = sizes[:]
    clusters  = [[] for _ in range(k)]
    ranked    = []
    for r in rows:
        d     = [haversine(r["lat"], r["lng"], c[0], c[1]) for c in centers]
        order = sorted(range(k), key=lambda i: d[i])
        margin = (d[order[1]] - d[order[0]]) if k > 1 else 999
        ranked.append((margin, r, order))
    ranked.sort(key=lambda x: x[0], reverse=True)
    for _, r, order in ranked:
        placed = False
        for ci in order:
            if remaining[ci] > 0:
                clusters[ci].append(r); remaining[ci] -= 1; placed = True; break
        if not placed:
            ci = min(range(k), key=lambda x: len(clusters[x]))
            clusters[ci].append(r)
    return clusters


def capacity_kmeans_day_clusters(rows: list, per_day: int = STOPS_PER_DAY,
                                  max_iter: int = 35) -> list:
    if not rows:          return []
    if len(rows) <= per_day: return [rows[:]]
    sizes    = split_sizes(len(rows), per_day)
    k        = len(sizes)
    seeds    = farthest_first_seeds(rows, k)
    centers  = [(s["lat"], s["lng"]) for s in seeds]
    last_sig = None
    clusters = None
    for _ in range(max_iter):
        clusters = assign_to_capacity_clusters(rows, centers, sizes)
        sig = tuple(tuple(sorted(r["id"] for r in c)) for c in clusters)
        if sig == last_sig: break
        last_sig = sig
        centers  = [geo_center(c) if c else centers[ci]
                    for ci, c in enumerate(clusters)]
    territory_lat, territory_lng = geo_center(rows)
    def cluster_key(cluster):
        if not cluster: return (999, 999)
        c_lat, c_lng = geo_center(cluster)
        return (math.atan2(c_lat - territory_lat, c_lng - territory_lng),
                haversine(territory_lat, territory_lng, c_lat, c_lng))
    return sorted([c for c in clusters if c], key=cluster_key)


def make_initial_day_batches(rows: list, per_day: int = STOPS_PER_DAY) -> list:
    return [optimize_stop_order(c)
            for c in capacity_kmeans_day_clusters(rows, per_day=per_day)]


def improve_day_boundaries(days: list, max_iter: int = 25) -> list:
    days = [d[:] for d in days]
    for _ in range(max_iter):
        improved = False
        for i in range(len(days) - 1):
            day_a, day_b = days[i], days[i+1]
            if len(day_a) < 2 or len(day_b) < 2: continue
            current_score = route_len(day_a) + route_len(day_b)
            best_score, best_pair = current_score, None
            cand_a = day_a[:3] + day_a[-3:] if len(day_a) > 6 else day_a
            cand_b = day_b[:3] + day_b[-3:] if len(day_b) > 6 else day_b
            for a in {x["id"]: x for x in cand_a}.values():
                for b in {x["id"]: x for x in cand_b}.values():
                    new_a = optimize_stop_order(
                        [b if x["id"] == a["id"] else x for x in day_a])
                    new_b = optimize_stop_order(
                        [a if x["id"] == b["id"] else x for x in day_b])
                    new_score = route_len(new_a) + route_len(new_b)
                    if new_score + 0.25 < best_score:
                        best_score, best_pair = new_score, (new_a, new_b)
            if best_pair:
                days[i], days[i+1] = best_pair; improved = True
        if not improved: break
    return days


def rotate_days_to_reduce_longest(days: list, max_iter: int = 15) -> list:
    days = [d[:] for d in days]
    for _ in range(max_iter):
        daily_lengths = [route_len(d) for d in days]
        if not daily_lengths: return days
        worst_idx = max(range(len(days)), key=lambda i: daily_lengths[i])
        worst_len = daily_lengths[worst_idx]
        changed   = False
        for neighbor_idx in [worst_idx - 1, worst_idx + 1]:
            if neighbor_idx < 0 or neighbor_idx >= len(days): continue
            day_w, day_n = days[worst_idx], days[neighbor_idx]
            if len(day_w) <= max(5, STOPS_PER_DAY - 2): continue
            if len(day_n) >= STOPS_PER_DAY + 1:         continue
            best_move    = None
            best_max_len = max(route_len(day_w), route_len(day_n))
            for stop in day_w:
                new_w = optimize_stop_order([x for x in day_w if x["id"] != stop["id"]])
                new_n = optimize_stop_order(day_n + [stop])
                new_max_len = max(route_len(new_w), route_len(new_n))
                if new_max_len + 0.25 < best_max_len:
                    best_max_len, best_move = new_max_len, (new_w, new_n)
            if best_move and best_max_len + 0.25 < worst_len:
                days[worst_idx], days[neighbor_idx] = best_move
                changed = True; break
        if not changed: break
    return days


def make_day_batches(rows: list, per_day: int = STOPS_PER_DAY) -> list:
    if not rows:
        return []

    # 1) Build compact daily geographic clusters.
    days = make_initial_day_batches(rows, per_day=per_day)

    # 2) Improve adjacent day boundaries so each day remains compact.
    days = improve_day_boundaries(days)
    days = rotate_days_to_reduce_longest(days)

    # 3) Most important fix: sequence the days as one continuous technician path.
    #    Day 2 now starts near Day 1's end, Day 3 near Day 2's end, etc.
    days = order_days_for_continuity(days)

    # 4) Re-run boundary balancing once after sequencing, then restore continuity.
    days = improve_day_boundaries(days)
    days = rotate_days_to_reduce_longest(days)
    days = order_days_for_continuity(days)

    return days


def day_miles(day: list) -> float:
    return round(route_len(day), 1)


def build_schedules(df: pd.DataFrame) -> dict:
    schedules = {}
    for tech in TECHS:
        sub  = df[df["installer"] == tech].to_dict("records")
        days = make_day_batches(sub, per_day=STOPS_PER_DAY)
        schedules[tech] = days
        dm   = [day_miles(d) for d in days]
        transition_mi = schedule_continuity_miles(days)
        total_mi = sum(dm)
        all_in_mi = total_schedule_miles(days)
        avg_mi   = total_mi / len(days) if days else 0
        max_mi   = max(dm) if dm else 0
        print(f"  {tech}: {len(days)} days · {len(sub)} stops · "
              f"~{total_mi:.0f} in-day mi · ~{transition_mi:.0f} transition mi · "
              f"~{all_in_mi:.0f} all-in mi · ~{avg_mi:.0f} mi/day · "
              f"max day ~{max_mi:.0f} mi")
        ranked = sorted(enumerate(dm, 1), key=lambda x: x[1], reverse=True)[:5]
        print("    Longest days:", ", ".join(f"Day {d}: {m:.1f} mi" for d, m in ranked))
    return schedules


# ── STEP 4 — BUILD JS DATA STRING ─────────────────────────────────────────
def clean_js_value(v):
    """Return a JSON-safe value for embedding in the HTML script block."""
    if pd.isna(v):
        return ""
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    return str(v)


def build_routes_js(schedules: dict) -> str:
    """
    Builds ROUTES using json.dumps instead of hand-written JavaScript.

    This is important because one unescaped character in an address/store name
    can crash the browser JavaScript and make the HTML page look completely blank.
    """
    routes = {}

    for tech, days in schedules.items():
        routes[tech] = []
        for day in days:
            clean_day = []
            for s in day:
                clean_day.append({
                    "id": clean_js_value(s.get("id", "")),
                    "addr": clean_js_value(s.get("addr", "")),
                    "city": clean_js_value(s.get("CITY", "")),
                    "state": clean_js_value(s.get("state", "GA")),
                    "zip": clean_js_value(s.get("ZIPCODE", "")),
                    "store_name": clean_js_value(s.get("store_name", "")),
                    "brand": clean_js_value(s.get("brand", "")),
                    "lat": clean_js_value(s.get("lat")),
                    "lng": clean_js_value(s.get("lng")),
                    "geocoded": clean_js_value(s.get("geocoded", "")),
                    "installer": clean_js_value(s.get("installer", tech)),
                    "assigned_region": clean_js_value(s.get("assigned_region", "")),
                })
            routes[tech].append(clean_day)

    return "const ROUTES=" + json.dumps(routes, ensure_ascii=False) + ";"


def build_stats_js(schedules: dict) -> str:
    """
    Builds ROUTE_STATS — used to populate the installer tab badges
    (e.g. '208 sites · 18 days') in the header.
    """
    stats = {}
    for tech, days in schedules.items():
        total = sum(len(d) for d in days)
        stats[tech] = {"total": total, "days": len(days)}
    return "const ROUTE_STATS=" + json.dumps(stats) + ";"


# ── STEP 5 — HTML TEMPLATE ─────────────────────────────────────────────────
# The HTML below is the exact route_planner.html structure.
# ONLY the <script> data block is injected by Python — all JS logic is
# preserved 100% as it appeared in the original file.

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Atlanta Install — Route Planner</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{{
  --bg:#0f172a;--surface:#111827;--card:#182235;--card2:#202c42;--border:#334155;
  --accent:#f97316;--accent2:#facc15;--text:#f8fafc;--muted:#cbd5e1;--soft:#94a3b8;
  --green:#22c55e;--green-dim:rgba(34,197,94,.16);--green-border:rgba(34,197,94,.45);
  --red:#fb7185;--red-dim:rgba(251,113,133,.14);--red-border:rgba(251,113,133,.42);
  --m-color:#38bdf8;--m-dim:rgba(56,189,248,.16);--m-border:rgba(56,189,248,.42);
  --a-color:#c4b5fd;--a-dim:rgba(196,181,253,.16);--a-border:rgba(196,181,253,.42);
  --x-color:#fdba74;--x-dim:rgba(253,186,116,.16);--x-border:rgba(253,186,116,.42);
}}
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{background:radial-gradient(circle at top left,rgba(56,189,248,.10),transparent 34%),radial-gradient(circle at top right,rgba(249,115,22,.10),transparent 32%),var(--bg);color:var(--text);font-family:'IBM Plex Sans',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;font-size:15px;line-height:1.45;}}
body::before{{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px);pointer-events:none;z-index:999;}}

/* HEADER */
header{{background:rgba(17,24,39,.94);backdrop-filter:blur(14px);border-bottom:1px solid rgba(249,115,22,.55);box-shadow:0 10px 28px rgba(0,0,0,.28);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:300;flex-wrap:wrap;gap:14px;}}
.logo{{font-family:'Bebas Neue',sans-serif;font-size:34px;letter-spacing:4px;color:var(--accent);line-height:1;}}
.logo span{{color:var(--text);}}
.hstats{{display:flex;gap:12px;flex-wrap:wrap;align-items:stretch;}}
.hs{{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:rgba(255,255,255,.045);border:1px solid rgba(148,163,184,.20);border-radius:12px;padding:8px 12px;min-width:86px;}}
.hs-n{{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:700;color:var(--accent2);line-height:1;}}
.hs-l{{font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--soft);text-align:center;line-height:1.2;}}

/* MAIN */
.main{{padding:22px 26px;max-width:1900px;margin:0 auto;}}

/* CONTROLS */
.controls{{background:rgba(17,24,39,.92);border:1px solid rgba(148,163,184,.22);border-radius:14px;padding:16px 18px;margin-bottom:18px;display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;box-shadow:0 10px 24px rgba(0,0,0,.18);}}
.cg label{{font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.9px;color:var(--soft);display:block;margin-bottom:6px;}}
select,input[type=text]{{background:var(--card2);border:1px solid rgba(148,163,184,.28);color:var(--text);padding:9px 12px;font-family:'IBM Plex Mono',monospace;font-size:13px;border-radius:8px;outline:none;}}
select:focus,input:focus{{border-color:var(--accent);}}
.btn{{padding:10px 14px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;cursor:pointer;border-radius:9px;border:1px solid rgba(148,163,184,.28);background:var(--card2);color:var(--muted);transition:all .15s;}}
.btn:hover{{border-color:var(--accent);color:var(--accent);}}
.btn.active{{border-color:var(--accent);color:var(--accent);background:rgba(255,95,31,.1);}}
.btn.csv{{border-color:var(--green-border);color:var(--green);}}
.btn.csv:hover{{background:var(--green-dim);}}

/* INSTALLER TABS */
.installer-tabs{{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap;}}
.itab{{padding:12px 22px;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.9px;cursor:pointer;border-radius:12px;border:1px solid rgba(148,163,184,.26);background:var(--card);color:var(--muted);transition:all .2s;box-shadow:0 6px 16px rgba(0,0,0,.14);}}
.itab:hover{{border-color:var(--accent);color:var(--accent);}}
.itab.Murugan.on{{background:var(--m-dim);border-color:var(--m-border);color:var(--m-color);}}
.itab.Abubaker.on{{background:var(--a-dim);border-color:var(--a-border);color:var(--a-color);}}
.itab.Xak.on{{background:var(--x-dim);border-color:var(--x-border);color:var(--x-color);}}
.installer-badge{{font-size:10px;padding:3px 7px;border-radius:999px;margin-left:7px;font-weight:700;}}
.badge-m{{background:var(--m-dim);border:1px solid var(--m-border);color:var(--m-color);}}
.badge-a{{background:var(--a-dim);border:1px solid var(--a-border);color:var(--a-color);}}
.badge-x{{background:var(--x-dim);border:1px solid var(--x-border);color:var(--x-color);}}

/* SECTION HEADER */
.section-header{{display:flex;align-items:center;gap:14px;margin:8px 0 14px;padding:12px 14px;border:1px solid rgba(148,163,184,.18);border-radius:12px;background:rgba(15,23,42,.66);}}
.section-title{{font-family:'Bebas Neue',sans-serif;font-size:30px;letter-spacing:3px;line-height:1;}}
.section-title.Murugan{{color:var(--m-color);}}
.section-title.Abubaker{{color:var(--a-color);}}
.section-title.Xak{{color:var(--x-color);}}
.section-meta{{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);}}

/* DAY GRID */
.day-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(430px,1fr));gap:16px;margin-bottom:26px;}}

/* DAY CARD */
.day-card{{background:linear-gradient(180deg,rgba(30,41,59,.98),rgba(15,23,42,.98));border:1px solid rgba(148,163,184,.22);border-radius:16px;overflow:hidden;transition:all .2s;box-shadow:0 12px 28px rgba(0,0,0,.24);}}
.day-card:hover{{border-color:rgba(249,115,22,.55);transform:translateY(-1px);box-shadow:0 16px 34px rgba(0,0,0,.30);}}
.day-card.Murugan{{border-top:4px solid var(--m-color);}}
.day-card.Abubaker{{border-top:4px solid var(--a-color);}}
.day-card.Xak{{border-top:4px solid var(--x-color);}}

/* DAY CARD HEADER */
.day-hdr{{background:rgba(17,24,39,.78);padding:14px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;border-bottom:1px solid rgba(148,163,184,.14);}}
.day-title{{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:2px;line-height:1;}}
.day-title.Murugan{{color:var(--m-color);}}
.day-title.Abubaker{{color:var(--a-color);}}
.day-title.Xak{{color:var(--x-color);}}
.day-meta{{display:flex;align-items:center;gap:6px;}}
.day-badge{{font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:800;padding:5px 10px;border-radius:999px;background:var(--accent);color:#111827;}}
.day-cities{{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--soft);padding:8px 16px 10px;border-bottom:1px solid rgba(148,163,184,.14);letter-spacing:.2px;}}
.toggle{{background:rgba(255,255,255,.04);border:1px solid rgba(148,163,184,.18);border-radius:8px;color:var(--muted);font-size:13px;cursor:pointer;padding:5px 8px;font-family:'IBM Plex Mono',monospace;}}
.toggle:hover{{color:var(--accent);}}

/* STOP LIST */
.stop-list{{max-height:520px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--accent) var(--card);}}
.stop-list::-webkit-scrollbar{{width:3px;}}
.stop-list::-webkit-scrollbar-thumb{{background:var(--accent);}}

/* STOP ITEM */
.stop-item{{padding:13px 16px;border-bottom:1px solid rgba(148,163,184,.14);display:flex;align-items:flex-start;gap:10px;font-size:13px;}}
.stop-item:last-child{{border-bottom:none;}}
.stop-num{{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--accent2);min-width:28px;margin-top:2px;font-weight:800;}}
.stop-body{{flex:1;min-width:0;}}
.stop-store{{font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}}
.stop-addr{{color:var(--muted);font-size:9px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}}
.stop-brand{{font-family:'IBM Plex Mono',monospace;font-size:8px;padding:1px 5px;border-radius:2px;background:rgba(255,201,71,.1);border:1px solid rgba(255,201,71,.2);color:var(--accent2);white-space:nowrap;flex-shrink:0;}}


/* INSTALL STATUS FIELDS */
.stop-item{{display:block;}}
.stop-main{{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;}}
.stop-field-grid{{display:grid;grid-template-columns:minmax(180px,1fr) 160px 170px;gap:10px;margin-top:8px;}}
.stop-field{{background:rgba(15,23,42,.82);border:1px solid rgba(148,163,184,.22);border-radius:10px;padding:10px;min-width:0;}}
.stop-field-label{{font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--soft);margin-bottom:6px;font-weight:700;}}
.stop-readonly{{font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:20px;font-weight:600;}}
.stop-readonly.comment-readonly{{white-space:pre-wrap;overflow:visible;text-overflow:clip;color:var(--muted);line-height:1.5;font-weight:400;}}
.stop-input,.stop-select,.stop-comment{{width:100%;background:#0b1220;border:1px solid rgba(148,163,184,.30);color:var(--text);border-radius:8px;font-family:'IBM Plex Mono',monospace;font-size:12px;padding:8px 10px;outline:none;}}
.stop-input:focus,.stop-select:focus,.stop-comment:focus{{border-color:var(--accent);}}
.stop-comment{{min-height:64px;resize:vertical;line-height:1.45;}}
.field-actions{{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}}
.mini-btn{{border:1px solid rgba(148,163,184,.28);background:var(--card2);color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.6px;border-radius:8px;padding:6px 9px;cursor:pointer;font-weight:800;}}
.mini-btn:hover{{border-color:var(--accent);color:var(--accent);}}
.mini-btn.save{{border-color:var(--green-border);color:var(--green);}}
.mini-btn.dots{{font-size:15px;line-height:12px;padding:5px 10px;}}
.install-row{{display:grid;grid-template-columns:175px 1fr;gap:10px;align-items:start;margin-top:10px;}}
.modem-box{{background:rgba(15,23,42,.82);border:1px solid rgba(148,163,184,.22);border-radius:10px;padding:10px;}}
.modem-check{{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);white-space:nowrap;font-weight:700;}}
.modem-check input{{accent-color:var(--accent);}}
.status-pill{{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:4px 8px;border-radius:999px;border:1px solid rgba(148,163,184,.28);color:var(--muted);display:inline-block;margin-top:8px;font-weight:800;}}
.status-complete{{border-color:var(--green-border);color:var(--green);background:var(--green-dim);}}
.status-technical{{border-color:var(--red-border);color:var(--red);background:var(--red-dim);}}
.status-other{{border-color:rgba(250,204,21,.42);color:var(--accent2);background:rgba(250,204,21,.12);}}
.stop-select[data-status="Complete"]{{border-color:var(--green-border);background:rgba(34,197,94,.10);}}
.stop-select[data-status="Technical Issue"]{{border-color:var(--red-border);background:rgba(251,113,133,.10);}}
.stop-select[data-status="Other"]{{border-color:rgba(250,204,21,.42);background:rgba(250,204,21,.10);}}
@media(max-width:700px){{.stop-field-grid,.install-row{{grid-template-columns:1fr;}}}}

/* DAY CARD FOOTER */
.day-acts{{padding:12px 16px;background:rgba(17,24,39,.82);border-top:1px solid rgba(148,163,184,.16);display:flex;gap:8px;flex-wrap:wrap;}}
.rbtn{{border:none;padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;cursor:pointer;border-radius:9px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:all .15s;white-space:nowrap;}}
.rbtn.maps-m{{background:var(--m-color);color:#0b0d10;}}
.rbtn.maps-m:hover{{opacity:.85;}}
.rbtn.maps-a{{background:var(--a-color);color:#0b0d10;}}
.rbtn.maps-a:hover{{opacity:.85;}}
.rbtn.maps-x{{background:var(--x-color);color:#0b0d10;}}
.rbtn.maps-x:hover{{opacity:.85;}}
.rbtn.sec{{background:var(--card);border:1px solid var(--border);color:var(--muted);}}
.rbtn.sec:hover{{border-color:var(--accent);color:var(--accent);}}

/* SUMMARY TABLE */
.summary-table{{width:100%;border-collapse:separate;border-spacing:0;font-family:'IBM Plex Mono',monospace;font-size:12px;margin-bottom:24px;background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.20);border-radius:14px;overflow:hidden;}}
.summary-table th{{background:rgba(17,24,39,.92);padding:11px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--soft);border-bottom:1px solid rgba(148,163,184,.22);}}
.summary-table td{{padding:10px 14px;border-bottom:1px solid rgba(148,163,184,.14);}}
.summary-table tr:hover td{{background:rgba(255,255,255,.02);}}
.day-link{{color:var(--accent);cursor:pointer;text-decoration:none;}}
.day-link:hover{{text-decoration:underline;}}

/* NO RESULTS */
#noRes{{display:none;text-align:center;padding:70px;color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:14px;}}

@media(max-width:600px){{
  .day-grid{{grid-template-columns:1fr;}}
  .hstats{{gap:10px;}}
  .hs-n{{font-size:15px;}}
}}
</style>
</head>
<body>

<header>
  <div class="logo">ATLANTA <span>ROUTE PLANNER</span></div>
  <div id="dbStatus" style="font-family:'IBM Plex Mono',monospace;font-size:10px;padding:4px 10px;border-radius:20px;background:rgba(255,255,255,.06);border:1px solid rgba(148,163,184,.2);color:var(--muted);">
    &#9679; Connecting to MongoDB…
  </div>
  <div class="hstats">
    <div class="hs"><span class="hs-n" id="hTotal">—</span><span class="hs-l">Total Sites</span></div>
    <div class="hs"><span class="hs-n" id="hComplete" style="color:var(--green)">0</span><span class="hs-l">Completed</span></div>
    <div class="hs"><span class="hs-n" id="hPending" style="color:var(--accent2)">—</span><span class="hs-l">Pending</span></div>
    <div class="hs"><span class="hs-n" id="hTechIssue" style="color:var(--red)">0</span><span class="hs-l">Tech Issue</span></div>
    <div class="hs"><span class="hs-n" id="hOther" style="color:var(--accent2)">0</span><span class="hs-l">Other</span></div>
    <div class="hs"><span class="hs-n" style="color:var(--m-color)" id="hM">0/0</span><span class="hs-l">Murugan Done/Pending</span></div>
    <div class="hs"><span class="hs-n" style="color:var(--a-color)" id="hA">0/0</span><span class="hs-l">Abubaker Done/Pending</span></div>
    <div class="hs"><span class="hs-n" style="color:var(--x-color)" id="hX">0/0</span><span class="hs-l">Xak Done/Pending</span></div>
    <div class="hs"><span class="hs-n" id="hDays" style="color:var(--accent2)">—</span><span class="hs-l">Max Days</span></div>
  </div>
</header>

<div class="main">

  <!-- CONTROLS -->
  <div class="controls">
    <div class="cg">
      <label>View</label>
      <select id="selView" onchange="applyFilters()">
        <option value="days">Day-by-Day Routes</option>
        <option value="summary">Summary Table</option>
      </select>
    </div>
    <div class="cg">
      <label>Filter Day</label>
      <input id="txtDay" type="text" placeholder="e.g. 1, 2, 3..." oninput="applyFilters()" style="width:100px">
    </div>
    <div class="cg">
      <label>Search stops</label>
      <input id="txtQ" type="text" placeholder="Address, city, store, brand..." oninput="applyFilters()" style="width:200px">
    </div>
    <div style="margin-left:auto;display:flex;gap:5px;flex-wrap:wrap;">
      <button class="btn" onclick="expandAll()">&#9660; Expand All</button>
      <button class="btn" onclick="collapseAll()">&#9650; Collapse All</button>
      <button class="btn csv" onclick="exportAllCSV()">&#8681; Export CSV</button>
    </div>
  </div>

  <!-- INSTALLER TABS (badges populated by JS from ROUTE_STATS) -->
  <div class="installer-tabs">
    <button class="itab Murugan on" onclick="selectInstaller('Murugan',this)">
      Murugan <span class="installer-badge badge-m" id="badgeM">—</span>
    </button>
    <button class="itab Abubaker" onclick="selectInstaller('Abubaker',this)">
      Abubaker <span class="installer-badge badge-a" id="badgeA">—</span>
    </button>
    <button class="itab Xak" onclick="selectInstaller('Xak',this)">
      Xak <span class="installer-badge badge-x" id="badgeX">—</span>
    </button>
    <button class="itab" style="margin-left:auto;" onclick="selectInstaller('ALL',this)">
      All Installers
    </button>
  </div>

  <!-- MAIN CONTENT -->
  <div id="mainContent"></div>
  <div id="noRes">No routes match your filter.</div>

</div>

<script>
  // ── API CONFIGURATION ────────────────────────────────────────────────────
  // Change this to point to your backend server.
  // If the HTML is served from the same origin, use a relative path: '/api'
  window.TRACKER_API_BASE = 'http://localhost:8000';
</script>

<script>
'use strict';

// ── DATA (injected by generate_route_planner.py) ──────────────────────────
{routes_js}
{stats_js}

// ── APP ───────────────────────────────────────────────────────────────────

const INSTALLER_COLORS = {{
  Murugan:  {{cls:'maps-m', color:'var(--m-color)'}},
  Abubaker: {{cls:'maps-a', color:'var(--a-color)'}},
  Xak:      {{cls:'maps-x', color:'var(--x-color)'}}
}};

let activeInstaller = 'Murugan';

// ── MONGODB STATE ─────────────────────────────────────────────────────────
// All stop statuses, comments, installer names, and modem flags are stored
// in MongoDB via the FastAPI backend (server.py).
//
// In-memory cache mirrors the DB so the UI never blocks on a network call.
// Every write goes to MongoDB immediately; reads come from the local cache.
//
// MongoDB document key-value pairs per stop
// ─────────────────────────────────────────────────────────────────────────
//  stop_key       string   "atl-route-v2|<installer>|<id>|<addr>|<lat>|<lng>"
//  store_name     string   Editable store display name
//  brand          string   Fuel brand / operator
//  installer_name string   Technician who did the install (may differ from route owner)
//  status         string   "Incomplete" | "Complete" | "Technical Issue" | "Other"
//  comment        string   Free-text field notes
//  modem          boolean  ARA modem collected?
//  updatedAt      string   ISO-8601 timestamp (set server-side on every write)
//  updatedBy      string   Technician name (optional, sent by client)
// ─────────────────────────────────────────────────────────────────────────

const API_BASE = (window.TRACKER_API_BASE || 'http://localhost:8000');
const STATUS_OPTIONS = ['Incomplete', 'Complete', 'Technical Issue', 'Other'];
const INSTALLER_NAME_OPTIONS = ['Murugan', 'Abubaker', 'Xak'];

// In-memory cache — populated from MongoDB on page load
let savedState = {{}};
let _dbReady   = false;   // true once initial load from MongoDB completes

function stopKey(s) {{
  return ['atl-route-v2', s.installer || '', s.id || '', s.addr || '',
          s.lat != null ? s.lat : '', s.lng != null ? s.lng : ''].join('|');
}}

function defaultStopState(s) {{
  return {{
    store_name:     s.store_name || s.brand || '',
    brand:          s.brand || '',
    installer_name: s.installer || '',
    status:         'Incomplete',
    comment:        '',
    modem:          false
  }};
}}

function getStopState(s) {{
  const key = stopKey(s);
  return Object.assign(defaultStopState(s), savedState[key] || {{}});
}}

// ── DB READ ───────────────────────────────────────────────────────────────
async function loadStateFromDB() {{
  showDBStatus('loading');
  try {{
    const res  = await fetch(API_BASE + '/state');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    savedState = await res.json();
    _dbReady   = true;
    showDBStatus('ok');
    updateHeaderStats();
    applyFilters();   // re-render with real data
  }} catch (err) {{
    console.error('MongoDB load failed:', err);
    showDBStatus('error', err.message);
    // Fall back to localStorage so the app still works offline
    try {{
      const ls = JSON.parse(localStorage.getItem('atl_tracker_fallback') || '{{}}');
      savedState = ls;
      updateHeaderStats();
      applyFilters();
    }} catch(_) {{}}
  }}
}}

// ── DB WRITE ──────────────────────────────────────────────────────────────
async function persistState(key, patch) {{
  // 1. Update in-memory cache immediately (UI stays snappy)
  savedState[key] = Object.assign(savedState[key] || {{}}, patch);

  // 2. Mirror to localStorage as offline fallback
  try {{
    localStorage.setItem('atl_tracker_fallback', JSON.stringify(savedState));
  }} catch(_) {{}}

  // 3. Push to MongoDB
  const body = Object.assign({{stop_key: key}}, savedState[key]);
  try {{
    const res = await fetch(API_BASE + '/state', {{
      method:  'POST',
      headers: {{'Content-Type': 'application/json'}},
      body:    JSON.stringify(body)
    }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }} catch (err) {{
    console.error('MongoDB write failed (will retry on next save):', err);
    showDBStatus('error', 'Write failed: ' + err.message);
  }}
}}

// Wraps the old synchronous API so every call site still works unchanged
function updateStopStateByKey(key, patch) {{
  savedState[key] = Object.assign(savedState[key] || {{}}, patch);
  persistState(key, patch);   // async, non-blocking
  updateHeaderStats();
}}

// ── STATUS INDICATOR ──────────────────────────────────────────────────────
function showDBStatus(state, msg) {{
  const el = document.getElementById('dbStatus');
  if (!el) return;
  const icons = {{loading: '&#9679;', ok: '&#10003;', error: '&#9888;'}};
  const colors = {{loading: 'var(--accent2)', ok: 'var(--green)', error: 'var(--red)'}};
  const labels = {{loading: 'Connecting to MongoDB…', ok: 'MongoDB connected', error: msg || 'DB error'}};
  el.style.color = colors[state] || 'var(--muted)';
  el.innerHTML   = (icons[state] || '') + ' ' + (labels[state] || '');
}}

function statusClass(status) {{
  if (status === 'Complete') return 'status-complete';
  if (status === 'Technical Issue') return 'status-technical';
  if (status === 'Other') return 'status-other';
  return '';
}}

function updateStatusPill(selectEl) {{
  const item = selectEl.closest('.stop-item');
  const pill = item ? item.querySelector('.status-pill') : null;
  if (!pill) return;
  pill.className = 'status-pill ' + statusClass(selectEl.value);
  pill.textContent = selectEl.value;
}}

function computeStatusStats() {{
  const techs = ['Murugan', 'Abubaker', 'Xak'];
  const stats = {{
    total: 0,
    complete: 0,
    pending: 0,
    technical: 0,
    other: 0,
    maxDays: 0,
    byTech: {{}}
  }};

  // Initialize counters for the CURRENT editable installer assignment.
  // The route/map grouping stays under the original route owner, but these
  // counts move when the Installer Name dropdown is changed.
  techs.forEach(t => {{
    stats.byTech[t] = {{total: 0, complete: 0, pending: 0, technical: 0, other: 0, days: (ROUTES[t] || []).length}};
    stats.maxDays = Math.max(stats.maxDays, (ROUTES[t] || []).length);
  }});

  // Walk every route stop once. Assign each stop to the editable installer_name
  // for dashboard counts. If it is missing or invalid, fall back to route owner.
  techs.forEach(routeOwner => {{
    (ROUTES[routeOwner] || []).forEach(day => {{
      day.forEach(s => {{
        const state = getStopState(s);
        const assignedInstaller = techs.includes(state.installer_name) ? state.installer_name : routeOwner;
        const st = state.status || 'Incomplete';

        stats.total++;
        stats.byTech[assignedInstaller].total++;

        if (st === 'Complete') {{ stats.complete++; stats.byTech[assignedInstaller].complete++; }}
        else if (st === 'Technical Issue') {{ stats.technical++; stats.byTech[assignedInstaller].technical++; }}
        else if (st === 'Other') {{ stats.other++; stats.byTech[assignedInstaller].other++; }}
        else {{ stats.pending++; stats.byTech[assignedInstaller].pending++; }}
      }});
    }});
  }});
  return stats;
}}

function updateHeaderStats() {{
  const s = computeStatusStats();
  const set = (id, val) => {{ const el = document.getElementById(id); if (el) el.textContent = val; }};
  set('hTotal', s.total);
  set('hComplete', s.complete);
  set('hPending', s.pending);
  set('hTechIssue', s.technical);
  set('hOther', s.other);
  set('hDays', s.maxDays);

  const hIds = {{Murugan:'hM', Abubaker:'hA', Xak:'hX'}};
  const bIds = {{Murugan:'badgeM', Abubaker:'badgeA', Xak:'badgeX'}};
  Object.keys(hIds).forEach(t => {{
    const bt = s.byTech[t];
    set(hIds[t], `${{bt.complete}}/${{bt.pending}}`);
    const badge = document.getElementById(bIds[t]);
    if (badge) badge.textContent = `${{bt.complete}} done · ${{bt.pending}} pending · ${{bt.technical}} tech · ${{bt.other}} other`;
  }});
}}

// Load all state from MongoDB on page open
loadStateFromDB();

function selectInstaller(name, btn) {{
  activeInstaller = name;
  document.querySelectorAll('.itab').forEach(b => {{
    b.classList.remove('on');
    ['Murugan','Abubaker','Xak'].forEach(i => b.classList.remove(i));
  }});
  if (btn) {{
    btn.classList.add('on');
    if (name !== 'ALL') btn.classList.add(name);
  }}
  applyFilters();
}}

// Google Maps directions URL — proper origin/destination/waypoints format.
// Google allows 8 waypoints + origin + destination in this URL format.
// For >10 stops, every later map overlaps the previous map's final stop.
// Example: Map 1 = stops 1–10, Map 2 = stops 10–19, not 11–20.
// This keeps the technician continuing from where the previous map ended.
const MAP_MAX_STOPS = 10;

function stopLabel(s) {{
  return encodeURIComponent(`${{s.addr}}, ${{s.city}}, ${{s.state}} ${{s.zip}}`);
}}

function mapsUrlForStops(stops) {{
  if (!stops.length) return '#';
  const enc = stops.map(stopLabel);
  if (enc.length === 1)
    return `https://www.google.com/maps/search/?api=1&query=${{enc[0]}}`;
  const origin = enc[0];
  const dest   = enc[enc.length - 1];
  const waypts = enc.slice(1, -1).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${{origin}}&destination=${{dest}}${{waypts ? '&waypoints=' + waypts : ''}}`;
}}

function routeChunks(stops) {{
  if (stops.length <= MAP_MAX_STOPS) return [{{start: 0, end: stops.length - 1, stops}}];
  const chunks = [];
  let start = 0;
  while (start < stops.length - 1) {{
    const end = Math.min(start + MAP_MAX_STOPS - 1, stops.length - 1);
    chunks.push({{start, end, stops: stops.slice(start, end + 1)}});
    if (end === stops.length - 1) break;
    start = end; // overlap previous destination as next origin
  }}
  return chunks;
}}

function gmRouteUrl(stops) {{
  if (!stops.length) return '#';
  return mapsUrlForStops(routeChunks(stops)[0].stops);
}}

function buildBatchUrl(stops, chunkIdx) {{
  const chunks = routeChunks(stops);
  const chunk = chunks[Math.min(chunkIdx, chunks.length - 1)] || chunks[0];
  return mapsUrlForStops(chunk.stops);
}}

function getUniqueCities(stops) {{
  const seen = new Set(), cities = [];
  stops.forEach(s => {{
    const c = s.city.trim();
    if (!seen.has(c)) {{ seen.add(c); cities.push(c); }}
  }});
  return cities;
}}

function applyFilters() {{
  const view    = document.getElementById('selView').value;
  const dayF    = document.getElementById('txtDay').value.trim();
  const q       = document.getElementById('txtQ').value.toLowerCase().trim();
  const content = document.getElementById('mainContent');
  content.innerHTML = '';

  const installers = activeInstaller === 'ALL'
    ? ['Murugan', 'Abubaker', 'Xak']
    : [activeInstaller];

  if (view === 'summary') {{
    renderSummaryTable(installers, dayF, q, content);
  }} else {{
    renderDayCards(installers, dayF, q, content);
  }}
}}

function renderDayCards(installers, dayF, q, content) {{
  let showing = 0;
  installers.forEach(installer => {{
    const days = ROUTES[installer] || [];
    const col  = INSTALLER_COLORS[installer];

    let filteredDays = days.map((d, i) => ({{idx: i, stops: d}}));

    if (dayF) {{
      const nums = dayF.split(/[, ]+/).map(x => parseInt(x)).filter(x => !isNaN(x));
      filteredDays = filteredDays.filter(({{idx}}) => nums.includes(idx + 1));
    }}
    if (q) {{
      filteredDays = filteredDays.map(({{idx, stops}}) => ({{
        idx,
        stops: stops.filter(s =>
          [s.addr, s.city, s.zip, getStopState(s).store_name, getStopState(s).brand, getStopState(s).installer_name, getStopState(s).status, getStopState(s).comment, s.id].join(' ').toLowerCase().includes(q)
        )
      }})).filter(({{stops}}) => stops.length > 0);
    }}

    if (!filteredDays.length) return;
    showing++;

    const sh = document.createElement('div');
    sh.className = 'section-header';
    const totalSites = days.reduce((a, d) => a + d.length, 0);
    const rs = ROUTE_STATS[installer] || {{}};
    sh.innerHTML = `
      <span class="section-title ${{installer}}">${{installer}}</span>
      <span class="section-meta">${{totalSites}} sites · ${{days.length}} days · ~${{rs.avg_stops || '?'}} stops/day</span>`;
    content.appendChild(sh);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    filteredDays.forEach(({{idx, stops}}) => {{
      grid.appendChild(buildDayCard(installer, idx, stops, days.length, col));
    }});
    content.appendChild(grid);
  }});

  document.getElementById('noRes').style.display = showing === 0 ? 'block' : 'none';
}}


function fieldDisplayValue(v, fallback) {{
  const val = String(v == null ? '' : v).trim();
  return val || fallback || '—';
}}

function makeEditableTextField(label, value, key, field, placeholder, isLong=false, startsEditable=false) {{
  const box = document.createElement('div');
  box.className = 'stop-field';

  const lab = document.createElement('div');
  lab.className = 'stop-field-label';
  lab.textContent = label;
  box.appendChild(lab);

  let savedValue = value || '';
  let editing = startsEditable || !String(savedValue || '').trim();

  function render() {{
    [...box.querySelectorAll('.field-dynamic')].forEach(el => el.remove());

    if (editing) {{
      const input = isLong ? document.createElement('textarea') : document.createElement('input');
      input.className = isLong ? 'stop-comment field-dynamic' : 'stop-input field-dynamic';
      input.value = savedValue;
      input.placeholder = placeholder || label;
      box.appendChild(input);

      const actions = document.createElement('div');
      actions.className = 'field-actions field-dynamic';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'mini-btn save';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = () => {{
        savedValue = input.value || '';
        updateStopStateByKey(key, {{[field]: savedValue}});
        editing = false;
        render();
      }};
      actions.appendChild(saveBtn);

      if (String(savedValue || '').trim()) {{
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'mini-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => {{ editing = false; render(); }};
        actions.appendChild(cancelBtn);
      }}

      box.appendChild(actions);
    }} else {{
      const ro = document.createElement('div');
      ro.className = isLong ? 'stop-readonly comment-readonly field-dynamic' : 'stop-readonly field-dynamic';
      ro.textContent = fieldDisplayValue(savedValue, placeholder);
      ro.title = savedValue || '';
      box.appendChild(ro);

      const actions = document.createElement('div');
      actions.className = 'field-actions field-dynamic';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = isLong ? 'mini-btn dots' : 'mini-btn';
      editBtn.textContent = isLong ? '⋯' : 'Edit';
      editBtn.title = 'Edit ' + label;
      editBtn.onclick = () => {{ editing = true; render(); }};
      actions.appendChild(editBtn);
      box.appendChild(actions);
    }}
  }}

  render();
  return box;
}}

function makeModemField(key, st) {{
  const box = document.createElement('div');
  box.className = 'modem-box';

  const lab = document.createElement('div');
  lab.className = 'stop-field-label';
  lab.textContent = 'ARA Modem';
  box.appendChild(lab);

  let modemValue = !!st.modem;
  let locked = modemValue;

  function render() {{
    [...box.querySelectorAll('.field-dynamic')].forEach(el => el.remove());

    const label = document.createElement('label');
    label.className = 'modem-check field-dynamic';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = modemValue;
    cb.disabled = locked;
    cb.onchange = () => {{
      modemValue = cb.checked;
      updateStopStateByKey(key, {{modem: modemValue}});
      if (modemValue) locked = true;
      render();
    }};
    label.appendChild(cb);
    label.appendChild(document.createTextNode(modemValue ? 'Collected' : 'Not collected'));
    box.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'field-actions field-dynamic';
    if (locked) {{
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'mini-btn';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => {{ locked = false; render(); }};
      actions.appendChild(editBtn);
    }} else if (modemValue) {{
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'mini-btn save';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = () => {{ locked = true; updateStopStateByKey(key, {{modem: modemValue}}); render(); }};
      actions.appendChild(saveBtn);
    }}
    box.appendChild(actions);
  }}

  render();
  return box;
}}


function makeInstallerNameField(key, st, routeInstaller) {
  const box = document.createElement('div');
  box.className = 'stop-field';

  const lab = document.createElement('div');
  lab.className = 'stop-field-label';
  lab.textContent = 'Installer Name';
  box.appendChild(lab);

  const select = document.createElement('select');
  select.className = 'stop-select';
  const current = st.installer_name || routeInstaller || '';
  const opts = INSTALLER_NAME_OPTIONS.slice();
  if (current && !opts.includes(current)) opts.unshift(current);
  opts.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (current === opt) o.selected = true;
    select.appendChild(o);
  });
  select.onchange = () => {
    updateStopStateByKey(key, {installer_name: select.value});
  };
  box.appendChild(select);

  const note = document.createElement('div');
  note.className = 'stop-field-label';
  note.style.marginTop = '6px';
  note.style.textTransform = 'none';
  note.style.letterSpacing = '0';
  note.textContent = 'Updates counts/CSV; map route stays unchanged';
  box.appendChild(note);

  return box;
}

function buildDayCard(installer, dayIdx, stops, totalDays, col) {{
  const chunks = routeChunks(stops);
  const cities = getUniqueCities(stops).slice(0, 4).join(' · ');

  const card = document.createElement('div');
  card.className = `day-card ${{installer}}`;
  card.id = `card-${{installer}}-${{dayIdx + 1}}`;

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'day-hdr';
  hdr.innerHTML = `
    <div>
      <div class="day-title ${{installer}}">Day ${{dayIdx + 1}}
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:400;opacity:.6">of ${{totalDays}}</span>
      </div>
    </div>
    <div class="day-meta">
      <span class="day-badge">${{stops.length}} stops</span>
      <button class="toggle" onclick="togCard(this,event)">&#9650;</button>
    </div>`;
  card.appendChild(hdr);

  // Cities strip
  const cityStrip = document.createElement('div');
  cityStrip.className = 'day-cities';
  cityStrip.textContent = cities || '—';
  card.appendChild(cityStrip);

  // Stop list
  const listEl = document.createElement('div');
  listEl.className = 'stop-list';
  stops.forEach((s, i) => {{
    const key = stopKey(s);
    const st = getStopState(s);
    const item = document.createElement('div');
    item.className = 'stop-item';

    const main = document.createElement('div');
    main.className = 'stop-main';

    const num = document.createElement('span');
    num.className = 'stop-num';
    num.textContent = `${{i + 1}}.`;
    main.appendChild(num);

    const body = document.createElement('div');
    body.className = 'stop-body';

    const fieldGrid = document.createElement('div');
    fieldGrid.className = 'stop-field-grid';
    fieldGrid.appendChild(makeEditableTextField('Store Name', st.store_name || '', key, 'store_name', 'Store name', false, false));
    fieldGrid.appendChild(makeEditableTextField('Brand', st.brand || '', key, 'brand', 'Brand', false, false));
    fieldGrid.appendChild(makeInstallerNameField(key, st, installer));
    body.appendChild(fieldGrid);

    const addr = document.createElement('div');
    addr.className = 'stop-addr';
    addr.textContent = `${{s.addr}} · ${{String(s.city || '').trim()}}, ${{s.state}} ${{s.zip}}`;
    body.appendChild(addr);

    const installRow = document.createElement('div');
    installRow.className = 'install-row';

    const statusSelect = document.createElement('select');
    statusSelect.className = 'stop-select';
    STATUS_OPTIONS.forEach(opt => {{
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if ((st.status || 'Incomplete') === opt) o.selected = true;
      statusSelect.appendChild(o);
    }});
    statusSelect.onchange = () => {{
      updateStopStateByKey(key, {{status: statusSelect.value}});
      updateStatusPill(statusSelect);
    }};
    installRow.appendChild(statusSelect);
    installRow.appendChild(makeModemField(key, st));
    body.appendChild(installRow);

    const commentStartsEditable = !String(st.comment || '').trim();
    body.appendChild(makeEditableTextField('Comment', st.comment || '', key, 'comment', 'Comment / installation notes', true, commentStartsEditable));

    const pill = document.createElement('span');
    pill.className = 'status-pill ' + statusClass(st.status || 'Incomplete');
    pill.textContent = st.status || 'Incomplete';
    body.appendChild(pill);

    main.appendChild(body);
    item.appendChild(main);
    listEl.appendChild(item);
  }});
  card.appendChild(listEl);

  // Actions
  const acts = document.createElement('div');
  acts.className = 'day-acts';

  if (stops.length <= 10) {{
    const a = document.createElement('a');
    a.href = gmRouteUrl(stops);
    a.target = '_blank'; a.rel = 'noopener';
    a.className = `rbtn ${{col.cls}}`;
    a.innerHTML = `&#128506; Open Route (${{stops.length}} stops)`;
    acts.appendChild(a);
  }} else {{
    chunks.forEach((chunk, c) => {{
      const a = document.createElement('a');
      a.href = buildBatchUrl(stops, c);
      a.target = '_blank'; a.rel = 'noopener';
      a.className = `rbtn ${{col.cls}}`;
      a.innerHTML = `&#128506; Map ${{c + 1}} (stops ${{chunk.start + 1}}–${{chunk.end + 1}})`;
      acts.appendChild(a);
    }});
  }}

  // Copy addresses
  const copyBtn = document.createElement('button');
  copyBtn.className = 'rbtn sec';
  copyBtn.innerHTML = '&#128203; Copy Addresses';
  copyBtn.onclick = () => {{
    const text = stops.map((s, i) =>
      `${{i + 1}}. ${{s.addr}}, ${{s.city.trim()}}, ${{s.state}} ${{s.zip}}${{getStopState(s).store_name ? ' — ' + getStopState(s).store_name : ''}}`
    ).join('\\n');
    navigator.clipboard.writeText(text).then(() => {{
      copyBtn.innerHTML = '&#10003; Copied!';
      setTimeout(() => copyBtn.innerHTML = '&#128203; Copy Addresses', 1800);
    }});
  }};
  acts.appendChild(copyBtn);

  // Per-day CSV
  const csvBtn = document.createElement('button');
  csvBtn.className = 'rbtn sec';
  csvBtn.innerHTML = '&#8681; CSV';
  csvBtn.onclick = () => exportDayCSV(installer, dayIdx + 1, stops);
  acts.appendChild(csvBtn);

  card.appendChild(acts);
  return card;
}}

function renderSummaryTable(installers, dayF, q, content) {{
  const table = document.createElement('table');
  table.className = 'summary-table';
  table.innerHTML = `<thead><tr>
    <th>Installer</th><th>Day</th><th>Stops</th><th>Cities Covered</th><th>Open Route</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  let rows = 0;
  installers.forEach(installer => {{
    const days = ROUTES[installer] || [];
    const col  = INSTALLER_COLORS[installer];
    days.forEach((stops, idx) => {{
      if (dayF) {{
        const nums = dayF.split(/[, ]+/).map(x => parseInt(x)).filter(x => !isNaN(x));
        if (!nums.includes(idx + 1)) return;
      }}
      let filtStops = stops;
      if (q) filtStops = stops.filter(s =>
        [s.addr, s.city, s.zip, getStopState(s).store_name, getStopState(s).brand, getStopState(s).installer_name, getStopState(s).status, getStopState(s).comment].join(' ').toLowerCase().includes(q));
      if (!filtStops.length && q) return;

      const cities = getUniqueCities(filtStops).slice(0, 5).join(', ');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:${{col.color}};font-weight:600">${{installer}}</td>
        <td>Day ${{idx + 1}}</td>
        <td>${{filtStops.length}}</td>
        <td style="color:var(--muted)">${{cities}}</td>
        <td><a href="${{gmRouteUrl(filtStops.slice(0, 10))}}" target="_blank" rel="noopener" class="day-link">&#128506; Open</a></td>`;
      tbody.appendChild(tr);
      rows++;
    }});
  }});

  table.appendChild(tbody);
  content.appendChild(table);
  document.getElementById('noRes').style.display = rows === 0 ? 'block' : 'none';
}}

// ── TOGGLE ──
function togCard(btn, e) {{
  e.stopPropagation();
  const card  = btn.closest('.day-card');
  const list  = card.querySelector('.stop-list');
  const acts  = card.querySelector('.day-acts');
  const strip = card.querySelector('.day-cities');
  const hidden = list.style.display === 'none';
  [list, acts, strip].forEach(el => {{ if (el) el.style.display = hidden ? '' : 'none'; }});
  btn.textContent = hidden ? '\u25B2' : '\u25BC';
}}
function expandAll() {{
  document.querySelectorAll('.stop-list,.day-acts,.day-cities').forEach(el => el.style.display = '');
  document.querySelectorAll('.toggle').forEach(b => b.textContent = '\u25B2');
}}
function collapseAll() {{
  document.querySelectorAll('.stop-list,.day-acts,.day-cities').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.toggle').forEach(b => b.textContent = '\u25BC');
}}

// ── EXPORT ──
function exportDayCSV(installer, dayNum, stops) {{
  const cols = ['Day','Stop #','ID','Store Name','Brand','Route Owner','Installer Name','Address','City','State','ZIP',
                'Assigned Region','Status','Comment','ARA Modem Collected','Geocoded Address','Lat','Lng'];
  const rows = [cols, ...stops.map((s, i) => [
    dayNum, i + 1, s.id, getStopState(s).store_name || '', getStopState(s).brand || '',
    installer, getStopState(s).installer_name || installer,
    s.addr, s.city.trim(), s.state, s.zip,
    s.assigned_region,
    getStopState(s).status || 'Incomplete', getStopState(s).comment || '', getStopState(s).modem ? 'Yes' : 'No',
    s.geocoded || '', s.lat || '', s.lng || ''
  ])];
  downloadCSV(rows, `${{installer}}_Day${{dayNum}}_route.csv`);
}}

function exportAllCSV() {{
  const cols = ['Route Owner','Installer Name','Day','Stop #','ID','Store Name','Brand','Address','City','State',
                'ZIP','Assigned Region','Status','Comment','ARA Modem Collected','Geocoded Address','Lat','Lng'];
  const rows = [cols];
  ['Murugan','Abubaker','Xak'].forEach(installer => {{
    (ROUTES[installer] || []).forEach((day, dayIdx) => {{
      day.forEach((s, stopIdx) => {{
        rows.push([
          installer, getStopState(s).installer_name || installer, dayIdx + 1, stopIdx + 1,
          s.id, getStopState(s).store_name || '', getStopState(s).brand || '',
          s.addr, s.city.trim(), s.state, s.zip,
          s.assigned_region,
          getStopState(s).status || 'Incomplete', getStopState(s).comment || '', getStopState(s).modem ? 'Yes' : 'No',
          s.geocoded || '', s.lat || '', s.lng || ''
        ]);
      }});
    }});
  }});
  downloadCSV(rows, 'atlanta_all_routes_' + new Date().toISOString().slice(0, 10) + '.csv');
}}

function downloadCSV(rows, filename) {{
  const csv = rows.map(r => r.map(v => {{
    const str = String(v == null ? '' : v).replace(/"/g, '""');
    return /[,\\n"]/.test(str) ? `"${{str}}"` : str;
  }}).join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {{type: 'text/csv'}}));
  a.download = filename;
  a.click();
}}

// ── INIT ──
// loadStateFromDB() is called above — it fetches MongoDB state then calls
// applyFilters() internally once the data arrives.
// applyFilters() is also safe to call immediately for the skeleton render.
try {{
  applyFilters();
}} catch (err) {{
  console.error(err);
  const content = document.getElementById('mainContent');
  if (content) {{
    content.innerHTML = `<div style="padding:20px;border:1px solid #f43f5e;color:#f43f5e;background:rgba(244,63,94,.08);font-family:monospace;white-space:pre-wrap">
HTML render error: ${{err.message}}
Open DevTools Console for details.
</div>`;
  }}
}}
</script>
</body>
</html>
"""


# ── STEP 6 — ASSEMBLE & WRITE ──────────────────────────────────────────────
def build_stats_js_with_avg(schedules: dict) -> str:
    """Extended stats including avg_stops for the section-meta line."""
    stats = {}
    for tech, days in schedules.items():
        total = sum(len(d) for d in days)
        stats[tech] = {
            "total":     total,
            "days":      len(days),
            "avg_stops": round(total / len(days), 1) if days else 0,
        }
    return "const ROUTE_STATS=" + json.dumps(stats) + ";"


def main():
    print("=" * 60)
    print("  Atlanta Route Planner — HTML Generator")
    print("=" * 60)

    print("\n[1/4] Loading Excel data …")
    df = load_data(resolve_input_file(INPUT_FILE))

    print("\n[2/4] Balancing workload across 3 technicians …")
    df = assign_technicians(df)
    for t in TECHS:
        print(f"  {t}: {(df['installer'] == t).sum()} sites")

    print("\n[3/4] Building optimised daily routes …")
    schedules = build_schedules(df)

    print("\n[4/4] Assembling HTML …")
    routes_js = build_routes_js(schedules)
    stats_js  = build_stats_js_with_avg(schedules)

    # IMPORTANT:
    # Do NOT use HTML_TEMPLATE.format(...) here.
    # The HTML contains lots of JavaScript/CSS braces and template literals,
    # so Python .format() can mistake JS code like ${... ? ... : ...}
    # for Python format syntax and crash with errors such as:
    #   ValueError: expected ':' after conversion specifier
    #
    # Instead, temporarily protect the two real placeholders, collapse the
    # escaped double braces used throughout the template, then inject the data.
    html = HTML_TEMPLATE.replace("{routes_js}", "__ROUTES_JS_PLACEHOLDER__")
    html = html.replace("{stats_js}", "__STATS_JS_PLACEHOLDER__")
    html = html.replace("{{", "{").replace("}}", "}")
    html = html.replace("__ROUTES_JS_PLACEHOLDER__", routes_js)
    html = html.replace("__STATS_JS_PLACEHOLDER__", stats_js)

    out = Path(OUTPUT_FILE)
    out.write_text(html, encoding="utf-8")

    size_kb = out.stat().st_size // 1024
    print(f"\n{'=' * 60}")
    print(f"  Done!  →  {OUTPUT_FILE}  ({size_kb} KB)")
    print(f"  Open in any browser — no server needed.")
    print("=" * 60)


if __name__ == "__main__":
    main()