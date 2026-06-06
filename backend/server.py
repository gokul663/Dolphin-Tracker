from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os, io, json, math, uuid, logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import pandas as pd
import requests

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]
projects_col = db["projects"]
state_col = db["stop_states"]

GOOGLE_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
STOPS_PER_DAY = 9

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


class ProjectCreate(BaseModel):
    name: str
    pa: str = ""
    installers: List[str] = Field(default_factory=list)
    stops: List[Dict[str, Any]] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    pa: Optional[str] = None
    installers: Optional[List[str]] = None
    confirm_name: Optional[str] = None  # For 2-step destructive ops


class StopStatePayload(BaseModel):
    stop_key: str
    project_id: Optional[str] = None
    store_name: Optional[str] = None
    brand: Optional[str] = None
    installer_name: Optional[str] = None
    status: Optional[str] = None
    comment: Optional[str] = None
    modem: Optional[bool] = None
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


def split_into_days(stops: List[dict], per_day: int = STOPS_PER_DAY) -> List[List[dict]]:
    if not stops:
        return []
    ordered = nearest_neighbor_order([s for s in stops if s.get("lat") is not None and s.get("lng") is not None])
    days = [ordered[i:i + per_day] for i in range(0, len(ordered), per_day)]
    return days


def project_to_routes(project: dict) -> Dict[str, Any]:
    """Group project stops by installer → days. Re-cluster if no day info."""
    stops = project.get("stops", [])
    installers = project.get("installers") or list({s.get("installer", "") for s in stops if s.get("installer")})
    routes: Dict[str, List[List[dict]]] = {}
    stats: Dict[str, dict] = {}
    has_days = any(s.get("day") for s in stops)
    for inst in installers:
        if not inst:
            continue
        inst_stops = [s for s in stops if s.get("installer") == inst]
        if has_days:
            by_day: Dict[int, List[dict]] = {}
            for s in inst_stops:
                by_day.setdefault(int(s.get("day", 1)), []).append(s)
            days = [by_day[k] for k in sorted(by_day.keys())]
        else:
            days = split_into_days(inst_stops)
        # Inject region
        for d in days:
            for s in d:
                s.setdefault("assigned_region", "")
        routes[inst] = days
        total = sum(len(d) for d in days)
        stats[inst] = {
            "total": total,
            "days": len(days),
            "avg_stops": round(total / len(days), 1) if days else 0,
        }
    return {"routes": routes, "stats": stats}


