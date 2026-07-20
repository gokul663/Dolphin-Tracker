from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os, io, json, math, re, uuid, logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import pandas as pd
import requests
try:
    from .file_parser import ADDRESS_ALIASES, DMA_ALIASES, PA_ALIASES, STATUS_ALIASES, STORE_ALIASES, VENUE_CODE_ALIASES, VENUE_TYPE_ALIASES, clean_cell, normalize_column, normalize_status, read_csv_table
    from .route_optimizer import build_project_routes, clean_territory_outliers, rebalance_incomplete_routes, reassign_stop_preserving_days, route_miles, split_territory_for_new_installer
except ImportError:
    from file_parser import ADDRESS_ALIASES, DMA_ALIASES, PA_ALIASES, STATUS_ALIASES, STORE_ALIASES, VENUE_CODE_ALIASES, VENUE_TYPE_ALIASES, clean_cell, normalize_column, normalize_status, read_csv_table
    from route_optimizer import build_project_routes, clean_territory_outliers, rebalance_incomplete_routes, reassign_stop_preserving_days, route_miles, split_territory_for_new_installer

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]
projects_col = db["projects"]
ara_state_col = db["stop_states"]
project_state_col = db["route_planner_stop_states"]

GOOGLE_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
STOPS_PER_DAY = 8
EXTERNAL_PROJECT_IDS = {"atlanta-default"}

app = FastAPI(title="Route Planner API")
api_router = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc


# ─────────────────────────── MODELS ───────────────────────────
class Stop(BaseModel):
    id: str
    addr: str
    city: str = ""
    state: str = ""
    zip: str = ""
    store_name: str = ""
    brand: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    geocoded: str = ""
    installer: str = ""
    day: int = 1
    assigned_region: str = ""
    pa: str = ""
    venue_type: str = ""
    dma: str = ""
    venue_code: str = ""


class ProjectCreate(BaseModel):
    name: str
    pa: str
    project_type: str
    installers: List[str] = Field(default_factory=list)
    stops: List[Dict[str, Any]] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    pa: Optional[str] = None
    project_type: Optional[str] = None
    installers: Optional[List[str]] = None
    confirm_name: Optional[str] = None  # For 2-step destructive ops


class ProjectAppend(BaseModel):
    stops: List[Dict[str, Any]] = Field(default_factory=list)
    pa: str = ""


class StopReassignment(BaseModel):
    stop_id: str
    installer: str
    old_stop_key: Optional[str] = None


class StopAddressRepair(BaseModel):
    venue_code: str
    address: str
    city: str
    state: str
    zip_code: str


class StopDetailsUpdate(BaseModel):
    stop_id: str
    old_stop_key: Optional[str] = None
    addr: Optional[str] = None
    venue_type: Optional[str] = None
    dma: Optional[str] = None
    venue_code: Optional[str] = None


class InstallerRename(BaseModel):
    old_name: str
    new_name: str


class InstallerAdd(BaseModel):
    name: str


class StopStatePayload(BaseModel):
    stop_key: str
    project_id: Optional[str] = None
    store_name: Optional[str] = None
    brand: Optional[str] = None
    installer_name: Optional[str] = None
    status: Optional[str] = None
    comment: Optional[str] = None
    modem: Optional[bool] = None
    additional_task: Optional[bool] = None
    venue_code: Optional[str] = None
    updatedBy: Optional[str] = None


# ─────────────────────────── HELPERS ──────────────────────────
def haversine(lat1, lng1, lat2, lng2) -> float:
    R = 3958.8
    dlat = math.radians(lat2 - lat1); dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) *
         math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_neighbor_order(stops: List[dict]) -> List[dict]:
    if len(stops) <= 2:
        return stops[:]
    pool = stops[:]
    route = [pool.pop(0)]
    while pool:
        last = route[-1]
        nxt = min(pool, key=lambda s: haversine(last["lat"], last["lng"], s["lat"], s["lng"]))
        route.append(nxt); pool.remove(nxt)
    return route


def stop_key(stop: dict) -> str:
    return f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"


def normalized_address_key(stop: dict) -> str:
    parts = []
    for field in ("addr", "city", "state", "zip"):
        value = re.sub(r"[^a-z0-9]+", " ", clean_cell(stop.get(field, "")).lower()).strip()
        if value:
            parts.append(value)
    return "|".join(parts)


def duplicate_key(stop: dict) -> str:
    venue_code = clean_cell(stop.get("venue_code", "")).lower()
    if venue_code:
        return f"venue|{venue_code}"
    address = normalized_address_key(stop)
    return f"addr|{address}" if address else ""


