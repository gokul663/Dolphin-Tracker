import os
import unittest
from unittest import mock

import boto3
from moto import mock_aws

from dolphin_tracker.config import Settings, resolve_mongo_uri


class RegionSettingTests(unittest.TestCase):
    def settings(self, **env: str) -> Settings:
        clean = {key: value for key, value in os.environ.items() if key not in {"AWS_REGION", "DT_AWS_REGION"}}
        with mock.patch.dict(os.environ, {**clean, **env}, clear=True):
            return Settings(_env_file=None)

    def test_defaults_to_us_east_1(self):
        self.assertEqual(self.settings().aws_region, "us-east-1")

    def test_falls_back_to_the_lambda_runtime_region(self):
        self.assertEqual(self.settings(AWS_REGION="eu-west-1").aws_region, "eu-west-1")

    def test_dt_aws_region_wins(self):
        self.assertEqual(self.settings(AWS_REGION="eu-west-1", DT_AWS_REGION="ap-south-1").aws_region, "ap-south-1")

    def test_init_by_field_name_still_works(self):
        self.assertEqual(Settings(_env_file=None, aws_region="us-west-2").aws_region, "us-west-2")


class MongoUriTests(unittest.TestCase):
    def test_empty_when_not_configured(self):
        self.assertEqual(resolve_mongo_uri(Settings(_env_file=None, mongo_uri="", mongo_uri_secret="")), "")

    def test_direct_value_wins(self):
        settings = Settings(_env_file=None, mongo_uri="mongodb://local", mongo_uri_secret="/dt/test/ignored")
        self.assertEqual(resolve_mongo_uri(settings), "mongodb://local")

    @mock_aws
    def test_reads_the_secret_when_only_a_name_is_set(self):
        boto3.client("secretsmanager", region_name="us-east-1").create_secret(
            Name="/dt/test/mongodb-uri", SecretString="mongodb://from-secret\n"
        )
        name = "/dt/test/mongodb-uri"
        settings = Settings(_env_file=None, aws_region="us-east-1", mongo_uri="", mongo_uri_secret=name)
        self.assertEqual(resolve_mongo_uri(settings), "mongodb://from-secret")
