"""Create the single table in DynamoDB Local (or any endpoint in DT_DYNAMODB_ENDPOINT_URL). Idempotent."""
from botocore.exceptions import ClientError

from dolphin_tracker.config import get_settings
from dolphin_tracker.repositories.dynamo import TABLE_DEFINITION, dynamodb_resource


def main() -> None:
    settings = get_settings()
    resource = dynamodb_resource(settings)
    try:
        table = resource.create_table(TableName=settings.table_name, **TABLE_DEFINITION)
        table.wait_until_exists()
        table.meta.client.update_time_to_live(
            TableName=settings.table_name, TimeToLiveSpecification={"Enabled": True, "AttributeName": "ttl"}
        )
        print(f"Created table {settings.table_name} at {settings.dynamodb_endpoint_url or 'AWS'}")
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ResourceInUseException":
            raise
        print(f"Table {settings.table_name} already exists")


if __name__ == "__main__":
    main()