async def rebalance_project_incomplete(project: dict, installers: List[str], new_installer: str = None) -> tuple:
    project_id = project["id"]
    current = project_to_routes(project)["routes"]
    states = {}
    async for state in project_state_col.find({"project_id": project_id}, {"_id": 0}):
        states[state.get("stop_key")] = state

    incomplete_ids = set()
    old_keys = {}
    for days in current.values():
        for day in days:
            for stop in day:
                key = f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
                if states.get(key, {}).get("status", "Incomplete") == "Incomplete":
                    stop_id = str(stop.get("id", ""))
                    incomplete_ids.add(stop_id)
                    old_keys[stop_id] = key

    if new_installer:
        existing_installers = [installer for installer in installers if installer != new_installer]
        assignments = split_territory_for_new_installer(
            current, incomplete_ids, existing_installers, new_installer
        )
    else:
        assignments = clean_territory_outliers(current, incomplete_ids, installers)
    rerouted = rebalance_incomplete_routes(
        current, incomplete_ids, installers, STOPS_PER_DAY, assignments
    )
    stops = [stop for installer in installers for day in rerouted.get(installer, []) for stop in day]
    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"installers": installers, "stops": stops, "updated_at": _now()}},
    )

    for stop in stops:
        stop_id = str(stop.get("id", ""))
        old_key = old_keys.get(stop_id)
        if not old_key:
            continue
        new_key = f"atl-route-v2|{stop.get('installer','')}|{stop_id}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
        if new_key == old_key or not states.get(old_key):
            continue
        state = states[old_key]
        state["stop_key"] = new_key
        state["installer_name"] = stop.get("installer", "")
        state["updatedAt"] = _now()
        await project_state_col.replace_one(
            {"project_id": project_id, "stop_key": old_key}, state
        )
    return len(incomplete_ids)


async def recluster_project(project: dict, installers: List[str]) -> int:
    """Rebuild all territories geographically while preserving saved stop state."""
    project_id = project["id"]
    original_stops = [dict(stop) for stop in project.get("stops", [])]
    old_keys = {
        str(stop.get("id", "")): (
            f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|"
            f"{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
        )
        for stop in original_stops
    }
    states = {}
    async for state in project_state_col.find({"project_id": project_id}, {"_id": 0}):
        states[state.get("stop_key")] = state

    routes = build_project_routes(original_stops, installers, STOPS_PER_DAY)
    stops = [stop for installer in installers for day in routes.get(installer, []) for stop in day]
    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"installers": installers, "stops": stops, "updated_at": _now()}},
    )

    for stop in stops:
        stop_id = str(stop.get("id", ""))
        old_key = old_keys.get(stop_id)
        state = states.get(old_key)
        if not state:
            continue
        new_key = (
            f"atl-route-v2|{stop.get('installer','')}|{stop_id}|"
            f"{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
        )
        if new_key == old_key:
            continue
        state["stop_key"] = new_key
        state["installer_name"] = stop.get("installer", "")
        state["updatedAt"] = _now()
        await project_state_col.replace_one(
            {"project_id": project_id, "stop_key": old_key}, state
        )
    return len(stops)


def split_into_days(stops: List[dict], per_day: int = STOPS_PER_DAY) -> List[List[dict]]:
    if not stops:
        return []
    ordered = nearest_neighbor_order([s for s in stops if s.get("lat") is not None and s.get("lng") is not None])
    days = [ordered[i:i + per_day] for i in range(0, len(ordered), per_day)]
    return days


def project_to_routes(project: dict) -> Dict[str, Any]:
    """Build balanced installer territories and continuous daily routes."""
    stops = project.get("stops", [])
    installers = project.get("installers") or list({s.get("installer", "") for s in stops if s.get("installer")})
    installers = [installer for installer in installers if installer]
    # Day assignments are persisted when a project is created or edited.
    # Rebuilding clusters on every GET would unexpectedly move unrelated stops.
    routes = {}
    for installer in installers:
        by_day: Dict[int, List[dict]] = {}
        for stop in stops:
            if stop.get("installer") != installer:
                continue
            try:
                day = max(1, int(stop.get("day", 1)))
            except (TypeError, ValueError):
                day = 1
            by_day.setdefault(day, []).append(dict(stop))
        routes[installer] = [by_day[day] for day in sorted(by_day)]
    stats: Dict[str, dict] = {}
    for inst in installers:
        days = routes.get(inst, [])
        total = sum(len(d) for d in days)
        stats[inst] = {
            "total": total,
            "days": len(days),
            "avg_stops": round(total / len(days), 1) if days else 0,
            "miles": round(sum(route_miles(day) for day in days), 1),
        }
    return {"routes": routes, "stats": stats}


