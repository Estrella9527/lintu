# 灵图 RBAC 完整方案 v1

> **状态**：规划阶段，待你拍板第七节的 5 个决策点后启动
> **作者**：综合 PM / BE / UX 三视角
> **预估总工作量**：33 人天（单工程师 6-7 周；2 人并行 3-4 周）

---

## 〇 · TL;DR（30 秒读完）

| 维度 | 决策 |
|---|---|
| 角色数量 | MVP **3 个**（运营/内容生产/平台运营），V2 再加 admin/viewer |
| 多租户 | 默认**完全隔离**；跨租户访问是例外，需客户授权 |
| 权限模型 | **RBAC + 项目维度行级隔离**（不上 ABAC，避免过度工程） |
| 隔离手段 | ContextVar + SQLAlchemy event 自动注入 `project_id` + Postgres RLS 兜底 |
| 桌面登录 | 一次性登录，token 存 OS keychain，离线宽限期 7 天 |
| 与现有 ApiKey | 正交：ApiKey=service principal，User=human principal，二者各自一套 |
| ops 版兼容 | `BUILD_FLAVOR=ops` 进 `single_user` 模式自动以 root 身份登录，行为不变 |
| 部署节奏 | 6 个 PR 串行 → MVP 上线后再开 V2 |

---

## 一 · 为什么要做 / 触发点

1. **应用已对外打包** — 普通用户能下载，单租户假设破产
2. **多客户已落地** — 示例景区A + 示例景区B共享一套 sidecar，运营怕「另一个景区误改我的同义词」
3. **last-write-wins 已修但不够** — 我们做了 `__version` 乐观锁，但还没有「谁有权改」的概念
4. **客户合同明文要求**："我的图、我的 prompt、我的标注 = 我的资产"

---

## 二 · 当前系统全盘清单（从 RBAC 视角）

### 2.1 桌面端 9 模块 + 设置 6 子页（必须按角色控制）

| 模块 | 写操作 | MVP 角色控制重点 |
|---|---|---|
| 仪表盘 | 否 | 全角色可见 |
| 流水线 | 是（启动批处理） | 内容生产+运营可写；viewer 不可 |
| AI 工坊 | 是 | 同上 |
| 任务中心 | 是（pause/cancel） | 同上 |
| 审核 | 是（approve/reject） | **仅运营可决策**，内容生产只能"提交"不能"通过自己的批" |
| 资产库 | 是（标签编辑/删除） | 内容生产+运营可改标签；删除限运营 |
| 覆盖矩阵 | 否 | 全角色可见 |
| 匹配实验室 | 是（策略+同义词+ideal） | **仅运营**；内容生产只读 |
| 分发中心 | 是（API Key CRUD） | **仅项目管理员**；MVP 合并到运营 |
| 设置→AI Provider | 是（凭据写入） | **仅平台运营**（user 版隐藏） |
| 设置→OSS 连接 | 是 | **仅平台运营** |
| 设置→标签体系 | 是 | 仅运营 |
| 设置→提示词库 | 是 | 内容生产+运营 |

### 2.2 后端端点 150+（按层）

- `/api/*`（桌面端私有，**目前完全无鉴权**）：100+ 端点，是这次改造的核心战场
- `/open-api/v1/*`（外部 UGC，已有 ApiKey + scope）：14 端点，scope 系统沿用
- `/internal/sync/*`（桌面 ↔ 云端，已有 LINTU_INTERNAL_SYNC_TOKEN）：8 端点，扩展为 token + user_id+project_ids 换发 cloud_jwt

详细端点 × 当前 scope 表见下面 §4.5。

### 2.3 数据表敏感度分类

| 表 | 含敏感数据 | 影响 UGC | 备注 |
|---|---|---|---|
| **api_keys** | ✓（hashed_key + 凭据） | ✗ | 凭据类，跨租户绝对不可见 |
| **api_request_logs** | ✓（请求审计） | ✗ | 日志含 IP，不可跨租户 |
| **images / tags / batch_runs / duplicate_groups** | — | ✓ | 客户资产，必须 project_id 隔离 |
| **prompts / strategies / match_synonyms / tag_schema / config** | — | ✓ | **目前全局表** — 必须改成 project 维度（重大改动） |
| **match_feedback** | ✓（query 文本 hash） | ✓ | 跨项目数据需脱敏 |
| **config_audit_logs** | — | ✗ | 审计本身需要权限保护，运营只能看本租户 |
| **users / sessions / project_members**（待建） | ✓ | ✗ | 新增表 |