def kpi_summary(project: dict, states: Dict[str, dict]) -> dict:
    stops = project.get("stops", [])
    by_status = {"Complete": 0, "Incomplete": 0, "Technical Issue": 0, "Other": 0}
    by_installer: Dict[str, int] = {}
    for s in stops:
        key = f"atl-route-v2|{s.get('installer','')}|{s.get('id','')}|{s.get('addr','')}|{s.get('lat','')}|{s.get('lng','')}"
        st = states.get(key, {})
        status = st.get("status", "Incomplete")
        by_status[status] = by_status.get(status, 0) + 1
        inst = st.get("installer_name") or s.get("installer", "")
        if inst:
            by_installer[inst] = by_installer.get(inst, 0) + 1
    return {
        "total": len(stops),
        "complete": by_status.get("Complete", 0),
        "pending": by_status.get("Incomplete", 0),
        "technical": by_status.get("Technical Issue", 0),
        "other": by_status.get("Other", 0),
        "by_installer": by_installer,
        "by_status": by_status,
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
    # Build per-project state lookups. For atlanta-default we accept legacy
    # docs (no project_id) plus those tagged atlanta-default.
    all_states: List[dict] = []
    async for d in state_col.find({}):
        d.pop("_id", None)
        all_states.append(d)

    projects = []
    async for p in projects_col.find({}, {"_id": 0}).sort("created_at", -1):
        pid = p["id"]
        if pid == "atlanta-default":
            scoped = {d.get("stop_key"): d for d in all_states if not d.get("project_id") or d.get("project_id") == "atlanta-default"}
        else:
            scoped = {d.get("stop_key"): d for d in all_states if d.get("project_id") == pid}
        kpi = kpi_summary(p, scoped)
        projects.append({
            "id": pid,
            "name": p.get("name"),
            "pa": p.get("pa", ""),
            "installers": p.get("installers", []),
            "created_at": p.get("created_at"),
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
        "installers": p.get("installers", []),
        "routes": bundle["routes"],
        "stats": bundle["stats"],
    }


@api_router.post("/projects")
async def create_project(payload: ProjectCreate):
    if not payload.name.strip():
        raise HTTPException(422, "Project name required")
    # If stops don't have installer assignment yet, round-robin distribute
    stops = [dict(s) for s in payload.stops]
    if payload.installers and not any(s.get("installer") for s in stops):
        for i, s in enumerate(stops):
            s["installer"] = payload.installers[i % len(payload.installers)]
    # Assign days per installer if not assigned
    if not any(s.get("day") for s in stops):
        new_stops = []
        for inst in payload.installers or list({s.get("installer", "") for s in stops if s.get("installer")}):
            inst_stops = [s for s in stops if s.get("installer") == inst and s.get("lat") is not None]
            for d_idx, day_stops in enumerate(split_into_days(inst_stops), start=1):
                for s in day_stops:
                    s["day"] = d_idx
                    new_stops.append(s)
        # Include any stops without coords (unassigned)
        for s in stops:
            if s.get("lat") is None:
                s["day"] = 1
                new_stops.append(s)
        stops = new_stops

    project = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "pa": payload.pa.strip(),
        "installers": payload.installers,
        "stops": stops,
        "created_at": _now(),
        "updated_at": _now(),
    }
    await projects_col.insert_one(project)
    return {"ok": True, "id": project["id"], "name": project["name"], "stop_count": len(stops)}


@api_router.patch("/projects/{project_id}")
async def update_project(project_id: str, payload: ProjectUpdate):
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
    if payload.installers is not None:
        update["installers"] = payload.installers
    if not update:
        raise HTTPException(422, "No fields to update")
    update["updated_at"] = _now()
    await projects_col.update_one({"id": project_id}, {"$set": update})
    refreshed = await projects_col.find_one({"id": project_id}, {"_id": 0})
    return {"ok": True, "project": refreshed}


@api_router.delete("/projects/{project_id}")
async def delete_project(project_id: str, confirm: str = ""):
    existing = await projects_col.find_one({"id": project_id})
    if not existing:
        raise HTTPException(404, "Project not found")
    # 2-step safeguard: require the client to echo back the exact project name.
    if (confirm or "").strip() != existing.get("name", "").strip():
        raise HTTPException(400, "Confirmation name does not match. Type the project name exactly to confirm deletion.")
    res = await projects_col.delete_one({"id": project_id})
    # Also wipe any project-scoped states (legacy atlanta-default docs are untouched)
    await state_col.delete_many({"project_id": project_id})
    return {"ok": res.deleted_count > 0, "deleted": existing.get("name")}


# ─── File parse / address validation ───
def _norm_col(c: str) -> str:
    return str(c).strip().lower().replace(" ", "_")


@api_router.post("/projects/parse-file")
async def parse_file(file: UploadFile = File(...)):
    """Parse CSV/Excel file containing 'address' and 'store_name' columns.
    For each row, geocode the address and return suggestions if uncertain."""
    if not file.filename:
        raise HTTPException(422, "No file")
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "Empty file")
    name = file.filename.lower()
    try:
        if name.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(raw))
        else:
            df = pd.read_excel(io.BytesIO(raw), engine="openpyxl")
    except Exception as e:
        raise HTTPException(422, f"Could not parse file: {e}")

    df.columns = [_norm_col(c) for c in df.columns]
    # Column aliases
    addr_aliases = ["address", "addr", "street_address", "site_address"]
    store_aliases = ["store_name", "store", "site_name", "name"]
    addr_col = next((c for c in addr_aliases if c in df.columns), None)
    store_col = next((c for c in store_aliases if c in df.columns), None)
    if not addr_col:
        raise HTTPException(422, "Missing 'address' column")

    rows = []
    for idx, r in df.iterrows():
        addr = str(r.get(addr_col, "")).strip()
        store = str(r.get(store_col, "")).strip() if store_col else ""
        if not addr or addr.lower() == "nan":
            rows.append({"index": int(idx), "address": "", "store_name": store, "status": "invalid", "error": "Missing address",
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
                "index": int(idx),
                "address": addr,
                "store_name": store,
                "status": "valid",
                "formatted": place.get("formatted") or geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": place.get("name", ""),
                "place_id": place.get("place_id"),
                "business_status": place.get("business_status"),
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 100,
            })
        elif geo.get("ok") and not geo.get("partial"):
            # Geocoded cleanly but no Places hit — still acceptable
            rows.append({
                "index": int(idx),
                "address": addr,
                "store_name": store,
                "status": "valid",
                "formatted": geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": "",
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 70,
            })
        elif geo.get("ok") and geo.get("partial"):
            rows.append({
                "index": int(idx),
                "address": addr,
                "store_name": store,
                "status": "needs_review",
                "formatted": geo["formatted"],
                "lat": geo["lat"], "lng": geo["lng"],
                "place_name": place.get("name", "") if place.get("ok") else "",
                "suggestions": geo.get("suggestions", []),
                "verified_by": verified_by,
                "confidence": 40,
                "error": "Partial match — please review",
            })
        else:
            rows.append({
                "index": int(idx),
                "address": addr,
                "store_name": store,
                "status": "needs_review",
                "suggestions": geo.get("suggestions", []) or google_autocomplete(addr),
                "verified_by": verified_by,
                "confidence": 0,
                "error": geo.get("error", "Could not geocode address"),
            })

    valid = sum(1 for r in rows if r["status"] == "valid")
    return {
        "ok": True,
        "rows": rows,
        "valid": valid,
        "needs_review": sum(1 for r in rows if r["status"] == "needs_review"),
        "invalid": sum(1 for r in rows if r["status"] == "invalid"),
        "total": len(rows),
        "addr_column": addr_col,
        "store_column": store_col,
    }


