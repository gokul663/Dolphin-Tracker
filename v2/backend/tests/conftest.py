import os

# Settings and moto both read these at import time, so set them before any dolphin_tracker import.
os.environ.setdefault("DT_APP_ENV", "test")
os.environ.setdefault("DT_TABLE_NAME", "dolphin-tracker-test")
os.environ.setdefault("DT_CORS_ORIGINS", "http://testserver")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SECURITY_TOKEN", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
