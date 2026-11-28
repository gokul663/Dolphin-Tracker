"""Writes Tracker's log entries to the shared log collection (domain/cms_log.py). Insert only: nothing in that
collection is ever changed or removed from here.

Off unless DT_CMS_LOG_WRITE is on, so a local run or a test environment pointed at the same database never adds
entries to it. A failed write is not an error for the person logging: the entry is already saved in Tracker, stays
marked as not written, and is sent again the next time something is logged at that store."""
from __future__ import annotations

from aws_lambda_powertools import Logger

from dolphin_tracker.domain.cms_log import CmsLog
from dolphin_tracker.repositories.device_data import DeviceDataSource, DeviceDataUnavailable

logger = Logger(child=True)


class CmsLogWriter:
    def __init__(self, source: DeviceDataSource | None, *, enabled: bool) -> None:
        self._source = source
        self.enabled = enabled and source is not None

    def write(self, log: CmsLog) -> bool:
        """True when the entry is in the collection now (just added, or already there)."""
        if not self.enabled or self._source is None:
            return False
        try:
            self._source.add_log(log)
        except DeviceDataUnavailable as exc:
            logger.warning(
                "Log entry not written to the log collection",
                extra={"tracker_id": log.get("tracker_id"), "detail": str(exc)},
            )
            return False
        return True
