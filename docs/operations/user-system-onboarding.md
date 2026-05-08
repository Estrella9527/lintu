# 用户系统 Phase 1 · 运维 Onboarding

> 第一次接手灵图运维 / 部署的人读这一篇就够。
>
> 涉及：登录登出 · 角色 · 项目隔离 · 短信凭据 · CLI 工具 · 故障预案。

---

## 一、心智模型

灵图 v0.1.5 引入 **「身份 + 项目隔离」** 但**未做权限拆分**：

```
身份层  ──  18435223985 用手机号 + 短信验证码登录灵图
        ──  超级管理员（root） vs 普通用户（member）

隔离层  ──  普通用户只能看自己加入的 project；ORM 在 SELECT/INSERT 时自动注入
            WHERE project_id IN (...) 防止跨租户读写

权限层  ──  Phase 1 不做。所有登录用户在自己 project 里能调全部 /api/* 写操作。
            事后追溯靠「操作日志」（设置 → 操作日志 timeline）。
```

设计取舍：UGC 端 / 公开 API 走独立鉴权（`/open-api/v1/*` + ApiKey），跟用户系统并行无干扰。

---

## 二、首次部署 / 接手 checklist

> **从 v0.1.x 升级到 v0.2.0 的客户机**：不需要跑 bootstrap-root。alembic 自动迁移
> 后启动 app，**第一个用手机号登录的人会自动成为这台机器的 owner**（接管所有项目 +
> 数据 + 平台超管权限）。详见 §10 「升级路径」。

按顺序（**全新机器** 部署）：

### 2.1 申请并配置阿里云短信
按 [`sms-aliyun-onboarding.md`](./sms-aliyun-onboarding.md) 走完，最终把 5 个 env 配进 sidecar 启动环境：

```bash
# 推荐写到 ~/.lintu-secrets.zsh 然后 ~/.zshrc 末尾加 source
export LINTU_SMS_PROVIDER=aliyun
export LINTU_SMS_ACCESS_KEY=LTAI5t...
export LINTU_SMS_ACCESS_SECRET=...
export LINTU_SMS_SIGN_NAME=灵图   # 跟阿里云审核通过的签名一字不差
export LINTU_SMS_TEMPLATE_CODE=SMS_xxxxxxx
```

不配置的话 sidecar 自动降级把验证码 print 到日志（`[sms] DEV FALLBACK`），**生产部署严禁这种状态**。

### 2.2 创建第一个超级管理员
```bash
cd apps/sidecar
uv run python -m sidecar.cli.admin bootstrap-root \
  --phone 18435223985 \
  --display-name "Yang"
```

效果：
- 创建 `is_root=True` 的 user
- 把它加为所有现有 project 的 ProjectMember（看到全部历史数据）
- 重复运行会拒绝（防止双 root 漂移）

### 2.3 启动应用 & 验证登录
```bash
# 主进程 + 渲染进程（生产打包另说）
cd apps/electron
npx vite --config vite.config.ts &
source ~/.lintu-secrets.zsh && npx electron .
```

输入手机号 → 收码（真机或开发降级模式查日志）→ 进入 AppShell 看到全部数据。

---

## 三、日常运维操作

### 3.1 邀请新成员
两条路：

| 场景 | 操作 |
|---|---|
| **超级管理员从 UI 邀请**（推荐） | 设置 → 成员管理 → 输手机号 → 「发邀请」 |
| **CLI 直接加成员** | `uv run python -m sidecar.cli.admin add-member --project-id <pid> --phone 138xxx --display-name "张三"` |

被邀请人下次用同手机号登录灵图时**自动加入项目**（不发额外短信，靠登录流量自动接受）。

### 3.2 查看 / 撤销邀请
设置 → 成员管理 → 看到三档：「待接受 / 已加入 / 已过期」。pending 状态可点「撤销」。

### 3.3 操作审计
设置 → 操作日志（仅超级管理员可见）：
- 默认显示最新 100 条
- 支持按路径前缀过滤（如 `/api/projects` 只看项目变更）
- 30 秒自动刷新；右上角「刷新」按钮强制更新

### 3.4 多设备管理
左下角用户头像 → 弹窗 → 「我的登录设备」：列出账号在所有机器的 session，丢失/被盗用情况下可一键踢下线。