def kpi_summary(project: dict, states: Dict[str, dict]) -> dict:
    stops = project.get("stops", [])
    by_status = {"Complete": 0, "Incomplete": 0, "Technical Issue": 0, "Other": 0}
    by_installer: Dict[str, int] = {}
    by_dma: Dict[str, dict] = {}
    by_venue_type: Dict[str, dict] = {}
    address_groups: Dict[str, List[str]] = {}

    def address_key(stop: dict) -> str:
        parts = []
        for field in ("addr", "city", "state", "zip"):
            value = re.sub(r"[^a-z0-9]+", " ", clean_cell(stop.get(field, "")).lower()).strip()
            if value:
                parts.append(value)
        return "|".join(parts) or f"missing-address|{stop.get('id', '')}"

    def add_breakdown(target: Dict[str, dict], label: str, status: str):
        key = clean_cell(label) or "Not provided"
        target.setdefault(key, {"total": 0, "complete": 0, "pending": 0})
        target[key]["total"] += 1
        if status == "Complete":
            target[key]["complete"] += 1
        elif status == "Incomplete":
            target[key]["pending"] += 1

    for s in stops:
        key = f"atl-route-v2|{s.get('installer','')}|{s.get('id','')}|{s.get('addr','')}|{s.get('lat','')}|{s.get('lng','')}"
        st = states.get(key, {})
        status = st.get("status", "Incomplete")
        by_status[status] = by_status.get(status, 0) + 1
        inst = st.get("installer_name") or s.get("installer", "")
        if inst:
            by_installer[inst] = by_installer.get(inst, 0) + 1
        add_breakdown(by_dma, s.get("dma", ""), status)
        add_breakdown(by_venue_type, s.get("venue_type", ""), status)
        address_groups.setdefault(address_key(s), []).append(status)
    unique_complete = sum(
        bool(statuses) and all(status == "Complete" for status in statuses)
        for statuses in address_groups.values()
    )
    unique_total = len(address_groups)
    return {
        "total": len(stops),
        "complete": by_status.get("Complete", 0),
        "pending": by_status.get("Incomplete", 0),
        "technical": by_status.get("Technical Issue", 0),
        "other": by_status.get("Other", 0),
        "by_installer": by_installer,
        "by_status": by_status,
        "address_status": {
            "total": unique_total,
            "complete": unique_complete,
            "pending": unique_total - unique_complete,
        },
        "by_dma": by_dma,
        "by_venue_type": by_venue_type,
    }


# ─────────────────────────── GOOGLE ───────────────────────────
def google_geocode(address: str) -> dict:
    if not GOOGLE_KEY or not address.strip():
        return {"ok": False, "error": "missing key/address"}
    try:
        r = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"address": address, "key": GOOGLE_KEY},
            timeout=8,
        )
        data = r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    status = data.get("status")
    results = data.get("results", [])
    if status == "OK" and results:
        top = results[0]
        loc = top["geometry"]["location"]
        return {
            "ok": True,
            "status": status,
            "formatted": top.get("formatted_address", ""),
            "lat": loc["lat"], "lng": loc["lng"],
            "partial": bool(top.get("partial_match")),
            "suggestions": [r.get("formatted_address", "") for r in results[:5]],
        }
    return {"ok": False, "status": status, "suggestions": [], "error": data.get("error_message", "")}


def google_autocomplete(query: str) -> List[str]:
    if not GOOGLE_KEY or not query.strip():
        return []
    try:
        r = requests.get(
            "https://maps.googleapis.com/maps/api/place/autocomplete/json",
            params={"input": query, "key": GOOGLE_KEY, "types": "address", "components": "country:us"},
            timeout=8,
        )
        data = r.json()
    except Exception:
        return []
    return [p.get("description", "") for p in data.get("predictions", [])][:6]


def google_place_find(query: str) -> dict:
    """Verify an address corresponds to a real place via Places Find-From-Text."""
    if not GOOGLE_KEY or not query.strip():
        return {"ok": False}
    try:
        r = requests.get(
            "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
            params={
                "input": query,
                "inputtype": "textquery",
                "fields": "formatted_address,name,geometry,place_id,business_status",
                "key": GOOGLE_KEY,
            },
            timeout=8,
        )
        data = r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    candidates = data.get("candidates", [])
    if data.get("status") == "OK" and candidates:
        c = candidates[0]
        loc = c.get("geometry", {}).get("location", {})
        return {
            "ok": True,
            "place_id": c.get("place_id"),
            "name": c.get("name"),
            "formatted": c.get("formatted_address"),
            "lat": loc.get("lat"), "lng": loc.get("lng"),
            "business_status": c.get("business_status"),
        }
    return {"ok": False, "status": data.get("status")}


# ─────────────────────────── ROUTES ───────────────────────────
@api_router.get("/")
async def root():
    return {"message": "Route Planner API"}


@api_router.get("/health")
async def health():
    try:
        await client.admin.command("ping"); db_ok = True
    except Exception:
        db_ok = False
    return {"status": "ok", "db": db_ok, "google": bool(GOOGLE_KEY), "ts": _now()}


@api_router.get("/config/maps")
async def maps_config():
    return {"ok": bool(GOOGLE_KEY), "google_maps_api_key": GOOGLE_KEY}


# ─── Places ───
@api_router.get("/places/autocomplete")
async def places_autocomplete(q: str = ""):
    return {"ok": True, "suggestions": google_autocomplete(q)}


@api_router.get("/places/validate")
async def places_validate(address: str = ""):
    return google_geocode(address)


