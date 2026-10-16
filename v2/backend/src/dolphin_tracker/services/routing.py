"""Routing boundary around the v1 optimizer. The algorithm is unchanged; this adapts models in and out."""
from __future__ import annotations

from dolphin_tracker.domain.models import Stop
from dolphin_tracker.domain.route_optimizer import build_project_routes

Assignment = tuple[str, int, int]  # installer, day (1-based), seq (0-based within the day)


class RoutingService:
    @staticmethod
    def build_assignments(stops: list[Stop], installers: list[str], per_day: int) -> dict[str, Assignment]:
        """Run the optimizer over the given stops. Returns uid -> (installer, day, seq). Pure and synchronous."""
        rows = [{"id": stop.uid, "lat": stop.lat, "lng": stop.lng, "state": stop.state} for stop in stops]
        routes = build_project_routes(rows, installers, per_day)
        assignments: dict[str, Assignment] = {}
        for installer, days in routes.items():
            for day_number, day in enumerate(days, start=1):
                for seq, row in enumerate(day):
                    assignments[str(row["id"])] = (installer, day_number, seq)
        return assignments

    @staticmethod
    def diff(stops: list[Stop], assignments: dict[str, Assignment]) -> list[tuple[str, dict[str, object]]]:
        """Only the stops whose (installer, day, seq) changed. Progress fields are never part of a routing write."""
        changes: list[tuple[str, dict[str, object]]] = []
        for stop in stops:
            installer, day, seq = assignments.get(stop.uid, (stop.installer, stop.day, stop.seq))
            if (installer, day, seq) != (stop.installer, stop.day, stop.seq):
                changes.append((stop.uid, {"installer": installer, "day": day, "seq": seq}))
        return changes

    def run_build(self, project_id: str) -> None:
        """Worker entry point for a routing_build job."""
        raise NotImplementedError(
            "Phase 2: load META + stops, build_assignments, fence on META.version, "
            "write diffs, set routing_status=ready"
        )
