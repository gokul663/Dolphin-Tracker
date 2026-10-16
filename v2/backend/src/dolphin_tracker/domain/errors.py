class NotFoundError(Exception):
    """The requested record does not exist."""


class ConflictError(Exception):
    """The write lost an optimistic-concurrency check or violates a uniqueness rule."""
