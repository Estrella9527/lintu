from datetime import datetime, timedelta, timezone

from sidecar.time_utils import utc_iso


def test_naive_database_datetime_is_serialized_as_utc():
    assert utc_iso(datetime(2026, 7, 21, 8, 30, 15)) == "2026-07-21T08:30:15Z"


def test_aware_datetime_is_normalized_to_utc():
    china = timezone(timedelta(hours=8))
    assert utc_iso(datetime(2026, 7, 21, 16, 30, tzinfo=china)) == "2026-07-21T08:30:00Z"


def test_none_timestamp_stays_none():
    assert utc_iso(None) is None
