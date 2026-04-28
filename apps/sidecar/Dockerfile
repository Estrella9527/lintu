# syntax=docker/dockerfile:1.7
# 灵图 Sidecar — production image for LINTU_MODE=server (Open API host).
#
# Build:   docker build -t lintu-sidecar:0.2 .
# Run:     docker run -p 7879:7879 -v /srv/lintu-data:/data lintu-sidecar:0.2
#
# The container expects:
#   - /data       persistent volume for SQLite + workspace + uploaded prompt docs
#   - /workspace  optional bind-mount for generated images (defaults to /data/workspace)

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_PREFERENCE=only-system \
    LINTU_DATA_DIR=/data \
    LINTU_PORT=7879

# China-friendly mirrors for build-time downloads (apt + pip). Override with
# build args if building outside CN: docker build --build-arg ... (future).
ENV UV_HTTP_TIMEOUT=600 \
    UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# Replace Debian's default sources with Aliyun mirror BEFORE apt-get update.
# Trixie uses deb822 format in /etc/apt/sources.list.d/debian.sources.
RUN cat > /etc/apt/sources.list.d/debian.sources <<'SRCEOF'
Types: deb
URIs: https://mirrors.aliyun.com/debian
Suites: trixie trixie-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp

Types: deb
URIs: https://mirrors.aliyun.com/debian-security
Suites: trixie-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
SRCEOF

# Native deps:
#   - libheif-dev : HEIC support via pillow_heif
#   - libxml2/libxslt1.1 : python-docx
#   - mupdf-tools is not needed — pymupdf bundles MuPDF
RUN apt-get update && apt-get install -y --no-install-recommends \
        libheif1 \
        libxml2 \
        libxslt1.1 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python installer + resolver)
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

WORKDIR /app

# Cache dependency layer.
# --frozen omitted intentionally: cloud build doesn't install the local-clip
# extra (torch + open_clip + scipy ~1.5GB of CUDA wheels), so the lockfile
# would be inconsistent. uv re-resolves the slim cloud-only set on each build,
# which is fast (~30s vs 5-10min for the full torch chain).
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --no-install-project

# Copy source + alembic
COPY sidecar ./sidecar
COPY alembic ./alembic
COPY alembic.ini ./
COPY main.py ./

# Make sure the persistent volume mount point exists
RUN mkdir -p /data /data/workspace
VOLUME ["/data"]

EXPOSE 7879

# Healthcheck: /health must respond with 200 within 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7879/health || exit 1

# Default to server mode. Override with -e LINTU_MODE=electron if you want the
# /api/* admin surface (intended only for the desktop app).
ENV LINTU_MODE=server

CMD ["uv", "run", "uvicorn", "sidecar.main:app", "--host", "0.0.0.0", "--port", "7879"]
