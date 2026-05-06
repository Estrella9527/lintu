"""PyInstaller entry point for the lintu sidecar.

When running outside Electron (`uv run uvicorn sidecar.main:app ...`), this
file is unused — that path uses uvicorn's own CLI. When packaged for desktop,
electron-builder ships this as `sidecar.exe`, which Electron spawns directly:

    sidecar.exe --port 7879 --host 127.0.0.1

We avoid uvicorn's CLI here because PyInstaller's frozen import system makes
it brittle to invoke uvicorn as a subprocess module — calling uvicorn.run()
in-process is simpler and gives us a single, controllable event loop.
"""
from __future__ import annotations

import argparse
import faulthandler
import multiprocessing
import sys
import traceback


def _excepthook(exc_type, exc_value, exc_tb) -> None:
    """Force tracebacks to stderr even when the host (Electron, Windows
    Service) eats default exception output. Without this, PyInstaller-built
    sidecar can die silently on a hidden-import failure mid-startup, leaving
    nothing in the log to debug."""
    print("\n=== UNHANDLED EXCEPTION ===", file=sys.stderr, flush=True)
    traceback.print_exception(exc_type, exc_value, exc_tb, file=sys.stderr)
    sys.stderr.flush()
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lintu-sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7879)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    # Import lazily so --help is fast and any import error is reported clearly.
    import asyncio
    import logging
    import uvicorn

    # Make sure logging is configured BEFORE we touch anything heavy. Without
    # this, uvicorn's lifespan may swallow the very tracebacks we need to debug
    # frozen-build failures.
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    log = logging.getLogger("lintu.launcher")

    # Run Alembic migrations BEFORE handing the process to uvicorn. uvicorn's
    # lifespan startup eats exceptions on Windows in frozen builds (process
    # exits with code 3 and no traceback); doing migrations here means any
    # alembic failure surfaces with a real Python traceback via our excepthook.
    from sidecar.db.migrate import init_db
    log.info("Running Alembic migrations...")
    asyncio.run(init_db())
    log.info("Alembic migrations complete")

    from sidecar.main import app  # noqa: F401  (ensures app is resolvable here)

    uvicorn.run(
        "sidecar.main:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        # Workers must stay 1 — the schedulers (BatchScheduler, OssSyncWorker)
        # assume a single process. Reload is meaningless in a frozen build.
        workers=1,
        reload=False,
        # Avoid uvicorn's lifespan auto-detection picking the wrong impl in
        # frozen mode.
        lifespan="on",
    )


if __name__ == "__main__":
    # Critical for PyInstaller on Windows: any code that ever uses
    # multiprocessing (torch, etc.) needs freeze_support to avoid forking
    # the bundle into infinite re-launches.
    multiprocessing.freeze_support()
    sys.excepthook = _excepthook
    faulthandler.enable()
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except SystemExit:
        raise
    except BaseException:
        _excepthook(*sys.exc_info())
