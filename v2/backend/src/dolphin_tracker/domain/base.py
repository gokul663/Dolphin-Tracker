"""Shared pydantic base for every record the API sends or receives."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ApiModel(BaseModel):
    """Fields with defaults are still *required* in the response (serialization) schema, because the server
    always sends them; the generated TypeScript types then need no `undefined` checks. Request schemas keep
    their defaults, so clients may still omit those fields."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
