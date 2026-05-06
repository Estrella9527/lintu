# 灵图配置导入 / 导出指南

> 把一台机器调好的「AI 服务商」「标签体系」「提示词模板」配置打包搬到另一台机器，避免重复劳动。
>
> 全部走 `localhost:7879/api/...` 本地接口；面向运维 / 开发同学。

---

## 通用约定

所有导出 / 导入接口的 JSON 顶层都有 `_meta`：

```jsonc
{
  "_meta": {
    "lintu_export_kind": "tag_schema | prompts | ai_providers",
    "version": 1,
    "exported_at": "2026-04-30T00:00:00Z"
  },
  ...
}
```

`version` 是 schema 版本号，未来若格式变更不向后兼容会涨。导入器会拒绝未知版本。

`_meta.lintu_export_kind` 用于让导入端验证「这文件是给我的吗」。

---

## 一. AI 服务商配置

### 涵盖字段

| 字段 | 说明 | 是否敏感 |
|---|---|---|
| `custom_relays` | 自定义 relay 列表（JSON 字符串），每条含 `name / base_url / api_key / model / capabilities` | api_key 敏感 |
| `default_image_embedding_provider` | 图像 embedding 默认 provider，如 `relay:ark-embedding` | 否 |
| `default_general_provider` | 通用 LLM 默认 provider | 否 |
| `default_parser_provider` | 文档解析默认 provider | 否 |
| `general_provider_model` | 通用 LLM 选用的 model | 否 |
| `parser_provider_model` | 解析器选用的 model | 否 |
| `image_embedding_model_override` | 强制覆盖 embedding model（可选） | 否 |
| `image_output_size` | 生图输出分辨率默认值 | 否 |
| `gemini_api_key` / `openai_api_key` / `qwen_api_key` / `jimeng_api_key` / `tongyi_wanxiang_api_key` / `zhipu_api_key` | 内置厂商凭据 | 是 |
| `comfyui_url` | ComfyUI 后端地址 | 弱敏感 |

> **不导出的字段**：本机数据目录、上传策略、OSS 凭据、匹配默认值（`match_default_*`）等 — 那些是「运行环境配置」，跨机器复制反而坑。

### 导出

```bash
# 默认：所有 api_key 字段被 mask 成 "sk-X****"，安全可贴出来分享
curl -s http://127.0.0.1:7879/api/config/export-providers > providers.json

# 完整凭据（仅在你完全信任目标机器时使用）
curl -s 'http://127.0.0.1:7879/api/config/export-providers?include_secrets=true' > providers.json
```

输出示例：

```jsonc
{
  "_meta": { "lintu_export_kind": "ai_providers", "version": 1, "include_secrets": false, "exported_at": "..." },
  "config": {
    "custom_relays": "[{\"name\":\"ark-embedding\",\"base_url\":\"...\",\"api_key\":\"sk-A****\",\"model\":\"...\"}]",
    "default_image_embedding_provider": "relay:ark-embedding",
    "default_general_provider": "...",
    "..."
  }
}
```

### 导入

```bash
# 把 providers.json 推到新机器
curl -X PUT http://127.0.0.1:7879/api/config/import-providers \
  -H 'Content-Type: application/json' \
  -d @providers.json
```

> 注意：默认是 `mode=merge`，即按 `name` 合并 relay；本地已有的 relay 不在导入文件里就保留。如果想完全覆盖，请改 `mode: "replace"`。
>
> **被 mask 的 api_key 在导入时会被自动跳过**，目标机器的真实 key 保留不变。如果目标机原本就没有 key，需要在 UI 里手动补。

### 跨机器迁移建议流程

1. 源机器：导出（默认 mask）→ 拿到 `providers.json`
2. 目标机器：先在 UI 里手动配好 api_key（一次性）
3. 目标机器：导入 → relay 列表、默认 provider 选择都自动同步
4. 完成

如果你信任两台机器并且懒得手填 api_key：源机器加 `?include_secrets=true` 导出，目标机器导入就完整覆盖。但**这个文件不能贴公网**。

---

## 二. 标签体系（Tag Schema）

### 涵盖字段

完整的标签维度定义，每个维度形如：

```jsonc
"scene": {
  "label": "场景类型",
  "required": true,
  "multi": false,
  "values": ["山地景观", "水域", "森林步道", ...]
}
```

无敏感字段。

### 导出

```bash
curl -s http://127.0.0.1:7879/api/tag-schema/export > tag-schema.json
```

输出：

```jsonc
{
  "_meta": { "lintu_export_kind": "tag_schema", "version": 1, "exported_at": "..." },
  "schema": {
    "scene": { "label": "场景类型", "required": true, "multi": false, "values": [...] },
    "facility": { ... },
    "..."
  }
}
```

### 导入

