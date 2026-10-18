"""AGENT-HANDOFF §2 rule 1, enforced on imports: services have no boto3, domain has no I/O layers."""
import ast
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "dolphin_tracker"


def imported_modules(path: Path) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def offenders(layer: str, forbidden: tuple[str, ...]) -> dict[str, list[str]]:
    found = {}
    for path in sorted((PACKAGE / layer).glob("*.py")):
        bad = sorted(module for module in imported_modules(path) if module.startswith(forbidden))
        if bad:
            found[path.name] = bad
    return found


class LayeringTests(unittest.TestCase):
    def test_services_do_not_touch_boto3_or_the_dynamo_helpers(self):
        self.assertEqual(
            offenders("services", ("boto3", "botocore", "dolphin_tracker.repositories.dynamo")), {}
        )

    def test_domain_is_pure(self):
        layers = ("dolphin_tracker.repositories", "dolphin_tracker.services", "dolphin_tracker.api")
        self.assertEqual(offenders("domain", ("boto3", "botocore", *layers)), {})