### 2.4 已有的隔离机制（不要重复造）

| 机制 | 类型 | 怎么复用 |
|---|---|---|
| API Key + scopes | 库层 | UGC 端继续用，内部账号走新的 user system |
| LINTU_INTERNAL_SYNC_TOKEN | 库层 | 升级为 token-exchange：token 换一次性 cloud_jwt |
| LINTU_MODE (electron/server) | 环境层 | 服务端 vs 桌面端 sidecar 区分，已 OK |
| BUILD_FLAVOR (user/ops) | 编译层 | 物理隔离用户版/运营版 — 决定是否启用 single_user 模式 |
| project_id 字段 | 数据层 | 已存在；要补**自动注入**的 ORM hook |
| config `__version` 乐观锁 | 业务层 | 防 last-write-wins 已上线，配 RBAC 锦上添花 |
| config_audit_logs | 业务层 | 已上线，扩展 actor_meta 加 user_id |

### 2.5 当前**无 project_id 过滤**的关键端点（必须改造）

```
/api/prompts                # prompts 表无 project_id
/api/strategies             # strategies 表无 project_id
/api/tag-schema             # 全局 schema
/api/match-synonyms         # 全局词典
/api/config                 # 全局配置
```

这 5 个是最大重构点 — 要么把表加 `project_id` 列，要么在 RBAC 里把它们标记为「全局只 admin 可改」。决策见 §7。

---

## 三 · 角色矩阵（PM 视角）

### 3.1 5 个角色定义

| 角色 | 身份 | 一天典型 | 不能碰 |
|---|---|---|---|
| **景区运营** | 主力日常用户 | 看仪表盘 → 上传新图 → 跑评估 → 调同义词/prompt → 审核 AI 批次 | 跨景区数据；项目 CRUD；BUILD_FLAVOR/OSS |
| **内容生产** | 拍摄+打标执行层 | 上传原图 → AI 工坊起批 → 提交审核 → 不自审 | 策略类（tag-schema/synonyms/prompts/match-strategy）；终审；分发中心 |
| **景区管理员** | 单景区一把手 | 开账号、调权限、发 API Key、季度审计 | 跨景区；BUILD_FLAVOR；图库内容（管人不管货） |
| **平台运营** | 灵图自己人（**仅 ops 版**） | 跨景区巡检、协助排障、创建景区 | 写操作默认禁用，需客户授权 + 留痕 |
| **只读观察员** | 老板/顾问/审计 | 只看 | 全部写操作；原图大图下载；API Key 明文 |

### 3.2 多租户决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 景区 A 运营能看景区 B？ | **默认不能** | B 端客户对资产敏感，跨租户隔离是底线 |
| 平台运营能看吗？ | **只读可，写需授权 + 留痕** | 客服必需，但写入必须客户知情 |
| 集团总部账号 | **新增"集团视图"角色**，显式绑定 N 个 project | 合同级配置，非默认开放 |
| 第三方顾问 | **临时访问 token**，景区管理员发放，带过期 | 不开正式账号 |
| 服务商（拍摄外包） | 复用"内容生产"，scope 限定 project | 边界清晰 |

### 3.3 跨角色协作流（AI 批量打标场景）

```
内容生产（拍摄外包）
  → 上传 200 张新图到资产库
  → AI 工坊起批，prompt 用运营预设的"示例景区A_秋季_v3"
  → 提交批次到审核队列
       ↓
景区运营
  → 审核模块逐张过，剔除幻觉/错标 (~15%)
  → 通过的入库；被拒的退回重跑
  → 在匹配实验室跑 ideal-set 评估
  → 效果不佳 → 调 synonyms/prompts，让生产重跑
       ↓
景区管理员
  → 月底看仪表盘 + 审计日志
  → API Key 异常 → 吊销重发
       ↓
平台运营（ops 版）
  → 客户报"匹配率掉了"
  → 临时只读进入 → 定位 OSS 回填漏了
  → 申请客户授权 → 执行 /api/oss/backfill → 留痕
```

### 3.4 MVP vs Full

| 角色 / 能力 | MVP | Full |
|---|---|---|
| 景区运营 | ✓ | — |
| 内容生产 | ✓（与运营分离是审核流前提） | — |
| 景区管理员 | **MVP 合并到运营**（一人多帽） | V2 拆分 |
| 平台运营 | ✓（ops 版客服刚需） | — |
| 只读观察员 | 延后 | V2 |
| 集团视图 | 延后 | V2 |
| 临时顾问 token | 延后 | V2 |
| 细粒度 API scope | 沿用现有 | 扩展到内部账号 |
| 审计日志 UI | MVP 仅后台可查 | V2 给管理员看 |
| 跨景区授权流 | 平台运营写操作走人工工单 | V2 产品化授权弹窗 |

