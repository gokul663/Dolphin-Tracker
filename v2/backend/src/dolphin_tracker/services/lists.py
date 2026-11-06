"""Pick lists (ROUTE-PLANNER §2, §5). Installers and managers grow when a new name is typed; categories are a
tree that starts from the offline portal's defaults."""
from __future__ import annotations

from dolphin_tracker.domain.errors import ValidationFailed
from dolphin_tracker.domain.lists import (
    Category,
    NameEntry,
    NameListKind,
    check_categories,
    clean_name,
    default_categories,
    find_subcategory,
)
from dolphin_tracker.domain.models import Page
from dolphin_tracker.repositories.lists import ListRepository


class ListService:
    def __init__(self, lists: ListRepository) -> None:
        self._lists = lists

    def names(self, kind: NameListKind, *, limit: int = 200, cursor: str | None = None) -> Page[NameEntry]:
        return self._lists.list_names(kind, limit=limit, cursor=cursor)

    def add_name(self, kind: NameListKind, value: str) -> NameEntry:
        name = clean_name(value)
        if not name:
            raise ValidationFailed("A name is required")
        return self._lists.add_name(kind, name)

    def remember(self, kind: NameListKind, value: str) -> None:
        """Add a typed name if it is new; blank is ignored (used by the visit and route-plan writes)."""
        if clean_name(value):
            self.add_name(kind, value)

    def delete_name(self, kind: NameListKind, value: str) -> None:
        self._lists.delete_name(kind, value)

    def categories(self) -> list[Category]:
        stored = self._lists.get_categories()
        return stored if stored is not None else default_categories()

    def replace_categories(self, categories: list[Category]) -> list[Category]:
        cleaned = [category.model_copy(update={"name": clean_name(category.name)}) for category in categories]
        errors = check_categories(cleaned)
        if errors:
            raise ValidationFailed(errors[0], errors=errors)
        self._lists.put_categories(cleaned)
        return cleaned

    def resolve_category(self, category: str, subcategory: str) -> tuple[str, str]:
        """The canonical spelling of a submitted pair; 422 if the pair is not in the tree."""
        found = find_subcategory(self.categories(), category, subcategory)
        if found is None:
            raise ValidationFailed(
                f'"{subcategory}" is not a subcategory of "{category}"', fields={"subcategory": "Not in the list"}
            )
        return found
