"""Move each project's per-project routes into an active route plan (ROUTE-PLANNER RP8).

    DT_TABLE_NAME=dolphin-tracker-dev python scripts/migrate_project_routes.py --start-date 2026-11-09 --dry-run

For every project with routed stores that still need a visit, one plan "<project> (from project routes)" is
created: same installers, each store keeps its installer, day order and visiting order, and each installer
starts from their first stop (edit the starts in the plan afterwards). Stores already in a plan are skipped and
reported, so re-running only picks up what is left.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date

from dolphin_tracker.config import get_settings
from dolphin_tracker.repositories.dynamo import get_table
from dolphin_tracker.repositories.lists import DynamoListRepository
from dolphin_tracker.repositories.projects import DynamoProjectRepository
from dolphin_tracker.repositories.route_plans import DynamoRoutePlanRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository
from dolphin_tracker.services.lists import ListService
from dolphin_tracker.services.route_plans import RoutePlanService


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start-date", default=date.today().isoformat(), help="day 1 of each new plan (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="report what would move; write nothing")
    parser.add_argument("--project", action="append", default=[], help="only this project id (repeatable)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    table = get_table(get_settings())
    projects = DynamoProjectRepository(table)
    service = RoutePlanService(
        DynamoRoutePlanRepository(table), DynamoStoreRepository(table), projects,
        ListService(DynamoListRepository(table)),
    )
    ids = args.project
    if not ids:
        cursor = None
        while True:
            page = projects.list(limit=100, cursor=cursor)
            ids.extend(project.id for project in page.items)
            if not page.next_cursor:
                break
            cursor = page.next_cursor
    for project_id in ids:
        result = service.import_project_routes(project_id, args.start_date, dry_run=args.dry_run)
        if result is None:
            print(f"{project_id}: nothing routed, skipped")
            continue
        plan = result.bundle.plan
        verb = "would create" if args.dry_run else "created"
        print(f"{project_id}: {verb} plan {plan.name!r} ({plan.id}) with {plan.store_count} stores, "
              f"{len(plan.installers)} installers; {len(result.skipped)} already in a plan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