# ─── State (stop status / comments / installer) ───
@api_router.get("/state")
async def get_state(project_id: Optional[str] = None) -> Dict[str, Any]:
    # Backward-compat: production docs may have no project_id field.
    # For atlanta-default (the seeded prod project), return both legacy docs
    # (project_id missing) AND docs explicitly tagged atlanta-default.
    if project_id == "atlanta-default":
        query = {"$or": [{"project_id": "atlanta-default"}, {"project_id": {"$exists": False}}]}
    elif project_id:
        query = {"project_id": project_id}
    else:
        query = {}
    result: Dict[str, Any] = {}
    async for doc in state_col.find(query):
        key = doc.get("stop_key")
        if not key: continue
        doc.pop("_id", None); doc.pop("stop_key", None)
        result[key] = doc
    return result


@api_router.post("/state")
async def upsert_state(payload: StopStatePayload):
    if not payload.stop_key:
        raise HTTPException(422, "stop_key required")
    update = {k: v for k, v in payload.model_dump().items() if v is not None and k != "stop_key"}
    # For the seeded production project, don't pollute legacy docs with project_id
    if update.get("project_id") == "atlanta-default":
        update.pop("project_id", None)
    update["updatedAt"] = _now()
    await state_col.update_one(
        {"stop_key": payload.stop_key},
        {"$set": update, "$setOnInsert": {"stop_key": payload.stop_key}},
        upsert=True,
    )
    return {"ok": True, "stop_key": payload.stop_key, **update}


# ─────────────────────────── SEED ─────────────────────────────
async def seed_atlanta_project():
    # Only seed when the projects collection is brand new (no projects at all).
    # Avoids re-creating atlanta-default if the user has deliberately deleted it.
    count = await projects_col.count_documents({})
    if count > 0:
        return
    seed_path = ROOT_DIR / "atlanta_seed.json"
    if not seed_path.exists():
        logging.warning("atlanta_seed.json missing; skipping seed.")
        return
    with open(seed_path) as f:
        seed = json.load(f)
    seed["created_at"] = _now()
    seed["updated_at"] = _now()
    await projects_col.insert_one(seed)
    logging.info("Seeded Atlanta default project.")


@app.on_event("startup")
async def on_startup():
    await seed_atlanta_project()


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
