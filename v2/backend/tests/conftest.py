import os

# Settings and moto both read these at import time, so set them before any dolphin_tracker import.
os.environ.setdefault("DT_APP_ENV", "test")
os.environ.setdefault("DT_TABLE_NAME", "dolphin-tracker-test")
os.environ.setdefault("DT_CORS_ORIGINS", "http://testserver")
os.environ["DT_GOOGLE_SERVER_KEY"] = ""  # never call Google from tests, whatever .env holds
os.environ["DT_GOOGLE_SERVER_KEY_PARAM"] = ""
os.environ["DT_MONGO_URI"] = ""  # never read the real device report from tests either
os.environ["DT_MONGO_URI_SECRET"] = ""
os.environ["DT_DEVICE_DATA_FUNCTION_NAME"] = ""
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SECURITY_TOKEN", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