**MVP 三个角色就够：景区运营（含管理员）/ 内容生产 / 平台运营。**

---

## 四 · 技术架构（BE 视角）

### 4.1 新增数据表

```python
class User(Base):
    id, email(unique), phone, password_hash(argon2id),
    display_name, status(active|disabled|pending),
    is_root(bool), last_login_at, created_at, updated_at

class Session(Base):                              # refresh token 一行 = 一台设备
    id(=jti), user_id, refresh_hash(sha256),
    device_label, ip, user_agent,
    issued_at, expires_at, revoked_at

class Role(Base):
    id, code(root/admin/operator/labeler/viewer),
    name, is_system, scope(global|project)

class RolePermission(Base):                       # 多对多
    role_id, permission                           # permission 是字符串常量

class ProjectMember(Base):
    id, project_id, user_id, role_id,
    invited_by, created_at
    UNIQUE(project_id, user_id)

class UserInvitation(Base):
    id, project_id, role_id, email, token_hash,
    invited_by, expires_at, accepted_at, created_at

class PasswordResetToken(Base):
    id, user_id, token_hash, expires_at, used_at, created_at

class AuthEvent(Base):                            # 登录/失败/锁定审计
    id, user_id, event_type, ip, user_agent, created_at
```

**不做** `permissions` 单独表 — 用 enum 常量，每加一个权限不需要写迁移。

### 4.2 认证流程

**桌面端登录**（**本地账号 + Argon2id 密码**，不引入 OAuth/SSO）：

```
POST /api/auth/login   {email, password}
  → verify argon2 → 签 access(JWT, 15min) + refresh(opaque, 30天)
  → access claims: {sub, jti, project_ids:[...], roles:{pid:role_code}, exp}
  → refresh: sessions.refresh_hash; 存 Electron safeStorage（OS keychain）

POST /api/auth/refresh {refresh}
  → 命中 sessions 且未 revoked → 滚动签发新 access
  → refresh 不旋转（避免离线断网失效）
```

JWT 选 HS256（密钥 `LINTU_AUTH_JWT_SECRET`，启动若缺失自动生成 chmod 600 落盘）。

**桌面 ↔ 云端 sidecar**（云端无 user 表，不能直接验桌面 JWT）：

```
桌面 sidecar → 云端 POST /internal/v1/cloud-token/exchange
  Header: Authorization: Bearer ${LINTU_INTERNAL_SYNC_TOKEN}
  Body:   {user_id, project_ids, roles, ttl: 600}
  Resp:   {cloud_jwt}   # 云端 HS 签，10min
桌面再用 cloud_jwt 调 /open-api/* 或云端 user 端点
```

云端只信两件事：① 内部 token 直签的 cloud_jwt；② ApiKey。

**与 ApiKey 共存**（正交）：

| 主体 | 进入字段 | 用途 |
|---|---|---|
| User session | `request.state.user`（User + roles + project_ids） | UI / 运营操作 |
| ApiKey | `request.state.api_key`（已有） | UGC / 第三方 |

中间件顺序：`AuthMiddleware`（已有，处理 ApiKey）→ 新增 `UserAuthMiddleware`（处理 `/api/*` Bearer JWT）。`require_perm()` 自己判断接受哪种 principal。

### 4.3 权限模型（RBAC）

**permission 命名**（沿用 `resource:action`）：

```
images:read / write / delete
tasks:run
batches:read / write
tags:manage
members:manage
apikeys:manage
audit:read
project:admin
system:admin
```

**默认角色**：

| Role | Permissions |
|---|---|
| `root` | `*`（is_root + 全项目隐式成员） |
| `admin`（系统） | `system:admin` + 所有项目级 |
| `operator`（项目） | images:* / tasks:run / batches:* / tags:manage / audit:read |
| `labeler`（项目） | images:read / images:write(限 tag字段) / tasks:run |
| `viewer`（项目） | *:read |

**enforce 伪代码**：

