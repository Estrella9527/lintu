from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Project
from sidecar.db.session import get_db

router = APIRouter()


class CreateProjectBody(BaseModel):
    name: str
    originals_path: str
    workspace_path: str


@router.post("")
async def create_project(body: CreateProjectBody, db: AsyncSession = Depends(get_db)):
    project = Project(
        name=body.name,
        originals_path=body.originals_path,
        workspace_path=body.workspace_path,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return _project_to_dict(project)


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).order_by(Project.created_at.desc()))
    return [_project_to_dict(p) for p in result.scalars().all()]


@router.get("/{project_id}")
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return _project_to_dict(project)


def _project_to_dict(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "originals_path": p.originals_path,
        "workspace_path": p.workspace_path,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
