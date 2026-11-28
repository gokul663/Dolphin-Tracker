"""A store's tag: the project manager's escalation marker, separate from status. Each project keeps its own list of
tag options (Settings); a store carries one of them, or none. Pure."""
from __future__ import annotations

from collections.abc import Iterable

DEFAULT_TAG_OPTIONS = ("To Do", "In progress", "Done")
MAX_TAG_LENGTH = 50
MAX_TAG_OPTIONS = 30


def clean_tag(value: object) -> str:
    """Trimmed, inner whitespace collapsed."""
    return " ".join(str(value or "").split())


def clean_tag_options(values: Iterable[object]) -> list[str]:
    """The options as Settings saves them: cleaned, blanks dropped, the first spelling of a repeat kept."""
    seen: set[str] = set()
    options: list[str] = []
    for value in values:
        tag = clean_tag(value)
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            options.append(tag)
    return options


def tag_options_problem(options: list[str]) -> str:
    """Why this list of options cannot be saved ("" when it can)."""
    if len(options) > MAX_TAG_OPTIONS:
        return f"A project can have at most {MAX_TAG_OPTIONS} tags"
    long = next((tag for tag in options if len(tag) > MAX_TAG_LENGTH), None)
    return f"Tag {long[:20]}… is longer than {MAX_TAG_LENGTH} characters" if long else ""


def tag_problem(tag: str, options: Iterable[str], current: str) -> str:
    """Why a store may not take this tag ("" when it may): it must be one of the project's options, or empty. The
    store's current tag stays allowed after it is removed from the options, so saving it again never fails."""
    if not tag or tag == current or tag in options:
        return ""
    return f"{tag} is not one of this project's tags"
