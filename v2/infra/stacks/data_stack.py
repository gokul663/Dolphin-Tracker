"""Single DynamoDB table. Key design is documented in docs/PLAN.md → "DynamoDB single table"."""
import aws_cdk as cdk
from aws_cdk import aws_dynamodb as dynamodb
from constructs import Construct

from config import EnvConfig


class DataStack(cdk.Stack):
    def __init__(self, scope: Construct, construct_id: str, *, cfg: EnvConfig, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.table = dynamodb.TableV2(
            self,
            "Table",
            table_name=f"dolphin-tracker-{cfg.name}",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            time_to_live_attribute="ttl",
            removal_policy=cdk.RemovalPolicy.RETAIN if cfg.retain_data else cdk.RemovalPolicy.DESTROY,
            global_secondary_indexes=[
                # Sparse index: only project META items carry GSI1PK/GSI1SK. Lists projects newest first.
                dynamodb.GlobalSecondaryIndexPropsV2(
                    index_name="GSI1",
                    partition_key=dynamodb.Attribute(name="GSI1PK", type=dynamodb.AttributeType.STRING),
                    sort_key=dynamodb.Attribute(name="GSI1SK", type=dynamodb.AttributeType.STRING),
                    projection_type=dynamodb.ProjectionType.ALL,
                ),
            ],
        )

        cdk.CfnOutput(self, "TableName", value=self.table.table_name)