# ─── Projects ───
@api_router.get("/projects")
async def list_projects():
    ara_states: List[dict] = []
    async for d in ara_state_col.find({}):
        d.pop("_id", None)
        ara_states.append(d)

    project_states: List[dict] = []
    async for d in project_state_col.find({}):
        d.pop("_id", None)
        project_states.append(d)

    projects = []
    async for p in projects_col.find({}, {"_id": 0}).sort("created_at", -1):
        pid = p["id"]
        if pid in EXTERNAL_PROJECT_IDS:
            scoped = {d.get("stop_key"): d for d in ara_states if not d.get("project_id") or d.get("project_id") == pid}
        else:
            scoped = {d.get("stop_key"): d for d in project_states if d.get("project_id") == pid}
        kpi = kpi_summary(p, scoped)
        projects.append({
            "id": pid,
            "name": p.get("name"),
            "pa": p.get("pa", ""),
            "project_type": p.get("project_type", ""),
            "installers": p.get("installers", []),
            "created_at": p.get("created_at"),
            "read_only": pid in EXTERNAL_PROJECT_IDS,
            "kpi": kpi,
        })
    agg = {
        "total_projects": len(projects),
        "total_sites": sum(p["kpi"]["total"] for p in projects),
        "total_installers": len({i for p in projects for i in p["installers"]}),
        "complete": sum(p["kpi"]["complete"] for p in projects),
        "pending": sum(p["kpi"]["pending"] for p in projects),
        "technical": sum(p["kpi"]["technical"] for p in projects),
        "other": sum(p["kpi"]["other"] for p in projects),
    }
    return {"ok": True, "projects": projects, "kpi": agg}