```python
def require_perm(perm: str, project_scoped: bool = True):
    async def _dep(request: Request,
                   project_id: str | None = Header(None, alias="X-Project-Id")):
        principal = request.state.user or request.state.api_key
        if principal is None: raise HTTPException(401)
        if isinstance(principal, ApiKey):
            return _check_apikey_perm(principal, perm, project_id)
        if principal.is_root: return
        if not project_scoped:
            if perm not in principal.global_perms: raise HTTPException(403)
            return
        if not project_id: raise HTTPException(400, "X-Project-Id required")
        role = principal.roles.get(project_id)
        if not role or perm not in ROLE_PERMS[role]:
            raise HTTPException(403, {"code":"forbidden","perm":perm,"project":project_id})
        current_project_id.set(project_id)   # 见 §4.4
    return _dep
```

### 4.4 多租户隔离（关键创新）

**逐端点加 `WHERE project_id = ?` = 150 处改动 + 永远漏 = 不可接受。**

**推荐**：ContextVar + SQLAlchemy `do_orm_execute` event 自动注入：

```python
# sidecar/db/tenant.py
current_project_id: ContextVar[str | None] = ContextVar("pid", default=None)
TENANT_TABLES = {"images","tasks","batch_runs","duplicate_groups",
                 "batch_subtasks","prompt_docs", ...}

@event.listens_for(AsyncSession.sync_session, "do_orm_execute")
def _inject_tenant(state):
    if state.is_select:
        pid = current_project_id.get()
        if pid is None: return                 # 系统级查询，跳过
        for desc in state.statement.column_descriptions or []:
            ent = desc.get("entity")
            if ent is not None and ent.__tablename__ in TENANT_TABLES:
                state.statement = state.statement.where(ent.project_id == pid)
```

INSERT/UPDATE/DELETE 走 `before_flush` hook 校验 `project_id` 一致，不一致 raise。

**裸 SQL / `text()` 不被 hook 覆盖** → 列入改造点 §4.5#2。

**Postgres RLS 兜底**（仅 server 模式）：

```sql
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
CREATE POLICY images_tenant ON images
  USING (project_id = current_setting('app.project_id', true));
```

每请求开始时 `SET LOCAL app.project_id = $pid`。即使应用层 hook 漏了，DB 兜住。SQLite 模式无 RLS，依赖应用层（电脑端单机风险可接受）。

**不选的方案**：
- ❌ 逐端点改：风险高、回归慢、新人写新端点必漏
- ❌ schema-per-tenant：迁移噩梦，pgvector 索引重复

### 4.5 改造点清单（按风险倒序）