### 3.5 重置超级管理员
旧 root 离职 / 手机号丢失：

```bash
cd apps/sidecar
uv run python -m sidecar.cli.admin reset-root --phone 13900000000
# 提示二次确认后：
#  1. 把 13900000000 设 is_root=True（user 不存在则新建）
#  2. 现有 root 全部降级 is_root=False（保留账号 + 项目成员关系）
#  3. 把新 root 加进所有 project（保证立刻能看到全部数据）

# 自动化场景跳过确认：
uv run python -m sidecar.cli.admin reset-root --phone 13900000000 --yes
```

---

## 四、Build flavor 和环境差异

| Flavor | 行为 | 何时用 |
|---|---|---|
| `dev` | 严格鉴权；可 `LINTU_AUTH_BYPASS=1` 跳过登录 | 本地开发 |
| `user` | 严格鉴权，无旁路 | 客户机，正式版 |
| `ops` | 自动注入 SYSTEM_ROOT 身份，不弹登录页 | 龙蟾科技运营机器 / 客户支持 |

由 esbuild `--define BUILD_FLAVOR='ops'` 烙进主进程，再由 main.cjs `process.env.LINTU_BUILD_FLAVOR` 传给 sidecar 子进程。

---

## 五、隔离边界与已知限制

| 表 | 是否隔离 | 备注 |
|---|---|---|
| images / tasks / batch_runs / batch_subtasks | ✅ 自动 WHERE project_id IN (...) | TENANT_TABLES |
| duplicate_groups / match_feedback / oss_sync_jobs / prompt_docs | ✅ 同上 | |
| projects | ✅ List 端点 + Get 端点对普通用户按 ProjectMember 过滤 | |
| prompts / strategies / tag_schema / synonyms / config | ❌ 全局共享 | Phase 1 故意不收 — 客户合同明确拆分前再迁 |
| api_keys / users / sessions / project_members / config_audit_logs | ❌ 全局或独立鉴权 | |

> **裸 SQL（`text(...)`）不被 ORM hook 覆盖** — 任何用 raw SQL 写新功能的人必须自己显式
> 加 project_id 条件，否则会越权。code review 时盯紧。

---

## 六、Token 与会话

- 类型：opaque token（32 字节 base64），落 sha256 hash 到 `sessions` 表
- 有效期：30 天
- 续期：前端每 6 小时自动调 `/api/auth/refresh` —— 活跃用户永不到期
- 撤销：单独踢（设置 → 我的登录设备）/ 全部踢（修改密码后自动 — Phase 1 没密码所以暂未实装）
- 存储：Electron 用 `safeStorage` 加密落盘（OS keychain 同级保护）

---

## 七、紧急预案

| 故障 | 应急 |
|---|---|
| 阿里云短信余额耗尽 | 临时清空 `LINTU_SMS_ACCESS_KEY` 重启 sidecar → 走 stdout 降级模式 → 让客户报手机号、你从 sidecar 日志找验证码念给客户。**仅短期**，正常应该立刻充值 |
| 超级管理员账号丢失 | `lintu-admin reset-root --phone <新号> --yes` |
| 前端死活进不去 | 短期开 `LINTU_AUTH_BYPASS=1` 重启 sidecar，相当于回到无鉴权状态；同时排查 token / DB |
| 客户怀疑被入侵 | 设置 → 我的登录设备 → 踢所有非自己的设备；同时设置 → 操作日志 → 查最近写操作是不是异常 |

---

## 八、与下游系统的接口

- `/open-api/v1/*`（ApiKey 鉴权）— 不受用户系统影响。下游服务（如官网、H5、客户业务）继续用 ApiKey 调
- `/internal/sync/*`（独立 sync_token）— sidecar → 云端 sidecar 的内部 push，没有 user 概念
- `cloud_sync_worker` — 后台同步逻辑不走用户身份；它是机器对机器的同步

---

## 十、升级路径：v0.1.x → v0.2.0

### 自动迁移做了什么

1. alembic `20260509_0220` 跑迁移：建 `organizations` / `organization_members` 表 + `projects.org_id`
2. 创建一个 **「默认组织」**（id 写死 `00000000-...-default-org-00`，slug = `default`，套餐 free，配额 100GB）
3. 把所有现有 `project` / `api_key` 归到默认组织
4. 把所有 v0.1.x 已存在的 `User` 加为默认组织成员（`is_root=True` 的 user → `owner` + `is_platform_owner=True`）

