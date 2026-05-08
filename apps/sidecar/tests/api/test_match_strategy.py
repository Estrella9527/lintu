"""Pure-function tests for match_strategy helpers — no DB needed."""
from __future__ import annotations

from sidecar.engines.match_strategy import _current_season, STRATEGY_PRESETS, resolve_weights


def test_current_season_north_hemisphere():
    assert _current_season(1) == "冬季"
    assert _current_season(3) == "春季"
    assert _current_season(5) == "春季"
    assert _current_season(6) == "夏季"
    assert _current_season(8) == "夏季"
    assert _current_season(9) == "秋季"
    assert _current_season(11) == "秋季"
    assert _current_season(12) == "冬季"


def test_strategy_presets_are_consistent():
    for name, w in STRATEGY_PRESETS.items():
        assert w.embedding >= 0
        assert w.tag >= 0
        assert w.quality >= 0
        assert w.diversity >= 0
        assert w.business >= 0
        # Total > 0 — otherwise nothing scores
        assert (w.embedding + w.tag + w.quality + w.diversity + w.business) > 0


def test_resolve_weights_balanced_default():
    """No strategy + no override + no config → balanced preset."""
    w = resolve_weights(None, None)
    assert w.embedding == STRATEGY_PRESETS["balanced"].embedding


def test_resolve_weights_override_partial():
    """An override dict with one key uses defaults for the rest."""
    w = resolve_weights("balanced", {"embedding": 0.99})
    assert w.embedding == 0.99
    # Other keys fall back to balanced defaults
    assert w.tag == STRATEGY_PRESETS["balanced"].tag