| # | 改造 | 风险点 | 估时 |
|---|---|---|---|
| 1 | SQLAlchemy 自动注入 `project_id`（含 INSERT/UPDATE/DELETE 校验 + 单测全 TENANT_TABLES） | 漏注入=越权读；hook 行为对 join/subquery 边界 | **3d** |
| 2 | 审查所有 `text()` / 裸 SQL 调用，改造或显式标 `@allow_cross_tenant` | 容易遗漏，需全量 grep + checklist | **3d** |
| 3 | Users/Sessions/Roles/ProjectMembers 表 + alembic + 默认角色 seed | 中 | **2d** |
| 4 | UserAuthMiddleware（JWT 解析 + state.user） + require_perm 依赖 | 中 | **2d** |
| 5 | 150+ /api/* 端点逐个挂 Depends(require_perm)（可脚本扫 router 半自动） | 工作量大，每处 1 行 | **5d** |
| 6 | /api/auth/login\|refresh\|logout\|me + Argon2 + JWT 工具 | 中 | **2d** |
| 7 | 云端 /internal/v1/cloud-token/exchange + 桌面换发 client | 中 | **2d** |
| 8 | Postgres RLS policies + SET LOCAL 中间件（仅 server 模式） | server 模式专属 | **2d** |
| 9 | 项目成员 / 角色管理路由 | 低 | **2d** |
| 10 | ApiKey 增 owner_user_id + project_id，迁移存量 key 到 root + default project | 数据迁移要可重入 | **1d** |
| 11 | Bootstrap CLI + 启动检测无 root 自动 setup 模式 | 低 | **1d** |
| 12 | BUILD_FLAVOR=ops 走 single_user 模式 | 必须严格 gate 在 ops flavor | **2d** |
| 13 | config_audit_logs.actor_meta 扩展 + auth_events 表 | 低 | **1d** |
| 14 | password_reset_tokens + user_invitations 路由 + 邮件 stub | 低 | **2d** |
| 15 | E2E 测试：跨租户读越权 / 角色降级 / refresh 撤销 / RLS 兜底 | **必做**，否则前面形同虚设 | **3d** |

**合计 ~33 人天。**

### 4.6 迁移路径

**Bootstrap 第一个 admin**：

```bash
uv run lintu admin bootstrap-root --email a@b.com --password '...'
```

启动时 sidecar 检测无 root → `/api/*` 仅放行 `/api/auth/setup`（仅 127.0.0.1），其余 503。

**ops 版兼容**：

```python
# sidecar/middleware/user_auth.py
if AUTH_MODE == "single_user":   # esbuild --define LINTU_AUTH_MODE
    request.state.user = SYSTEM_ROOT_PRINCIPAL   # roles={"*":"root"}
    current_project_id.set(request.headers.get("X-Project-Id") or DEFAULT_PROJECT)
    return await call_next(request)
```

ops 版升级后行为完全等价 — 不强制登录、所有端点照常。

**ApiKey 迁移**（既挂 user 又挂 project）：

```sql
ALTER TABLE api_keys ADD COLUMN owner_user_id VARCHAR REFERENCES users(id);
ALTER TABLE api_keys ADD COLUMN project_id    VARCHAR REFERENCES projects(id);
```

- `owner_user_id` = 谁创建（审计 + 配额归账），可空
- `project_id` = 这把 key 能访问的项目，**非空**

迁移脚本一次性把存量 key 归到 root + 默认 project。

---

## 五 · UX 与前端实现（UX 视角）

### 5.1 登录与会话

**推荐**：一次性登录 + 长期 refresh + 静默续期 + **离线宽限期 7 天**。

| 方案 | 利 | 弊 | 选不选 |
|---|---|---|---|
| 永久离线（设备绑定） | 0 摩擦 | 无审计、被解雇也带得走 | ❌ |
| **一次性登录 + 长期 token** | 一次绑定，离线 7 天可用，被禁后下次联网即踢 | 设备丢了得管理员吊销 | ✅ |
| 每次启动登录 | 强审计 | 桌面应用反 OS 直觉，必被骂 | ❌ |

**实现要点**：
- Token 存 Electron `safeStorage`（macOS Keychain / Windows DPAPI），不要 localStorage
- 启动时 sidecar 用本地 token 拉 `/auth/me`：成功 → 进 app；401 → 弹登录；网络错且 token 未过 7 天 → 离线模式（顶栏黄条「离线中，部分写操作禁用」）
- Refresh 走静默后台

**多账号切换**：MVP **不做**。一台机器一个身份。设置页「退出登录」即可换号。

**"我是谁"显示位置**：**左下角侧栏底部固定区**，紧贴 ProjectSelector 上方。展示 头像 + 姓名 + 角色徽章，点击弹 popover「个人信息 / 退出登录」。

### 5.2 权限不足的反馈

| 场景 | 推荐 | 理由 |
|---|---|---|
| **侧栏模块入口** | **隐藏** | 灰显 9 个有 4 个不能点 → 每天烦一次。隐藏 = 角色清爽。例外：ops 版可在设置开「显示所有模块（含无权限）」便于截图沟通 |
| **模块内按钮** | **灰显 + tooltip 写所需角色** | 已经进入模块，看到按钮被灰意味着"我知道有这事但不能做"，比凭空消失合理 |
| **API 403** | **toast.error**，不弹模态、不跳登录页 | 跳登录会让用户以为"被踢了"恐慌；toast 5s 配文「权限不足：此操作需要 X 角色」最克制 |
| **API 401** | 跳登录页 | token 失效专属 |

**关键区分：401 跳登录，403 给 toast。**

### 5.3 多租户切换

- ProjectSelector 数据源切到 `/api/projects?mine=1`
- 用户只属 1 项目时仍显示选择器（**只读 chip**），不彻底隐藏 — 它承载"我现在在哪个项目"的状态指示
- 切换项目时：
  ```ts
  // 项目相关 query 都把 projectId 作为 key 第二项
  queryClient.removeQueries({
    predicate: (q) => q.queryKey.some(part => part === oldProjectId)
  })
  ```

### 5.4 审计感知

- ConfigAuditTimeline 已在匹配策略底部 ✅
- 写操作前 hover 提示「上次由 张三 于 2h 前修改」
- 关键 Tab（标签体系/提示词/AI Provider/OSS）进入时若"距上次他人修改 < 1h"，顶部黄条 banner「李四刚刚修改过本页配置（5 分钟前），刷新查看」+ 刷新按钮
- API Key Tab 每行显示"由 X 创建 / 最后使用 Y 时"

### 5.5 RBAC UX 反例（避坑）

1. **"权限不足"不告诉缺什么**：toast 只写"权限不足" → 用户去问谁？正确：「需要 admin 角色，请联系 张三（项目所有者）」
2. **页面载入后才发现按钮一片灰**：用户花 3 秒理解"我啥都不能做" → 模块入口阶段就藏
3. **角色名暴露技术词**：UI 写 `role: ops_admin_v2` → 用业务词「运营管理员」「审核员」「访客」

### 5.6 MVP UX 范围

**第一版必做**：
- 登录页 + token 存 safeStorage + `/auth/me` 启动校验
- 侧栏底部「我是谁」+ 退出登录
- ProjectSelector `?mine=1`
- fetch wrapper 集中处理 401/403
- 三种角色：`owner` / `editor` / `viewer`
- 侧栏 9 模块按角色隐藏

**字段先存 UI 暂不区分**：
- 细粒度 per-tab 权限
- 模块内按钮级 disable（先全有或全无）
- 跨页审计扩散
- 审批流
- 多账号同机切换

### 5.7 前端实现要点

**层次**：hook 为主 + wrapper component 兜底 + atom 只放原子态。

```ts
// src/renderer/hooks/usePermission.ts
type Action =
  | 'module.match-lab.view'
  | 'module.match-lab.edit'
  | 'project.delete'
  | 'apikey.create'
  // ... 闭合枚举，禁止字符串拼接

export function usePermission() {
  const user = useAtomValue(currentUserAtom)
  const projectId = useAtomValue(activeProjectIdAtom)
  return {
    can: (action: Action): boolean => check(user, projectId, action),
    role: getRoleInProject(user, projectId),
    requires: (action: Action): string | null =>
      check(user, projectId, action) ? null : roleNeededLabel(action),
  }
}

// 用法
const { can, requires } = usePermission()
<Button disabled={!can('apikey.create')}
        title={requires('apikey.create') ?? undefined}>
  新建 API Key
</Button>
```

**模块切换 guard**：

```ts
// LeftSidebar.tsx
const NAV_ITEMS = [
  { id: 'match-lab', title: '匹配实验室', icon: FlaskConical, requires: 'module.match-lab.view' },
  // ...
]
const { can } = usePermission()
const visibleItems = NAV_ITEMS.filter(i => !i.requires || can(i.requires))
```

**深度链接防护**（避免侧栏没显示但 atom 残值还能进）：

```tsx
// AppShell.tsx
useEffect(() => {
  const required = MODULE_REQUIRED_ACTION[activeModule]
  if (required && !can(required)) {
    setActiveModule('dashboard')
    toast.error('该模块需要更高权限')
  }
}, [activeModule, can])
```

`activeModuleAtom` 不持久化（已经如此），重启必从 dashboard 进。`settingsTabAtom` 同理需 guard。

**前后端共享权限定义**：放 `packages/shared/permissions.ts`，杜绝「前端说要 admin 后端说要 owner」的不一致。

---

## 六 · PR 序列与里程碑

按依赖关系串行，6 个 PR：

| PR | 内容 | 改造点 | 估时 | 必备测试 |
|---|---|---|---|---|
| PR-1 | schema + 迁移 + bootstrap CLI | #3 #11 | 3d | 迁移可重入；bootstrap 二次执行被拒 |
| PR-2 | UserAuth + JWT + login/refresh + 单用户兼容 | #4 #6 #12 | 6d | ops 版升级后行为不变；user 版 401 弹登录 |
| PR-3 | **tenant ContextVar + ORM hook + 单测** | #1 #2 | 6d | **节流点** — 全 TENANT_TABLES 必须 100% 覆盖；裸 SQL 全部审查 |
| PR-4 | 批量挂 require_perm + 成员管理路由 | #5 #9 | 7d | 跨角色调用 100+ 端点 → 403 矩阵全绿 |
| PR-5 | 云端 token-exchange + ApiKey 迁移 | #7 #10 | 3d | 云端 sidecar 收 cloud_jwt 通过；存量 key 不破 |
| PR-6 | RLS + 审计扩展 + 邀请/重置 + E2E | #8 #13 #14 #15 | 8d | 越权读 / 角色降级 / refresh 撤销 / RLS 兜底全绿 |

**总计 33 人天 ≈ 6-7 周（单人）/ 3-4 周（2 人并行 PR-3 完成后）**。

**PR-3 是关键节流点**：必须有完整测试矩阵覆盖所有 TENANT_TABLES 才能合，否则后续端点改造站在沙地上。

---

## 七 · 需你拍板的 5 个决策点

⚠️ **这些不是技术决策，是产品 / 商务决策，要在 PR-1 启动前定下来。**

### 决策 1：**平台运营**访问客户数据是否需要事前授权？

| 选项 | 含义 | 推荐 |
|---|---|---|
| A | 平台运营全部默认只读，写工单留痕即可 | ✅ MVP |
| B | 读也需客户每次授权 | 过严，客服 SLA 难保 |
| C | 完全不做隔离，平台运营 = 全权 | 不可接受，B 端客户无法接受 |

**默认建议 A**：写在合同 + 产品 UI 双重位置，把模糊信任变成白纸黑字。

### 决策 2：**审计日志**客户能否自查？

| 选项 | 含义 | 推荐 |
|---|---|---|
| A | MVP 仅后台 SQL 查 | ✅ MVP |
| B | V2 给景区管理员开放本租户日志，**不展示**平台运营内部操作细节 | ✅ V2 |
| C | 全开放，含平台运营操作 | 平台内部信息暴露过多 |

### 决策 3：**prompts / tag-schema / 标注数据**是否算客户资产？

**强烈建议明确算**，写入服务条款：

- 灵图不得将 A 客户的 prompt 复用到 B 客户，即使脱敏
- 这条决定了"模板市场""跨景区智能推荐"等未来功能的边界
- 影响 §2.5 五个全局表的改造方向（必须改成 project 维度）

### 决策 4：**全局表迁移方向**（直接受决策 3 影响）

§2.5 列的 5 个无 project_id 的表怎么办？

| 选项 | 改造 | 工作量 |
|---|---|---|
| A | **全部改成 project 维度**：每个项目有自己的 prompts/strategies/tag-schema/synonyms/config | 大（+5d 数据迁移 + 端点改） |
| B | **保留全局，仅 system:admin 可改**：所有项目共享 | 小（沿用现状） |
| C | 混合：tag-schema/synonyms 全局；prompts/strategies/config 项目 | 中 |

**建议 C**：
- tag-schema 全局（行业标准，不该按客户分）
- synonyms 全局（同行业口语相同，无需重复维护）
- **prompts / strategies / match_default_filters** 改成项目维度（这些是客户的 know-how）
- config 拆分：provider/OSS 全局，匹配相关项目级

### 决策 5：**用户登录身份**

| 选项 | 实现 | 适用 |
|---|---|---|
| A | 本地账号（email + 密码） | ✅ MVP — 简单、可控、无外部依赖 |
| B | 微信扫码 / 钉钉 SSO | 太重，引入第三方 OAuth 流；V2 再说 |
| C | 邮箱魔术链接（无密码） | 邮件投递不可控（垃圾箱），客户不友好 |

**建议 A**。

---

## 八 · 风险与回退

| 风险 | 触发条件 | 缓解 | 回退路径 |
|---|---|---|---|
| ORM hook 漏注入 | 新写端点忘标 / join 边界异常 | PR-3 单测全 TENANT_TABLES + 代码 review checklist | server 模式 RLS 兜底；user 模式只能修代码 |
| 现有 ops 用户被强制登录 | BUILD_FLAVOR 路径漏判 | PR-2 强测 single_user 模式；esbuild --define gate | rollback PR-2 |
| ApiKey 迁移破坏现有外部调用 | 客户已有 key 调用 → 403 | PR-5 迁移脚本可重入 + 灰度 | 给所有存量 key 设 owner=root, project=default 兼容 |
| JWT 密钥泄漏 | 配置文件被提交 git | `LINTU_AUTH_JWT_SECRET` 入 .gitignore；自动生成时 chmod 600 | 轮换密钥使所有 token 失效 |
| 性能下降 | RLS 慢查询 / hook overhead | PR-3 / PR-6 跑 bench_match.py 对比 baseline | 关 RLS（仅 server 模式），强化应用层 |
| 客户拒绝改造 | 现有签约客户对"必须登录"有意见 | 提前沟通；ops 版保留 single_user 兜底 | 灰度发布 user 版，老客户继续 ops 版 |

---

## 九 · 后续工作（不在本期范围）

- **V2 角色拆分**：景区管理员从运营独立、只读观察员、集团视图
- **跨景区授权流程**：平台运营写操作触发客户管理员审批弹窗
- **临时顾问 token**：景区管理员发放带过期 + scope 的一次性凭据
- **SSO 接入**：微信扫码 / 钉钉 / 飞书
- **API Key 配额 + 限流**：按项目 + 用户分级限流
- **审计可视化**：平台级审计 dashboard（仅 platform admin 可见）
- **数据导出审计**：下载原图大图必须留痕

---

## 附录 A · 当前端点 → 推荐 permission 映射（前 30 个）

| Endpoint | Permission | 备注 |
|---|---|---|
| GET /api/images | images:read | 自动 project_id 过滤 |
| PUT /api/images/{id}/tags | images:write | |
| DELETE /api/images/{id} | images:delete | |
| POST /api/images/batch/delete | images:delete | |
| POST /api/image-review/decide | images:write | 仅 operator |
| POST /api/projects | system:admin | 跨项目操作 |
| DELETE /api/projects/{id} | project:admin | 项目级 |
| PUT /api/config | system:admin（全局键）/ project:admin（项目键） | 拆分见决策 4 |
| GET /api/config/audit-log | audit:read | |
| POST /api/api-keys | apikeys:manage | |
| DELETE /api/api-keys/{id} | apikeys:manage | |
| POST /api/batches | batches:write | |
| POST /api/batches/{id}/cancel | batches:write | |
| PUT /api/tag-schema/{dim} | system:admin（决策 4-C：全局） | |
| POST /api/match-synonyms | system:admin（决策 4-C：全局） | |
| POST /api/prompts | tags:manage（决策 4-C：项目级） | |
| PUT /api/prompts/{id} | tags:manage | |
| DELETE /api/prompts/{id} | tags:manage | |
| POST /api/oss/backfill | system:admin | |
| POST /api/providers/test | system:admin | |
| GET /api/match-analytics/analytics | audit:read | |
| POST /api/match-analytics/eval/ideal | tags:manage | 影响 baseline |
| GET /api/stats/dashboard | images:read | |
| GET /api/matrix | tags:read | |
| GET /api/duplicate-groups | images:read | |
| POST /api/duplicate-groups/{id}/set-kept | images:write | |
| POST /api/tasks | tasks:run | |
| POST /api/tasks/{id}/cancel | tasks:run | |
| GET /api/api-keys/{id}/logs | audit:read + apikeys:manage | 含敏感日志 |
| GET /api/config/sync-status | system:admin | 暴露 cloud target URL |

剩余 120+ 端点的完整映射在 PR-4 的实现 PR 里给出。

---

## 附录 B · 关键文件改造清单

**后端**：

```
apps/sidecar/sidecar/
├── db/
│   ├── models.py                     # +User/Session/Role/RolePermission/ProjectMember/...
│   ├── tenant.py (新)                 # ContextVar + ORM event
│   └── ...
├── alembic/versions/
│   ├── 20260507_0190_add_users.py (新)
│   ├── 20260507_0200_add_project_members.py (新)
│   ├── 20260507_0210_apikey_user_project.py (新)
│   └── 20260507_0220_pg_rls_policies.py (新, server only)
├── middleware/
│   ├── auth.py                       # 已有，处理 ApiKey
│   ├── user_auth.py (新)              # 处理 User JWT
│   └── tenant_context.py (新)         # SET LOCAL app.project_id
├── routers/
│   ├── auth.py (新)                   # /api/auth/login|refresh|logout|me
│   ├── members.py (新)                # /api/projects/{pid}/members
│   ├── roles.py (新)                  # /api/roles
│   └── 现有 100+ 端点逐一加 Depends(require_perm)
└── cli/admin.py (新)                  # bootstrap-root
```

**前端**：

```
apps/electron/src/renderer/
├── pages/
│   └── Login.tsx (新)
├── hooks/
│   ├── useCurrentUser.ts (新)
│   ├── usePermission.ts (新)
│   └── useBuildFlavor.ts             # 已有
├── atoms/
│   └── auth.ts (新)                   # currentUserAtom (atomWithStorage)
├── components/app-shell/
│   ├── AppShell.tsx                   # +模块 guard effect
│   ├── LeftSidebar.tsx                # +NAV_ITEMS.requires + filter + UserBadge
│   └── UserBadge.tsx (新)             # 左下角 avatar + 角色徽章
├── components/auth/
│   ├── LoginForm.tsx (新)
│   └── PermissionGate.tsx (新)        # 兜底 wrapper
└── lib/
    ├── api.ts                         # +401/403 拦截、auth 端点封装
    └── permissions.ts (新)            # 闭合 Action enum + role-perm 映射
```

**共享**：

```
packages/shared/permissions.ts (新)    # 前后端共享 permission 字符串常量
```

---

**END.**

完整方案已就位。
拍板第七节 5 个决策后，启动 PR-1（schema + bootstrap CLI），3 天内可见第一版迁移。