@api_router.get("/projects/{project_id}")
async def get_project(project_id: str):
    p = await projects_col.find_one({"id": project_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Project not found")
    bundle = project_to_routes(p)
    return {
        "ok": True,
        "id": p["id"],
        "name": p.get("name"),
        "pa": p.get("pa", ""),
        "project_type": p.get("project_type", ""),
        "read_only": project_id in EXTERNAL_PROJECT_IDS,
        "installers": p.get("installers", []),
        "routes": bundle["routes"],
        "stats": bundle["stats"],
    }


@api_router.post("/projects")
async def create_project(payload: ProjectCreate):
    if not payload.name.strip():
        raise HTTPException(422, "Project name required")
    if not payload.pa.strip():
        raise HTTPException(422, "PA name is required in the uploaded sheet")
    allowed_project_types = {"new_installation", "offline", "new_installation_and_offline"}
    if payload.project_type not in allowed_project_types:
        raise HTTPException(422, "Select a valid project type")
    stops = [dict(s) for s in payload.stops]
    initial_statuses = {}
    initial_venue_codes = {}
    for stop in stops:
        initial_status = stop.pop("initial_status", None)
        if initial_status is not None:
            status, valid = normalize_status(initial_status)
            if not valid:
                raise HTTPException(422, f"Invalid status '{initial_status}'")
            initial_statuses[str(stop.get("id", ""))] = status
        venue_code = clean_cell(stop.get("venue_code", ""))
        if venue_code:
            initial_venue_codes[str(stop.get("id", ""))] = venue_code
    if payload.installers:
        routes = build_project_routes(stops, payload.installers, STOPS_PER_DAY)
        stops = [stop for installer in payload.installers for day in routes.get(installer, []) for stop in day]

    project = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "pa": payload.pa.strip(),
        "project_type": payload.project_type,
        "installers": payload.installers,
        "stops": stops,
        "routing_version": 2,
        "created_at": _now(),
        "updated_at": _now(),
    }
    await projects_col.insert_one(project)
    if initial_statuses or initial_venue_codes:
        state_documents = []
        for stop in stops:
            stop_id = str(stop.get("id", ""))
            if stop_id not in initial_statuses and stop_id not in initial_venue_codes:
                continue
            stop_key = f"atl-route-v2|{stop.get('installer','')}|{stop_id}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
            state_documents.append({
                "project_id": project["id"],
                "stop_key": stop_key,
                "installer_name": stop.get("installer", ""),
                "status": initial_statuses.get(stop_id, "Incomplete"),
                "venue_code": initial_venue_codes.get(stop_id, ""),
                "updatedAt": _now(),
            })
        if state_documents:
            await project_state_col.insert_many(state_documents)
    return {"ok": True, "id": project["id"], "name": project["name"], "stop_count": len(stops)}


@api_router.post("/projects/{project_id}/append-stops")
async def append_project_stops(project_id: str, payload: ProjectAppend):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    installers = [name for name in project.get("installers", []) if name]
    if not installers:
        raise HTTPException(422, "Project needs at least one installer before appending stops")

    existing_stops = [dict(stop) for stop in project.get("stops", [])]
    existing_keys = {duplicate_key(stop) for stop in existing_stops if duplicate_key(stop)}
    seen_new_keys = set()
    skipped = []
    candidates = []

    for raw in payload.stops:
        stop = dict(raw)
        dup = duplicate_key(stop)
        if dup and (dup in existing_keys or dup in seen_new_keys):
            skipped.append({
                "addr": stop.get("addr", ""),
                "venue_code": stop.get("venue_code", ""),
                "reason": "duplicate",
            })
            continue
        if dup:
            seen_new_keys.add(dup)
        candidates.append(stop)

    if not candidates:
        return {"ok": True, "appended": 0, "skipped": skipped, "total": len(existing_stops)}

    max_id = 0
    for stop in existing_stops:
        match = re.match(r"^S(\d+)$", str(stop.get("id", "")))
        if match:
            max_id = max(max_id, int(match.group(1)))

    by_installer: Dict[str, List[dict]] = {installer: [] for installer in installers}
    for stop in existing_stops:
        installer = stop.get("installer")
        if installer in by_installer:
            by_installer[installer].append(stop)

    initial_states = []
    appended = []
    for offset, stop in enumerate(candidates, start=1):
        initial_status = stop.pop("initial_status", None)
        status, valid = normalize_status(initial_status or "Incomplete")
        if not valid:
            raise HTTPException(422, f"Invalid status '{initial_status}'")

        installer = min(installers, key=lambda name: len(by_installer.get(name, [])))
        existing_days = [
            int(row.get("day", 1))
            for row in by_installer.get(installer, [])
            if str(row.get("day", "")).isdigit()
        ]
        day = max(existing_days or [1])
        current_day_count = sum(1 for row in by_installer.get(installer, []) if int(row.get("day", 1) or 1) == day)
        if current_day_count >= STOPS_PER_DAY:
            day += 1

        stop["id"] = f"S{max_id + offset}"
        stop["installer"] = installer
        stop["day"] = day
        stop.setdefault("assigned_region", "")
        by_installer.setdefault(installer, []).append(stop)
        appended.append(stop)

        venue_code = clean_cell(stop.get("venue_code", ""))
        if status != "Incomplete" or venue_code:
            initial_states.append({
                "project_id": project_id,
                "stop_key": stop_key(stop),
                "installer_name": installer,
                "status": status,
                "venue_code": venue_code,
                "updatedAt": _now(),
            })

    updated_stops = existing_stops + appended
    pa_values = {
        clean_cell(value)
        for value in re.split(r",", project.get("pa", ""))
        if clean_cell(value)
    }
    for value in re.split(r",", payload.pa or ""):
        cleaned = clean_cell(value)
        if cleaned:
            pa_values.add(cleaned)
    for stop in appended:
        cleaned = clean_cell(stop.get("pa", ""))
        if cleaned:
            pa_values.add(cleaned)

    await projects_col.update_one(
        {"id": project_id},
        {"$set": {
            "stops": updated_stops,
            "pa": ", ".join(sorted(pa_values)) if pa_values else project.get("pa", ""),
            "updated_at": _now(),
        }},
    )
    if initial_states:
        await project_state_col.insert_many(initial_states)

    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {
        "ok": True,
        "appended": len(appended),
        "skipped": skipped,
        "total": len(updated_stops),
        "routes": bundle["routes"],
        "stats": bundle["stats"],
    }


@api_router.patch("/projects/{project_id}")
async def update_project(project_id: str, payload: ProjectUpdate):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    existing = await projects_col.find_one({"id": project_id})
    if not existing:
        raise HTTPException(404, "Project not found")
    update: Dict[str, Any] = {}
    if payload.name is not None:
        nm = payload.name.strip()
        if not nm:
            raise HTTPException(422, "Project name cannot be empty")
        update["name"] = nm
    if payload.pa is not None:
        update["pa"] = payload.pa.strip()
    if payload.project_type is not None:
        if payload.project_type not in {"new_installation", "offline", "new_installation_and_offline"}:
            raise HTTPException(422, "Select a valid project type")
        update["project_type"] = payload.project_type
    if payload.installers is not None:
        update["installers"] = payload.installers
    if not update:
        raise HTTPException(422, "No fields to update")
    update["updated_at"] = _now()
    await projects_col.update_one({"id": project_id}, {"$set": update})
    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    return {"ok": True, "project": refreshed}


@api_router.post("/projects/{project_id}/rename-installer")
async def rename_installer(project_id: str, payload: InstallerRename):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    old_name = payload.old_name.strip()
    new_name = payload.new_name.strip()
    installers = [name for name in project.get("installers", []) if name]
    if old_name not in installers:
        raise HTTPException(404, "Installer not found")
    if not new_name:
        raise HTTPException(422, "Installer name cannot be empty")
    if new_name != old_name and new_name in installers:
        raise HTTPException(409, "Installer name already exists")
    if new_name == old_name:
        bundle = project_to_routes(project)
        return {"ok": True, "installers": installers, **bundle}

    renamed_installers = [new_name if name == old_name else name for name in installers]
    stops = [dict(stop) for stop in project.get("stops", [])]
    key_changes = []
    for stop in stops:
        if stop.get("installer") != old_name:
            continue
        old_key = f"atl-route-v2|{old_name}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
        stop["installer"] = new_name
        new_key = f"atl-route-v2|{new_name}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
        key_changes.append((old_key, new_key))

    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"installers": renamed_installers, "stops": stops, "updated_at": _now()}},
    )
    for old_key, new_key in key_changes:
        state = await project_state_col.find_one({"stop_key": old_key, "project_id": project_id})
        if not state:
            continue
        state.pop("_id", None)
        state["stop_key"] = new_key
        if state.get("installer_name") == old_name:
            state["installer_name"] = new_name
        state["updatedAt"] = _now()
        await project_state_col.replace_one({"stop_key": old_key, "project_id": project_id}, state)

    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {"ok": True, "installers": renamed_installers, **bundle}