### 客户机的真实场景

绝大多数 v0.1.x 客户机**没有运行过 `lintu-admin bootstrap-root`** —
那时候完全无登录，没必要建 user。所以迁移后的状态是：

```
默认组织：1 个
project：N 个（全部归属默认组织）
图片：M 万张（所有项目下的）
user：0 个
organization_member：0 个
project_member：0 个
```

**没人 own 这堆数据**。如果客户启动 app → 注册一个新手机号 → 看到 `projects=[]`
→ 资产库一片空白 → 觉得「我的图都没了」。

### 自动认领（v0.2 引入的兜底）

`/api/auth/sms/verify` 端点新增「孤儿数据认领」逻辑：

**触发条件**（全部满足）：
- 默认组织存在且 `status=active`
- 默认组织 `OrganizationMember` 数 == 0
- 默认组织下至少 1 个 project

**触发动作**：
1. 把当前登录用户设为 `is_platform_owner=True` + `is_root=True`（向后兼容）
2. 加为默认组织的 `owner`
3. 加为所有默认组织 project 的 `project_admin`

**响应里的提示**：sms_verify 返回多两个字段
```json
{
  "claimed_orphan_data": { "org_id": "...", "org_name": "默认组织", "projects": 2 },
  "is_new_user": true
}
```

前端登录页拿到 `claimed_orphan_data` 不为 null 时，弹一个 toast：
> 欢迎，已自动接管本机 N 个项目
> 你是这台机器升级后的首位登录者，自动成为组织所有者

**安全保障**：
- 第二个登录的用户走到这里时，条件 2 已不满足（前面那位是 owner）→ 不触发
- 客户公司里如果有多个员工同时升级、同时登录，唯有第一个完成 sms_verify 的人能接管 — 其它人后登录就是普通新成员
- 这是合理的：第一个登录的应该是这台机器的主人（管理员）

### 部署建议

| 客户机情况 | 操作 |
|---|---|
| **全新部署** | 跑一次 `lintu-admin bootstrap-root --phone xxx` 显式指定首位 owner |
| **从 v0.1.x 升级** | **什么都不用做** — 自动迁移 + 让客户首位登录的人自动接管即可 |
| **升级 + 客户已经手动 bootstrap-root 过** | alembic 已把 root 用户升 platform_owner，正常用 |
| **混合部署（多家客户共用一个 sidecar）** | 别用自动认领 — 平台运营手动跑 bootstrap-root + 用 `/api/orgs` 创建多个组织分别指定 owner |

### 升级 checklist

```
1. ✅ 备份 ~/lintu-data/lintu.db
2. ✅ 运行新版 sidecar（启动时 alembic 自动跑）
3. ✅ 检查日志看到 [tenant] hooks installed + 新迁移 0220 成功
4. ✅ 启动 Electron → 登录页 → 客户输手机号
5. ✅ 检查 sidecar 日志出现 "[auth] xxx claimed orphan data: org=... projects=N"
6. ✅ 客户进 app 立刻看到所有项目 + 数据
```

---

## 九、Phase 2 路线（后续）

按触发条件排序，**用户 < 20 人之前不要做权限拆分**：

| 项目 | 触发条件 | 估时 |
|---|---|---|
| 角色拆分（admin / operator / labeler） | 用户 ≥ 20 人 / 出现 3+ 次误操作 | 8 人天 |
| 150+ 端点权限装饰器 | 同上 | 跟角色拆分合并 |
| 按钮级 disable / tooltip | 角色拆分后 | 2 人天 |
| 跨租户授权流（运营访问客户数据） | 客户 ≥ 5 家 | 3 人天 |
| 临时顾问 token / 公开分享链接 | 客户提需求 | 2 人天 |
| 全局表项目化拆分（prompts/strategies/tag_schema/synonyms） | 客户合同明确「我的 prompt 是我的资产」 | 5 人天 |

> 微信扫码登录 / 国际化手机号已**移出**路线图（短期不做）。

---

**END.** 关于具体 schema、CLI、SMS 配置细节看代码 + 同目录其它 onboarding 文档。
