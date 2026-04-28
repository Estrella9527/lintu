import logging
import os
from contextlib import asynccontextmanager

# IMPORTANT: clear HTTP(S) proxy env vars BEFORE importing any HTTP client.
# Lintu's sidecar talks to Aliyun OSS / Volcengine Ark — both are domestic
# services. If a developer has Clash/V2Ray running on localhost:1082 (very
# common on dev machines), httpx/requests/oss2 will route every API call
# through the proxy → outbound to overseas → back to China → 10-100× slower.
# We forcibly disable the proxy at process start so Ark / OSS calls stay
# on the direct local route. If you really need a proxy for some endpoint,
# pass `proxies=` per-client instead of relying on env.
for _proxy_var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_proxy_var, None)
# Mark common targets as no-proxy so any later child code that re-imports
# proxy env doesn't accidentally route them through a SOCKS/HTTP proxy.
os.environ.setdefault(
    "NO_PROXY",
    "localhost,127.0.0.1,*.aliyuncs.com,*.volces.com,*.bytedance.com,*.googleapis.com",
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sidecar.config import LINTU_ALLOW_CORS, LINTU_MODE
from sidecar.db.migrate import init_db
from sidecar.middleware.audit import AuditMiddleware
from sidecar.middleware.auth import AuthMiddleware
from sidecar.middleware.errors import install_error_handlers
from sidecar.middleware.quota import QuotaMiddleware
from sidecar.middleware.rate_limit import RateLimitMiddleware
from sidecar.scheduler.engine import TaskScheduler
from sidecar.scheduler.batch_engine import batch_scheduler
from sidecar.scheduler.oss_worker import oss_worker
from sidecar.scheduler.sse import create_sse_router
from sidecar.routers import tasks, images, stats, matrix, config_api, projects, providers, tag_schema, prompts, openapi, openapi_v1, strategies, prompt_docs, batches, api_keys, duplicate_groups, tag_audit, oss, match_analytics, match_synonyms

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
    from sidecar.engines.crop import run_crop
    from sidecar.engines.upscale import run_upscale
    from sidecar.engines.outpaint import run_outpaint
    from sidecar.engines.seasonal import run_seasonal
    from sidecar.engines.style import run_style
    from sidecar.engines.inpaint import run_inpaint
    from sidecar.engines.marketing import run_marketing
    from sidecar.engines.custom import run_custom
    from sidecar.engines.orient import run_orient
    from sidecar.engines.prompt_parser import run_parse_prompt
    from sidecar.engines.clip_embed import run_embed

    scheduler.register("quality_check", run_quality_check)
    scheduler.register("dedup", run_dedup)
    scheduler.register("tag", run_tagging)
    scheduler.register("scan", run_scan)
    scheduler.register("crop", run_crop)
    scheduler.register("upscale", run_upscale)
    scheduler.register("outpaint", run_outpaint)
    scheduler.register("seasonal", run_seasonal)
    scheduler.register("style", run_style)
    scheduler.register("inpaint", run_inpaint)
    scheduler.register("marketing", run_marketing)
    scheduler.register("custom", run_custom)
    scheduler.register("orient", run_orient)
    scheduler.register("parse_prompt", run_parse_prompt)
    scheduler.register("embed", run_embed)

    await scheduler.start()
    await batch_scheduler.start()
    await oss_worker.start()
    yield
    await oss_worker.stop()
    await batch_scheduler.stop()
    await scheduler.stop()


app = FastAPI(
    title="灵图 Sidecar",
    version="0.2.0",
    lifespan=lifespan,
    # Server mode exposes Swagger UI for external integrators; keep it off in
    # the desktop build to avoid surfacing internal admin routes.
    docs_url="/docs" if LINTU_MODE == "server" else None,
    redoc_url="/redoc" if LINTU_MODE == "server" else None,
    openapi_url="/openapi.json" if LINTU_MODE == "server" else None,
)
install_error_handlers(app)

# CORS — narrow in electron mode (only the renderer), explicit allowlist in server mode
if LINTU_MODE == "electron":
    cors_origins = ["http://localhost:5173", "http://localhost:5174", "file://"]
else:
    # Server mode: caller must set LINTU_ALLOW_CORS=https://h5.example.com,https://other.app
    cors_origins = LINTU_ALLOW_CORS or []
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Order matters: outer → inner = audit → quota → rate_limit → auth → CORS → app.
# Starlette executes add_middleware in reverse order, so register inner first.
# Quota wraps RateLimit so the in-memory burst gate fires first (cheap reject)
# before we touch the DB for daily counters.
app.add_middleware(QuotaMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(AuditMiddleware)


@app.get("/health")
async def health():
    return {"status": "ok", "mode": LINTU_MODE}


# Wire scheduler into tasks router
tasks.set_scheduler(scheduler)

# /api/* — admin routes for the desktop owner. Disabled in server mode so the
# public deployment can't be used to mutate config / start tasks anonymously.
if LINTU_MODE == "electron":
    app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
    app.include_router(tasks.router, prefix="/api/tasks", tags=["tasks"])
    app.include_router(create_sse_router(scheduler), prefix="/api", tags=["sse"])
    app.include_router(images.router, prefix="/api/images", tags=["images"])
    app.include_router(stats.router, prefix="/api/stats", tags=["stats"])
    app.include_router(matrix.router, prefix="/api/matrix", tags=["matrix"])
    app.include_router(config_api.router, prefix="/api/config", tags=["config"])
    app.include_router(providers.router, prefix="/api/providers", tags=["providers"])
    app.include_router(tag_schema.router, prefix="/api/tag-schema", tags=["tag-schema"])
    app.include_router(prompts.router, prefix="/api/prompts", tags=["prompts"])
    app.include_router(prompt_docs.router, prefix="/api/prompt-docs", tags=["prompt-docs"])
    app.include_router(batches.router, prefix="/api/batches", tags=["batches"])
    app.include_router(api_keys.router, prefix="/api/api-keys", tags=["api-keys"])
    app.include_router(strategies.router, prefix="/api/strategies", tags=["strategies"])
    app.include_router(duplicate_groups.router, prefix="/api/duplicate-groups", tags=["duplicate-groups"])
    app.include_router(tag_audit.router, prefix="/api/audit/tagger", tags=["tag-audit"])
    app.include_router(oss.router, prefix="/api/oss", tags=["oss"])
    app.include_router(match_analytics.router, prefix="/api/match", tags=["match-analytics"])
    app.include_router(match_synonyms.router, prefix="/api/match-synonyms", tags=["match-synonyms"])

# /open-api/v1/* — public-facing API. Always mounted. Auth is enforced via
# AuthMiddleware in server mode (electron mode leaves it open for local use).
app.include_router(openapi_v1.router, prefix="/open-api/v1", tags=["open-api-v1"])

# Legacy unversioned /open-api/* — retained for backward compatibility for one
# sprint. Plan to deprecate after callers migrate to /v1.
app.include_router(openapi.router, prefix="/open-api", tags=["open-api-legacy"])

logging.info("Sidecar started in %s mode", LINTU_MODE)
