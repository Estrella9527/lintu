"""灵图 Open API v1 — Python SDK Demo

Usage::

    from lintu_client import LintuClient

    client = LintuClient(
        base_url="https://api.your-domain.com",
        token="lk_live_xxx.your_secret",
    )

    print(client.health())
    images = client.list_images(limit=10)
    for img in images["items"]:
        print(img["id"], img["file_name"])

    # Submit a batch (requires generate:write scope)
    batch = client.submit_batch(
        project_id="...",
        name="external H5 batch",
        task_type="outpaint",
        seed_image_ids=["img1", "img2"],
        prompt_ids=["p1", "p2"],
        concurrency=5,
        budget_usd=2.0,
    )
    print("batch:", batch["id"])

Dependencies: stdlib only (urllib.request). Drop-in copy is fine.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any, Iterable


class LintuAPIError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


class LintuClient:
    def __init__(self, base_url: str, token: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/") + "/open-api/v1"
        self.token = token
        self.timeout = timeout

    # ── Internals ──

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        body: dict | None = None,
        accept: str = "application/json",
    ):
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None},
                doseq=True,
            )
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", accept)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read()
                if accept == "application/json":
                    return json.loads(payload)
                return payload
        except urllib.error.HTTPError as e:
            raise LintuAPIError(e.code, e.read().decode("utf-8", "replace")) from e

    # ── Endpoints ──

    def health(self) -> dict:
        return self._request("GET", "/health")

    def stats(self, project_id: str | None = None) -> dict:
        return self._request("GET", "/stats", params={"project_id": project_id})

    def list_images(
        self,
        *,
        project_id: str | None = None,
        source_type: str | None = None,
        scene: Iterable[str] | None = None,
        season: Iterable[str] | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict:
        return self._request("GET", "/images", params={
            "project_id": project_id,
            "source_type": source_type,
            "scene": list(scene) if scene else None,
            "season": list(season) if season else None,
            "offset": offset,
            "limit": limit,
        })

    def get_image(self, image_id: str) -> dict:
        return self._request("GET", f"/images/{image_id}")

    def list_derivatives(self, image_id: str) -> dict:
        return self._request("GET", f"/images/{image_id}/derivatives")

    def download_image(self, image_id: str, *, size: int | None = None) -> bytes:
        return self._request("GET", f"/images/{image_id}/file",
                             params={"size": size} if size else None,
                             accept="image/jpeg")

    def list_tags(self, *, project_id: str | None = None, dimension: str | None = None) -> list[dict]:
        return self._request("GET", "/tags", params={
            "project_id": project_id, "dimension": dimension,
        })

    def matrix(self, project_id: str, row: str = "scene", col: str = "season") -> dict:
        return self._request("GET", "/matrix",
                             params={"project_id": project_id, "row": row, "col": col})

    def list_batches(self, *, project_id: str | None = None, status: str | None = None) -> list[dict]:
        return self._request("GET", "/batches", params={
            "project_id": project_id, "status": status,
        })

    def get_batch(self, batch_id: str) -> dict:
        return self._request("GET", f"/batches/{batch_id}")

    def submit_batch(
        self,
        *,
        project_id: str,
        name: str,
        task_type: str,
        seed_image_ids: list[str],
        prompt_ids: list[str],
        concurrency: int = 10,
        max_retry: int = 3,
        budget_usd: float | None = None,
    ) -> dict:
        return self._request("POST", "/batches", body={
            "project_id": project_id,
            "name": name,
            "task_type": task_type,
            "seed_image_ids": seed_image_ids,
            "prompt_ids": prompt_ids,
            "concurrency": concurrency,
            "max_retry": max_retry,
            "budget_usd": budget_usd,
        })


if __name__ == "__main__":
    import os
    import sys

    base = os.environ.get("LINTU_BASE", "http://localhost:7879")
    token = os.environ.get("LINTU_TOKEN")
    if not token:
        print("Set LINTU_TOKEN=lk_live_xxx.secret first", file=sys.stderr)
        sys.exit(1)

    c = LintuClient(base, token)
    print("health:", c.health())
    print("stats:", c.stats())
    images = c.list_images(limit=3)
    print(f"got {images['total']} images, first 3:")
    for img in images["items"]:
        print(f"  {img['id']}  {img['file_name']}  {img['width']}x{img['height']}")
