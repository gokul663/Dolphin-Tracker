import os
import unittest
from unittest import mock

from dolphin_tracker.config import Settings


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