```bash
# 默认 merge：合并新维度 + 合并新值，旧值保留
curl -X POST http://127.0.0.1:7879/api/tag-schema/import \
  -H 'Content-Type: application/json' \
  -d "$(jq '. + {schema_data: .schema} | del(.schema)' tag-schema.json)"

# 或手工拼一份请求体（更直观）
curl -X POST http://127.0.0.1:7879/api/tag-schema/import \
  -H 'Content-Type: application/json' \
  -d '{"schema_data": <schema 内容>, "mode": "merge"}'

# 完全替换
# -d '{"schema_data": <schema 内容>, "mode": "replace"}'
```

> `replace` 模式只在你想把目标机器的 schema 完全推倒重建时用 — 旧的本地自定义值会丢。
>
> 标签 schema 改动只影响后续打标，**不会重写已经打好的图片标签**（那些在 `tags` 表里独立存）。

### 注意

- 删除某个维度的 value（A 机器有 B 机器没有）当前无法通过导入实现 — merge 只加不减。需要删除的话用 UI 的 `DELETE /tag-schema/{dim}/{value}`。
- 改完会自动通过 cloud_sync_worker 同步到云端 sidecar，UGC 端约 30s 后生效。

---

## 三. 提示词模板（Prompt Templates）

### 涵盖字段

每条 prompt 的可移植字段：

| 字段 | 说明 |
|---|---|
| `name` | 名称（用作导入时的去重 key） |
| `category` | 分类（必填） |
| `content` | 提示词正文（必填，可含 `{var}` 占位） |
| `is_default` | 是否默认 |
| `task_type` | 适用任务类型（如 `style`, `outpaint`） |
| `negative_prompt` | 反向提示 |
| `variables` | 占位变量定义 `[{name, type, default}]` |
| `tags` | 标签数组 |
| `is_active` | 是否启用 |
| `version` | 版本号 |

**不导出**：`id`, `parent_id`, `created_at`, `updated_at`, `stats`（运行时数据）— 这些跨机器没意义。

### 导出

```bash
# 全部
curl -s http://127.0.0.1:7879/api/prompts/export > prompts.json

# 按 category / task_type 过滤
curl -s 'http://127.0.0.1:7879/api/prompts/export?category=人像&only_active=true' > prompts.json
```

输出：

```jsonc
{
  "_meta": { "lintu_export_kind": "prompts", "version": 1, "exported_at": "...", "count": 42 },
  "prompts": [
    {
      "name": "UE5 超写实",
      "category": "风格",
      "content": "...",
      "task_type": "style",
      "variables": null,
      "tags": ["realistic"],
      "is_active": true,
      "version": 1
    },
    ...
  ]
}
```

### 导入

```bash
# 默认 skip_existing：name 已存在的不动，新名字才创建
curl -X POST http://127.0.0.1:7879/api/prompts/import \
  -H 'Content-Type: application/json' \
  -d @prompts.json

# upsert：name 已存在的就用导入的内容覆盖（小心，会丢失本地修改）
# -d '{"prompts": [...], "mode": "upsert"}'

# create_new：忽略 name 冲突，全部创建（会出现重名）
# -d '{"prompts": [...], "mode": "create_new"}'
```

返回：`{"ok": true, "created": N, "updated": M, "skipped": K, "invalid": L}`

### 三种模式选哪个

| 场景 | 推荐 |
|---|---|
| 第一次给新机器初始化 | `skip_existing`（默认） |
| 主源机器有更新，要推到副机器 | `upsert` |
| 测试 / 实验环境，允许重复 | `create_new` |

---

## 跨机器复刻完整流程（实操）

把整套配置从「源机器 A」搬到「目标机器 B」：

```bash
# ── 在 A 上 ──
curl -s 'http://127.0.0.1:7879/api/config/export-providers?include_secrets=true' > providers.json
curl -s 'http://127.0.0.1:7879/api/tag-schema/export'                            > tag-schema.json
curl -s 'http://127.0.0.1:7879/api/prompts/export'                               > prompts.json

# 拷贝到 B
scp providers.json tag-schema.json prompts.json b@host:~/
```

```bash
# ── 在 B 上 ──
# 1. AI 服务商
curl -X PUT http://127.0.0.1:7879/api/config/import-providers \
  -H 'Content-Type: application/json' -d @providers.json

# 2. 标签体系（manual transform: rename `schema` → `schema_data`）
jq '{schema_data: .schema, mode: "merge"}' tag-schema.json | \
  curl -X POST http://127.0.0.1:7879/api/tag-schema/import \
    -H 'Content-Type: application/json' -d @-

# 3. 提示词
curl -X POST http://127.0.0.1:7879/api/prompts/import \
  -H 'Content-Type: application/json' -d @prompts.json
```

约 10 秒搞定。

---

## 安全提示

- **`providers.json with include_secrets=true` 是凭据级敏感**：不要进 git、不要发群、不要 scp 到公共机器。传完立刻删除。
- 导出文件本身没有签名 / 加密 — 你信任发送通道（SSH / scp / U 盘）就够安全。
- 标签 schema 和 prompt 文件可以公开传播 / 进 git。
