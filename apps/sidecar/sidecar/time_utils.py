"""UTC timestamp helpers for API responses.

SQLite stores the desktop app's UTC datetimes without timezone information.
Calling ``datetime.isoformat()`` directly therefore emits a naive string;
JavaScript interprets that string as local time and the Windows UI displays
the timeline eight hours early in China. API timestamps must carry ``Z``.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utc_iso(value: datetime | None) -> str | None:
    """Serialize a database UTC datetime as an unambiguous ISO-8601 string."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")
