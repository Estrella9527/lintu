import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sidecar.db.migrate import init_db
from sidecar.scheduler.engine import TaskScheduler
from sidecar.scheduler.sse import create_sse_router
from sidecar.routers import tasks, images, stats, matrix, config_api, projects, providers

logging.basicConfig(level=logging.INFO)

scheduler = TaskScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Register engine handlers (imported lazily to avoid circular deps)
    from sidecar.engines.quality_check import run_quality_check
    from sidecar.engines.dedup import run_dedup
    from sidecar.engines.tagger import run_tagging
    from sidecar.engines.scan import run_scan

    scheduler.register("quality_check", run_quality_check)
    scheduler.register("dedup", run_dedup)
    scheduler.register("tag", run_tagging)
    scheduler.register("scan", run_scan)

    await scheduler.start()
    yield
    await scheduler.stop()


app = FastAPI(title="灵图 Sidecar", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "file://"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


# Wire scheduler into tasks router
tasks.set_scheduler(scheduler)

app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
app.include_router(tasks.router, prefix="/api/tasks", tags=["tasks"])
app.include_router(create_sse_router(scheduler), prefix="/api", tags=["sse"])
app.include_router(images.router, prefix="/api/images", tags=["images"])
app.include_router(stats.router, prefix="/api/stats", tags=["stats"])
app.include_router(matrix.router, prefix="/api/matrix", tags=["matrix"])
app.include_router(config_api.router, prefix="/api/config", tags=["config"])
app.include_router(providers.router, prefix="/api/providers", tags=["providers"])
