"""Static frontend on S3 behind CloudFront, with /api/* forwarded to the HTTP API."""
from pathlib import Path

import aws_cdk as cdk
from aws_cdk import Duration
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3deploy
from constructs import Construct

from config import EnvConfig

DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"


class WebStack(cdk.Stack):
    def __init__(
        self, scope: Construct, construct_id: str, *, cfg: EnvConfig, http_api: apigwv2.IHttpApi, **kwargs
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        site_bucket = s3.Bucket(
            self,
            "Site",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=cdk.RemovalPolicy.RETAIN if cfg.retain_data else cdk.RemovalPolicy.DESTROY,
            auto_delete_objects=not cfg.retain_data,
        )

        api_domain = cdk.Fn.select(2, cdk.Fn.split("/", http_api.api_endpoint))
        api_origin = origins.HttpOrigin(api_domain, protocol_policy=cloudfront.OriginProtocolPolicy.HTTPS_ONLY)

        certificate = (
            acm.Certificate.from_certificate_arn(self, "Cert", cfg.certificate_arn)
            if cfg.domain_name and cfg.certificate_arn
            else None
        )

        self.distribution = cloudfront.Distribution(
            self,
            "Distribution",
            default_root_object="index.html",
            domain_names=[cfg.domain_name] if cfg.domain_name else None,
            certificate=certificate,
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
            ),
            additional_behaviors={
                "/api/*": cloudfront.BehaviorOptions(
                    origin=api_origin,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                    cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                    origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                ),
            },
            # Single-page app: unknown paths fall through to index.html.
            error_responses=[
                cloudfront.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html", ttl=Duration.minutes(5)),
                cloudfront.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html", ttl=Duration.minutes(5)),
            ],
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
        )

        if DIST_DIR.is_dir():
            s3deploy.BucketDeployment(
                self,
                "DeploySite",
                sources=[s3deploy.Source.asset(str(DIST_DIR))],
                destination_bucket=site_bucket,
                distribution=self.distribution,
                distribution_paths=["/*"],
            )
        else:
            print(f"[web_stack] {DIST_DIR} not found; skipping site upload. Run `make frontend-build` before deploying.")

        cdk.CfnOutput(self, "DistributionDomain", value=self.distribution.distribution_domain_name)
        cdk.CfnOutput(self, "SiteBucketName", value=site_bucket.bucket_name)
