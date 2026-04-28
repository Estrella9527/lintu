"""Incremental top-level-object extractor for streaming JSON arrays.

The parser ingests text chunks and yields fully-balanced `{...}` objects as
soon as they're complete — useful for showing prompt entries in the UI as
the LLM finishes each one rather than waiting for the whole array.

Handles:
  - leading/trailing array brackets, commas, whitespace
  - nested braces inside objects
  - braces inside JSON string literals (with `\\"` escape)
  - markdown code fences (```json ... ```) — strips them out

Does NOT validate the objects (caller json.loads each one). On stream end,
caller may also pass the full text to a strict json.loads as a fallback.
"""
from __future__ import annotations


class JsonObjectStreamer:
    def __init__(self):
        self._buf: list[str] = []
        self._depth = 0
        self._in_string = False
        self._escape = False
        self._capturing = False
        self._capture: list[str] = []

    def feed(self, chunk: str) -> list[str]:
        """Push a text chunk; return list of complete JSON object source strings."""
        out: list[str] = []
        for ch in chunk:
            self._buf.append(ch)
            if self._in_string:
                self._capture.append(ch)
                if self._escape:
                    self._escape = False
                elif ch == "\\":
                    self._escape = True
                elif ch == '"':
                    self._in_string = False
                continue

            if not self._capturing:
                if ch == "{":
                    self._capturing = True
                    self._depth = 1
                    self._capture = ["{"]
                # ignore everything else (commas, whitespace, [, etc.)
                continue

            # Capturing inside an object
            self._capture.append(ch)
            if ch == '"':
                self._in_string = True
            elif ch == "{":
                self._depth += 1
            elif ch == "}":
                self._depth -= 1
                if self._depth == 0:
                    out.append("".join(self._capture))
                    self._capture = []
                    self._capturing = False
        return out

    def finish(self) -> list[str]:
        """Return any final not-yet-emitted complete object (rare)."""
        return []