@api_router.post("/projects/{project_id}/installers")
async def add_installer(project_id: str, payload: InstallerAdd):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Installer name cannot be empty")
    installers = [installer for installer in project.get("installers", []) if installer]
    if name in installers:
        raise HTTPException(409, "Installer name already exists")
    installers.append(name)
    redistributed = await rebalance_project_incomplete(project, installers, name)

    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {"ok": True, "installers": installers, "redistributed": redistributed, **bundle}


@api_router.post("/projects/{project_id}/rebalance-incomplete")
async def rebalance_incomplete(project_id: str):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    installers = [name for name in project.get("installers", []) if name]
    redistributed = await rebalance_project_incomplete(project, installers)
    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {"ok": True, "installers": installers, "redistributed": redistributed, **bundle}


@api_router.post("/projects/{project_id}/recluster-routes")
async def recluster_routes(project_id: str):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    installers = [name for name in project.get("installers", []) if name]
    if not installers:
        raise HTTPException(422, "At least one installer is required")
    redistributed = await recluster_project(project, installers)
    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {"ok": True, "installers": installers, "redistributed": redistributed, **bundle}


@api_router.post("/projects/{project_id}/reassign-stop")
async def reassign_stop(project_id: str, payload: StopReassignment):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    installers = [name for name in project.get("installers", []) if name]
    if payload.installer not in installers:
        raise HTTPException(422, "Installer is not assigned to this project")

    # Materialize the currently displayed balanced routes before applying the move.
    current = project_to_routes(project)["routes"]
    try:
        rerouted, moved, old_installer = reassign_stop_preserving_days(
            current, payload.stop_id, payload.installer, STOPS_PER_DAY
        )
    except LookupError:
        raise HTTPException(404, "Stop not found")
    except ValueError:
        raise HTTPException(409, "Stop ID is not unique")

    flattened = [stop for installer in installers for day in rerouted[installer] for stop in day]
    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"stops": flattened, "routing_version": 2, "updated_at": _now()}},
    )

    new_stop_key = f"atl-route-v2|{payload.installer}|{moved.get('id','')}|{moved.get('addr','')}|{moved.get('lat','')}|{moved.get('lng','')}"
    if payload.old_stop_key and payload.old_stop_key != new_stop_key:
        state = await project_state_col.find_one({"stop_key": payload.old_stop_key, "project_id": project_id})
        if state:
            state.pop("_id", None)
            state["stop_key"] = new_stop_key
            state["installer_name"] = payload.installer
            state["updatedAt"] = _now()
            await project_state_col.replace_one(
                {"stop_key": payload.old_stop_key, "project_id": project_id}, state
            )

    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {
        "ok": True,
        "old_installer": old_installer,
        "installer": payload.installer,
        "old_stop_key": payload.old_stop_key,
        "new_stop_key": new_stop_key,
        "routes": bundle["routes"],
        "stats": bundle["stats"],
    }


@api_router.post("/projects/{project_id}/repair-stop-address")
async def repair_stop_address(project_id: str, payload: StopAddressRepair):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")
    matches = [
        stop for stop in project.get("stops", [])
        if str(stop.get("venue_code", "")) == payload.venue_code.strip()
    ]
    if len(matches) != 1:
        raise HTTPException(409, f"Expected one venue-code match, found {len(matches)}")

    stop = matches[0]
    old_key = f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
    stop.update({
        "addr": payload.address.strip(),
        "city": payload.city.strip(),
        "state": payload.state.strip(),
        "zip": payload.zip_code.strip(),
        "geocoded": ", ".join(filter(None, [
            payload.address.strip(), payload.city.strip(), payload.state.strip(), payload.zip_code.strip()
        ])),
    })
    new_key = f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
    now = _now()
    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"stops": project["stops"], "updated_at": now}},
    )
    state = await project_state_col.find_one({"project_id": project_id, "stop_key": old_key})
    if state and old_key != new_key:
        state["stop_key"] = new_key
        state["updatedAt"] = now
        await project_state_col.replace_one({"_id": state["_id"]}, state)
    return {"ok": True, "venue_code": payload.venue_code, "old_stop_key": old_key, "new_stop_key": new_key}


