"""Lambda entry point for the HTTP API."""
from aws_lambda_powertools import Logger
from mangum import Mangum

from dolphin_tracker.api.app import create_app

logger = Logger()
_asgi = Mangum(create_app(), lifespan="off")


@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    return _asgi(event, context)
