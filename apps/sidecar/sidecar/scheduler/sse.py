import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter()


def create_sse_router(scheduler):
    @router.get("/tasks/{task_id}/stream")
    async def task_stream(task_id: str):
        queue = scheduler.get_progress_queue(task_id)

        async def event_generator():
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event)}\n\n"
                    status = event.get("status")
                    if status in ("completed", "failed", "cancelled"):
                        break
                except asyncio.TimeoutError:
                    yield ":keepalive\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router
