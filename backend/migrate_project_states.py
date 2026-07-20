"""Copy Route Planner state records out of the legacy ARA collection.

This migration never updates or deletes documents in ``stop_states``.
"""

import asyncio

from backend.server import EXTERNAL_PROJECT_IDS, ara_state_col, client, project_state_col


async def migrate() -> None:
    await project_state_col.create_index(
        [("project_id", 1), ("stop_key", 1)],
        unique=True,
        name="project_stop_unique",
    )
    query = {"project_id": {"$exists": True, "$nin": list(EXTERNAL_PROJECT_IDS)}}
    copied = 0
    async for document in ara_state_col.find(query):
        document.pop("_id", None)
        if "modem" in document:
            document["additional_task"] = document.pop("modem")
        await project_state_col.replace_one(
            {
                "project_id": document["project_id"],
                "stop_key": document.get("stop_key"),
            },
            document,
            upsert=True,
        )
        copied += 1
    print(f"Copied {copied} project state records to route_planner_stop_states")


if __name__ == "__main__":
    try:
        asyncio.run(migrate())
    finally:
        client.close()
