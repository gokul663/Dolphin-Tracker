"""Copy v1 projects and stop progress from MongoDB into the v2 DynamoDB table, with a parity report.

    pip install 'pymongo>=4'          # script-only dependency (the `migrate` extra), never in the Lambda
    MONGO_URL=... DB_NAME=... DT_TABLE_NAME=dolphin-tracker-dev python scripts/migrate_from_mongo.py --dry-run

Reads `projects` and `route_planner_stop_states` (and, with --include-legacy, the shared `stop_states`
collection for `atlanta-default`). Re-running is safe: stop uids are derived from (project id, position, id),
and each migrated project's stops are replaced, not appended to.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from dolphin_tracker.config import get_settings
from dolphin_tracker.domain.migration import format_report, is_legacy, transform_project
from dolphin_tracker.repositories.dynamo import get_table
from dolphin_tracker.repositories.projects import DynamoProjectRepository
from dolphin_tracker.repositories.stores import DynamoStoreRepository


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mongo-url", default=os.environ.get("MONGO_URL", ""))
    parser.add_argument("--db", default=os.environ.get("DB_NAME", ""))
    parser.add_argument("--dry-run", action="store_true", help="transform and report; write nothing")
    parser.add_argument(
        "--include-legacy", action="store_true", help="also migrate atlanta-default (skipped by default)"
    )
    parser.add_argument("--project", action="append", default=[], help="only this project id (repeatable)")
    parser.add_argument("--report-json", help="also write the parity report as JSON to this path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.mongo_url or not args.db:
        print("Set --mongo-url/--db or MONGO_URL/DB_NAME", file=sys.stderr)
        return 2
    try:
        from pymongo import MongoClient
    except ImportError:
        print("pymongo is required: pip install 'pymongo>=4'", file=sys.stderr)
        return 2

    database = MongoClient(args.mongo_url)[args.db]
    query = {"id": {"$in": args.project}} if args.project else {}
    reports = []
    projects = stores = None
    if not args.dry_run:
        table = get_table(get_settings())
        projects, stores = DynamoProjectRepository(table), DynamoStoreRepository(table)

    for doc in database["projects"].find(query, {"_id": 0}).sort("created_at", 1):
        project_id = str(doc.get("id", ""))
        if is_legacy(project_id) and not args.include_legacy:
            print(f"skip legacy project {project_id} (pass --include-legacy to migrate it)")
            continue
        if is_legacy(project_id):
            states = list(database["stop_states"].find(
                {"$or": [{"project_id": project_id}, {"project_id": {"$exists": False}}]}, {"_id": 0}
            ))
        else:
            states = list(database["route_planner_stop_states"].find({"project_id": project_id}, {"_id": 0}))
        migrated = transform_project(doc, states)
        reports.append(migrated.report)
        if projects is not None and stores is not None:
            stores.delete_all(project_id)
            stores.put_many(project_id, migrated.stops)
            projects.put(migrated.project)
            print(f"migrated {project_id}: {len(migrated.stops)} stops")

    print()
    print(("DRY RUN — nothing written\n" if args.dry_run else "") + format_report(reports))
    if args.report_json:
        with open(args.report_json, "w") as handle:
            json.dump(
                [
                    {
                        "project_id": r.project_id, "name": r.name, "stops": r.stops, "states": r.states,
                        "matched_states": r.matched_states, "orphan_states": r.orphan_states,
                        "repaired_addresses": r.repaired_addresses, "extra_fields": r.extra_fields,
                        "kpi_matches": r.kpi_matches,
                        "old_kpi": r.old_kpi.model_dump() if r.old_kpi else None,
                        "new_kpi": r.new_kpi.model_dump() if r.new_kpi else None,
                    }
                    for r in reports
                ],
                handle,
                indent=2,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
