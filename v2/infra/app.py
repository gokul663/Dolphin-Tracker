#!/usr/bin/env python3
"""CDK entry point. Select the environment with `-c env=dev|prod` (default dev)."""
import os

import aws_cdk as cdk

from config import CONTEXT_OVERRIDES, load
from stacks.api_stack import ApiStack
from stacks.data_stack import DataStack
from stacks.web_stack import WebStack

app = cdk.App()
env_name = app.node.try_get_context("env") or "dev"
cfg = load(env_name, {key: app.node.try_get_context(key) for key in CONTEXT_OVERRIDES})

aws_env = cdk.Environment(
    account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
    region=os.environ.get("CDK_DEFAULT_REGION", "us-east-1"),
)

data = DataStack(app, f"{cfg.prefix}-Data", cfg=cfg, env=aws_env)
api = ApiStack(app, f"{cfg.prefix}-Api", cfg=cfg, table=data.table, env=aws_env)
WebStack(app, f"{cfg.prefix}-Web", cfg=cfg, http_api=api.http_api, env=aws_env)

for stack in (data, api):
    cdk.Tags.of(stack).add("project", "dolphin-tracker")
    cdk.Tags.of(stack).add("env", cfg.name)

app.synth()