@api_router.patch("/projects/{project_id}/stops/details")
async def update_stop_details(project_id: str, payload: StopDetailsUpdate):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    project = await projects_col.find_one({"id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    matches = [stop for stop in project.get("stops", []) if str(stop.get("id", "")) == payload.stop_id]
    if len(matches) != 1:
        raise HTTPException(409, f"Expected one stop-id match, found {len(matches)}")

    stop = matches[0]
    old_key = payload.old_stop_key or f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
    if payload.addr is not None:
        address = payload.addr.strip()
        if not address:
            raise HTTPException(422, "Address cannot be blank")
        lookup = ", ".join(filter(None, [address, stop.get("city", ""), stop.get("state", ""), stop.get("zip", "")]))
        geo = google_geocode(lookup)
        if not geo.get("ok") or geo.get("partial"):
            raise HTTPException(422, {
                "message": "Address could not be verified by Google. Please enter a more specific address.",
                "google_status": geo.get("status"),
                "suggestions": geo.get("suggestions", []),
            })
        stop["addr"] = address
        stop["lat"] = geo.get("lat")
        stop["lng"] = geo.get("lng")
        stop["geocoded"] = geo.get("formatted") or lookup
    if payload.venue_type is not None:
        stop["venue_type"] = payload.venue_type.strip()
    if payload.dma is not None:
        stop["dma"] = payload.dma.strip()
    if payload.venue_code is not None:
        stop["venue_code"] = payload.venue_code.strip()

    new_key = f"atl-route-v2|{stop.get('installer','')}|{stop.get('id','')}|{stop.get('addr','')}|{stop.get('lat','')}|{stop.get('lng','')}"
    now = _now()
    await projects_col.update_one(
        {"id": project_id},
        {"$set": {"stops": project["stops"], "updated_at": now}},
    )

    state = await project_state_col.find_one({"project_id": project_id, "stop_key": old_key})
    state_update = {}
    if payload.venue_code is not None:
        state_update["venue_code"] = payload.venue_code.strip()
    if state:
        state.pop("_id", None)
        state["stop_key"] = new_key
        state["updatedAt"] = now
        state.update(state_update)
        if old_key != new_key:
            await project_state_col.replace_one({"project_id": project_id, "stop_key": old_key}, state)
        elif state_update:
            await project_state_col.update_one({"project_id": project_id, "stop_key": old_key}, {"$set": {**state_update, "updatedAt": now}})
    elif state_update:
        await project_state_col.update_one(
            {"project_id": project_id, "stop_key": new_key},
            {"$set": {**state_update, "project_id": project_id, "updatedAt": now}, "$setOnInsert": {"stop_key": new_key}},
            upsert=True,
        )

    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    bundle = project_to_routes(refreshed)
    return {"ok": True, "old_stop_key": old_key, "new_stop_key": new_key, "routes": bundle["routes"], "stats": bundle["stats"]}


@api_router.delete("/projects/{project_id}")
async def delete_project(project_id: str, confirm: str = ""):
    if project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    existing = await projects_col.find_one({"id": project_id})
    if not existing:
        raise HTTPException(404, "Project not found")
    # 2-step safeguard: require the client to echo back the exact project name.
    if (confirm or "").strip() != existing.get("name", "").strip():
        raise HTTPException(400, "Confirmation name does not match. Type the project name exactly to confirm deletion.")
    res = await projects_col.delete_one({"id": project_id})
    await project_state_col.delete_many({"project_id": project_id})
    return {"ok": res.deleted_count > 0, "deleted": existing.get("name")}


# ─── File parse / address validation ───
def _norm_col(c: str) -> str:
    return normalize_column(c)


@api_router.post("/projects/parse-file")
async def parse_file(file: UploadFile = File(...)):
    """Parse CSV/Excel file containing address, store_name, and PA columns.
    For each row, geocode the address and return suggestions if uncertain."""
    if not file.filename:
        raise HTTPException(422, "No file")
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "Empty file")
    name = file.filename.lower()
    try:
        if name.endswith(".csv"):
            df = read_csv_table(raw)
        else:
            df = pd.read_excel(io.BytesIO(raw), engine="openpyxl")
    except Exception as e:
        raise HTTPException(422, f"Could not parse file: {e}")

    df.columns = [_norm_col(c) for c in df.columns]
    # Column aliases
    addr_col = next((c for c in df.columns if c in ADDRESS_ALIASES), None)
    store_col = next((c for c in df.columns if c in STORE_ALIASES), None)
    pa_col = next((c for c in df.columns if c in PA_ALIASES), None)
    status_col = next((c for c in df.columns if c in STATUS_ALIASES), None)
    venue_type_col = next((c for c in df.columns if c in VENUE_TYPE_ALIASES), None)
    dma_col = next((c for c in df.columns if c in DMA_ALIASES), None)
    venue_code_col = next((c for c in df.columns if c in VENUE_CODE_ALIASES), None)
    if not addr_col:
        raise HTTPException(422, "Missing 'address' column")
    if not pa_col:
        raise HTTPException(422, "Missing required 'PA' column")
    rows = []
    for row_number, (_, r) in enumerate(df.iterrows()):
        addr = clean_cell(r.get(addr_col, ""))
        store = clean_cell(r.get(store_col, "")) if store_col else ""
        pa_name = clean_cell(r.get(pa_col, ""))
        venue_status, venue_status_valid = normalize_status(r.get(status_col, "")) if status_col else ("Incomplete", True)
        venue_fields = {
            "venue_status": venue_status,
            "venue_status_valid": venue_status_valid,
            "venue_status_raw": clean_cell(r.get(status_col, "")) if status_col else "",
            "venue_type": clean_cell(r.get(venue_type_col, "")) if venue_type_col else "",
            "dma": clean_cell(r.get(dma_col, "")) if dma_col else "",
            "venue_code": clean_cell(r.get(venue_code_col, "")) if venue_code_col else "",
        }
        if not pa_name:
            rows.append({"index": row_number, "address": addr, "store_name": store, "pa": "", "status": "invalid", "error": "Missing PA name", **venue_fields,
                         "verified_by": [], "place_name": "", "confidence": 0})
            continue
        if not addr:
            rows.append({"index": row_number, "address": "", "store_name": store, "pa": pa_name, "status": "invalid", "error": "Missing address", **venue_fields,
                         "verified_by": [], "place_name": "", "confidence": 0})
            continue

        # 1) Geocode the raw address
        geo = google_geocode(addr)
        # 2) Verify it's a real place via Places API (combine store name + address if available)
        place_query = f"{store}, {addr}" if store else addr
        place = google_place_find(place_query)

        verified_by: List[str] = []
        if geo.get("ok"):
            verified_by.append("geocoding")
        if place.get("ok"):
            verified_by.append("places")

        if geo.get("ok") and place.get("ok") and not geo.get("partial"):
            # Strongest match: both APIs confirmed
            rows.append({
                "index": row_number,
                "address": addr,
                "store_name": store,
                "pa": pa_name,
                "status": "valid",
                # The route address must come from geocoding the uploaded
                # address. A Places lookup using the store name may match a
                # different branch of the same business.
                "formatted": geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": place.get("name", ""),
                "place_id": place.get("place_id"),
                "business_status": place.get("business_status"),
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 100,
                **venue_fields,
            })
        elif geo.get("ok") and not geo.get("partial"):
            # Geocoded cleanly but no Places hit — still acceptable
            rows.append({
                "index": row_number,
                "address": addr,
                "store_name": store,
                "pa": pa_name,
                "status": "valid",
                "formatted": geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": "",
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 70,
                **venue_fields,
            })
        elif geo.get("ok") and geo.get("partial"):
            rows.append({
                "index": row_number,
                "address": addr,
                "store_name": store,
                "pa": pa_name,
                "status": "needs_review",
                "formatted": geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": place.get("name", "") if place.get("ok") else "",
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 40,
                "error": "Partial match — please review",
                **venue_fields,
            })
        else:
            rows.append({
                "index": row_number,
                "address": addr,
                "store_name": store,
                "pa": pa_name,
                "status": "needs_review",
                "suggestions": geo.get("suggestions", []) or google_autocomplete(addr),
                "verified_by": verified_by,
                "confidence": 0,
                "error": geo.get("error", "Could not geocode address"),
                **venue_fields,
            })

    valid = sum(1 for r in rows if r["status"] == "valid")
    pa_names = sorted({r["pa"] for r in rows if r.get("pa")})
    return {
        "ok": True,
        "rows": rows,
        "valid": valid,
        "needs_review": sum(1 for r in rows if r["status"] == "needs_review"),
        "pa_names": pa_names,
        "invalid": sum(1 for r in rows if r["status"] == "invalid"),
        "total": len(rows),
        "addr_column": addr_col,
        "store_column": store_col,
        "status_column": status_col,
        "venue_type_column": venue_type_col,
        "dma_column": dma_col,
        "venue_code_column": venue_code_col,
    }


# ─── State (stop status / comments / installer) ───
@api_router.get("/state")
async def get_state(project_id: Optional[str] = None) -> Dict[str, Any]:
    if project_id in EXTERNAL_PROJECT_IDS:
        query = {"$or": [{"project_id": project_id}, {"project_id": {"$exists": False}}]}
        collection = ara_state_col
    elif project_id:
        query = {"project_id": project_id}
        collection = project_state_col
    else:
        query = {}
        collection = project_state_col
    result: Dict[str, Any] = {}
    async for doc in collection.find(query):
        key = doc.get("stop_key")
        if not key: continue
        doc.pop("_id", None); doc.pop("stop_key", None)
        result[key] = doc
    return result


@api_router.post("/state")
async def upsert_state(payload: StopStatePayload):
    if not payload.stop_key:
        raise HTTPException(422, "stop_key required")
    if not payload.project_id:
        raise HTTPException(422, "project_id required")
    if payload.project_id in EXTERNAL_PROJECT_IDS:
        raise HTTPException(403, "This project is managed by another application")
    update = {k: v for k, v in payload.model_dump().items() if v is not None and k != "stop_key"}
    # Legacy ARA uses `modem`; Route Planner projects use `additional_task`.
    update.pop("modem", None)
    update["updatedAt"] = _now()
    await project_state_col.update_one(
        {"stop_key": payload.stop_key, "project_id": payload.project_id},
        {"$set": update, "$setOnInsert": {"stop_key": payload.stop_key}},
        upsert=True,
    )
    return {"ok": True, "stop_key": payload.stop_key, **update}


@app.on_event("startup")
async def on_startup():
    await project_state_col.create_index(
        [("project_id", 1), ("stop_key", 1)],
        unique=True,
        name="project_stop_unique",
    )
    logging.info("Route Planner API started; external shared-database projects are read-only and excluded.")


@app.on_event("shutdown")
async def on_shutdown():
    client.close()


app.include_router(api_router)
app.add_middleware(
    CORSMiddleware, allow_credentials=True,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
