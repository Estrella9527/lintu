import logging
import os
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

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

from sidecar.config import DATA_DIR, LINTU_ALLOW_CORS, LINTU_MODE
from sidecar.db.migrate import init_db
from sidecar.middleware.audit import AuditMiddleware, OperationLogMiddleware
from sidecar.middleware.auth import AuthMiddleware
from sidecar.middleware.user_auth import UserAuthMiddleware
from sidecar.middleware.tenant import TenantMiddleware
from sidecar.middleware.org_context import OrgContextMiddleware
from sidecar.middleware.errors import install_error_handlers
from sidecar.middleware.quota import QuotaMiddleware
from sidecar.middleware.rate_limit import RateLimitMiddleware
from sidecar.scheduler.engine import TaskScheduler
from sidecar.scheduler.batch_engine import batch_scheduler
from sidecar.scheduler.oss_worker import oss_worker
from sidecar.scheduler.cloud_sync_worker import cloud_sync_worker
from sidecar.scheduler.cloud_pull_worker import cloud_pull_worker
from sidecar.scheduler.sse import create_sse_router
from sidecar.routers import tasks, images, stats, matrix, config_api, projects, providers, tag_schema, prompts, openapi, openapi_v1, strategies, prompt_docs, batches, api_keys, duplicate_groups, tag_audit, oss, match_analytics, match_synonyms, internal_sync, image_review, auth as auth_router, invitations as invitations_router, audit_ops as audit_ops_router, orgs as orgs_router, platform as platform_router, generate as generate_router, style_archives as style_archives_router, oss_library as oss_library_router

logging.basicConfig(level=logging.INFO)

# Packaged Windows apps have no console window, so stdout/stderr alone makes
# production failures impossible to inspect. Keep a bounded local log under
# %USERPROFILE%\lintu-data\logs (or the platform-equivalent DATA_DIR).
try:
    _log_dir = DATA_DIR / "logs"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _file_handler = RotatingFileHandler(
        _log_dir / "sidecar.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
        delay=True,
    )
    _file_handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s"
    ))
    logging.getLogger().addHandler(_file_handler)
except OSError:
    logging.getLogger(__name__).exception("failed to initialize sidecar file logging")

scheduler = TaskScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    # 安装 tenant ORM hooks — 必须在 init_db 之后，确保 sessionmaker 已经
    # 准备好；只装一次（installer 内部幂等）。
    from sidecar.db.session import async_session
    from sidecar.db.tenant import install_tenant_hooks
    install_tenant_hooks(async_session)

    # SMS preflight — Windows PyInstaller 历来会漏 alibabacloud SDK 子模块；
    # 启动期 import + 凭据状态打到日志，user 版打包没装上能立刻发现。
    from sidecar.providers import sms_aliyun
    sms_aliyun.preflight()

    # 一次性自愈:旧版压缩任务曾原地覆盖源文件(原图存为 .orig)。v0.3.1 起
    # 压缩只写派生副本;这里把历史 .orig 自动还原回原图。幂等 — 每图一次
    # stat,没有 .orig 时近零开销;还原后修正 DB 里被改过的尺寸。
    from sidecar.engines.restore_orig import restore_orig_backups
    try:
        await restore_orig_backups()
    except Exception:
        logging.getLogger(__name__).exception("restore .orig backups failed (non-fatal)")

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
    from sidecar.engines.compress import run_compress

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
    scheduler.register("compress", run_compress)

    await scheduler.start()
    await batch_scheduler.start()
    await oss_worker.start()
    # Cloud sync runs only when LINTU_CLOUD_SYNC_URL is set; in pure local
    # mode it self-disables and returns immediately. Safe to always call.
    await cloud_sync_worker.start()
    # 多设备同步(方案A)拉取端 — 仅 LINTU_CLOUD_PULL=1 时启用(副设备/多端共享)。
    await cloud_pull_worker.start()
    yield
    await cloud_pull_worker.stop()
    await cloud_sync_worker.stop()
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
app.add_middleware(AuthMiddleware)         # /open-api/v1/* 的 ApiKey 路径
# Starlette middleware 执行顺序是「外 → 内」、调用栈是后注册的先执行 dispatch。
# 我们要的执行顺序是：UserAuth → OrgContext → Tenant → endpoint，
# 所以注册时倒过来：Tenant 先，OrgContext 中，UserAuth 最后（最外层）。
app.add_middleware(TenantMiddleware)       # 注入 ContextVar（依赖 request.state.user）
app.add_middleware(OrgContextMiddleware)   # 注入 active_org_id / org_role / project_role
app.add_middleware(UserAuthMiddleware)     # /api/* 的 user token 验证（先于 Tenant 跑）
app.add_middleware(OperationLogMiddleware) # /api/* 写操作留痕（依赖 request.state.user）
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
    app.include_router(oss_library_router.router, prefix="/api/oss-library", tags=["oss-library"])
    app.include_router(match_analytics.router, prefix="/api/match", tags=["match-analytics"])
    app.include_router(match_synonyms.router, prefix="/api/match-synonyms", tags=["match-synonyms"])
    app.include_router(image_review.router, prefix="/api/image-review", tags=["image-review"])
    # v0.3 创作画布:统一图像生成端点(Ask AI / outpaint / inpaint / matting / ...)
    app.include_router(generate_router.router, prefix="/api/generate", tags=["generate"])
    # v0.3 风格档案 CRUD
    app.include_router(style_archives_router.router, prefix="/api/style-archives", tags=["style-archives"])
    # 用户系统 Phase 1：登录端点不需要鉴权（UserAuthMiddleware 主动放行 /api/auth/*）
    app.include_router(auth_router.router, prefix="/api/auth", tags=["auth"])
    # 项目邀请 — 路径形如 /api/projects/{pid}/invitations，挂在 /api/projects 下
    app.include_router(invitations_router.router, prefix="/api/projects", tags=["invitations"])
    # 操作日志读端点（仅超级管理员可调）
    app.include_router(audit_ops_router.router, prefix="/api/audit", tags=["audit-ops"])
    # v0.2 组织化
    app.include_router(orgs_router.router, prefix="/api/orgs", tags=["orgs"])
    app.include_router(platform_router.router, prefix="/api/platform", tags=["platform"])

# /internal/sync/* — local sidecar pushes here, never exposed to UGC.
# Only mounted in server mode (cloud deploy) — local has no need to
# receive its own writes.
if LINTU_MODE == "server":
    app.include_router(internal_sync.router, prefix="/internal/sync", tags=["internal-sync"])

# /open-api/v1/* — public-facing API. Always mounted. Auth is enforced via
# AuthMiddleware in server mode (electron mode leaves it open for local use).
app.include_router(openapi_v1.router, prefix="/open-api/v1", tags=["open-api-v1"])

# Legacy unversioned /open-api/* — retained for backward compatibility for one
# sprint. Plan to deprecate after callers migrate to /v1.
app.include_router(openapi.router, prefix="/open-api", tags=["open-api-legacy"])

logging.info("Sidecar started in %s mode", LINTU_MODE)
