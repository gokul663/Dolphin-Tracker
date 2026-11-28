"""Free-text search over a store, as a person types it. Pure.

A search is words, not one exact phrase: every word typed must be somewhere in the store's text, in any of its
fields. So a whole address ("12000 South Shore Boulevard, Wellington, FL 33414") finds the store although the street,
city, state and ZIP are separate fields, and so does a part of it. Street words are compared in one spelling, since
the sheet, Google's verified address and the CMS data each abbreviate differently ("South Shore Boulevard",
"S Shore Blvd").
"""
from __future__ import annotations

import re
from collections.abc import Iterable

# Abbreviation → the full word, for the words addresses vary in. Both the store's text and the search go through it.
_FULL = {
    "n": "north", "s": "south", "e": "east", "w": "west",
    "ne": "northeast", "nw": "northwest", "se": "southeast", "sw": "southwest",
    "st": "street", "str": "street", "ave": "avenue", "av": "avenue", "blvd": "boulevard", "rd": "road",
    "dr": "drive", "ln": "lane", "ct": "court", "hwy": "highway", "pkwy": "parkway", "pl": "place", "sq": "square",
    "ter": "terrace", "trl": "trail", "cir": "circle", "expy": "expressway", "fwy": "freeway", "ste": "suite",
    "apt": "apartment", "rte": "route", "mt": "mount", "ft": "fort",
}
_SEPARATORS = re.compile(r"[^a-z0-9#&-]+")


def search_words(text: object) -> list[str]:
    """The words of a text as compared: lower case, punctuation dropped ("Joe's" → "joes"), `DD_ABC` as `dd-abc`,
    street abbreviations spelled out."""
    lowered = str(text or "").lower().replace("'", "").replace("’", "").replace("_", "-")
    return [_FULL.get(word, word) for word in _SEPARATORS.split(lowered) if word.strip("-")]


def search_text(parts: Iterable[object]) -> str:
    """Everything searchable about one store, as one line of compared words."""
    return " ".join(word for part in parts for word in search_words(part))


def matches(query: str, text: str) -> bool:
    """Every word of `query` is in `text` (a `search_text`), whole or as the start or part of a word."""
    return all(word in text for word in search_words(query))
