"""API Lambda + worker Lambda behind an HTTP API, plus the files bucket.

Both functions deploy the same package built by backend/scripts/build_lambda.sh; only the handler differs.
"""
from pathlib import Path

import aws_cdk as cdk
from aws_cdk import Duration
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_ssm as ssm
from constructs import Construct

from config import EnvConfig

PACKAGE_DIR = Path(__file__).resolve().parents[2] / "backend" / "build" / "package"
RUNTIME = lambda_.Runtime.PYTHON_3_12
ARCH = lambda_.Architecture.ARM_64


def _code() -> lambda_.Code:
    """Use the built package when present; otherwise a placeholder so `cdk synth` works without a build."""
    if PACKAGE_DIR.is_dir():
        return lambda_.Code.from_asset(str(PACKAGE_DIR))
    print(f"[api_stack] {PACKAGE_DIR} not found; using placeholder code. Run `make build-lambda` before deploying.")
    return lambda_.Code.from_inline(
        "def handler(event, context):\n"
        "    return {'statusCode': 503, 'body': 'Lambda package not built'}\n"
    )


class ApiStack(cdk.Stack):
    def __init__(
        self, scope: Construct, construct_id: str, *, cfg: EnvConfig, table: dynamodb.ITableV2, **kwargs
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        cors_origins = cfg.allowed_origins()  # raises (fails synth) when empty or "*"

        files_bucket = s3.Bucket(
            self,
            "Files",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=cdk.RemovalPolicy.RETAIN if cfg.retain_data else cdk.RemovalPolicy.DESTROY,
            auto_delete_objects=not cfg.retain_data,
            lifecycle_rules=[
                s3.LifecycleRule(prefix="uploads/", expiration=Duration.days(7)),
                s3.LifecycleRule(prefix="jobs/", expiration=Duration.days(30)),
            ],
            cors=[
                s3.CorsRule(
                    allowed_methods=[s3.HttpMethods.PUT, s3.HttpMethods.GET],
                    allowed_origins=cors_origins,
                    allowed_headers=["*"],
                    max_age=3600,
                )
            ],
        )

        google_key = ssm.StringParameter.from_secure_string_parameter_attributes(
            self, "GoogleServerKey", parameter_name=cfg.ssm_google_server_key
        )

        code = _code()
        placeholder = not PACKAGE_DIR.is_dir()
        common_env = {
            "DT_APP_ENV": cfg.name,
            "DT_AWS_REGION": self.region,  # explicit; config.py would otherwise fall back to the runtime AWS_REGION
            "DT_TABLE_NAME": table.table_name,
            "DT_FILES_BUCKET": files_bucket.bucket_name,
            "DT_GOOGLE_SERVER_KEY_PARAM": cfg.ssm_google_server_key,
            "DT_CORS_ORIGINS": ",".join(cors_origins),
            "DT_GOOGLE_BROWSER_KEY": cfg.google_browser_key,
            "POWERTOOLS_SERVICE_NAME": "dolphin-tracker",
            "LOG_LEVEL": "INFO",
        }

        self.worker_fn = lambda_.Function(
            self,
            "Worker",
            log_group=_log_group(self, "WorkerLogs", cfg),
            runtime=RUNTIME,
            architecture=ARCH,
            handler="index.handler" if placeholder else "dolphin_tracker.handlers.worker.handler",
            code=code,
            memory_size=1769,  # one full vCPU: the optimizer is single-threaded Python
            timeout=Duration.minutes(15),
            environment=common_env,
            description="Import parsing/geocoding and routing builds (async jobs)",
        )

        self.api_fn = lambda_.Function(
            self,
            "Api",
            log_group=_log_group(self, "ApiLogs", cfg),
            runtime=RUNTIME,
            architecture=ARCH,
            handler="index.handler" if placeholder else "dolphin_tracker.handlers.api.handler",
            code=code,
            memory_size=1024,
            timeout=Duration.seconds(29),
            environment={**common_env, "DT_WORKER_FUNCTION_NAME": self.worker_fn.function_name},
            description="FastAPI via Mangum: all synchronous endpoints",
        )

        for fn in (self.api_fn, self.worker_fn):
            table.grant_read_write_data(fn)
            files_bucket.grant_read_write(fn)
            google_key.grant_read(fn)
        self.worker_fn.grant_invoke(self.api_fn)

        self.http_api = apigwv2.HttpApi(
            self,
            "HttpApi",
            api_name=f"dolphin-tracker-{cfg.name}",
            cors_preflight=apigwv2.CorsPreflightOptions(
                allow_origins=cors_origins,
                allow_methods=[apigwv2.CorsHttpMethod.ANY],
                allow_headers=["authorization", "content-type"],
                max_age=Duration.hours(1),
            ),
        )
        integration = integrations.HttpLambdaIntegration("ApiIntegration", self.api_fn)
        self.http_api.add_routes(path="/api", methods=[apigwv2.HttpMethod.ANY], integration=integration)
        self.http_api.add_routes(path="/api/{proxy+}", methods=[apigwv2.HttpMethod.ANY], integration=integration)

        cdk.CfnOutput(self, "HttpApiUrl", value=self.http_api.api_endpoint)
        cdk.CfnOutput(self, "FilesBucketName", value=files_bucket.bucket_name)


def _retention(days: int) -> logs.RetentionDays:
    """Round a day count up to the nearest RetentionDays member."""
    allowed = [
        (1, logs.RetentionDays.ONE_DAY), (3, logs.RetentionDays.THREE_DAYS), (5, logs.RetentionDays.FIVE_DAYS),
        (7, logs.RetentionDays.ONE_WEEK), (14, logs.RetentionDays.TWO_WEEKS), (30, logs.RetentionDays.ONE_MONTH),
        (60, logs.RetentionDays.TWO_MONTHS), (90, logs.RetentionDays.THREE_MONTHS),
        (180, logs.RetentionDays.SIX_MONTHS), (365, logs.RetentionDays.ONE_YEAR),
    ]
    return next((member for limit, member in allowed if limit >= days), logs.RetentionDays.ONE_YEAR)


def _log_group(scope: Construct, construct_id: str, cfg: EnvConfig) -> logs.LogGroup:
    return logs.LogGroup(
        scope,
        construct_id,
        retention=_retention(cfg.log_retention_days),
        removal_policy=cdk.RemovalPolicy.RETAIN if cfg.retain_data else cdk.RemovalPolicy.DESTROY,
    )
