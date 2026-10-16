class NotFoundError(Exception):
    """The requested record does not exist."""


class ConflictError(Exception):
    """The write lost an optimistic-concurrency check or violates a uniqueness rule."""


class ValidationFailed(Exception):
    """Input that parses but breaks a business rule (→ 422). `detail` is returned as the response body's detail."""

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.detail = {"message": message, **extra}
