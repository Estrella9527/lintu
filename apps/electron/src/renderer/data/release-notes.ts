/**
 * 灵图发布日志 — 应用内 release notes 的唯一数据源。
 *
 * 维护规范：
 *   1. 每次发版前，把 package.json 的版本号同步加一条到 RELEASES 数组顶部
 *   2. version 字符串与 apps/electron/package.json#version 保持完全一致
 *   3. date 用 YYYY-MM-DD（用户的本地阅读视角，无时区）
 *   4. highlights 是「这次升级用户最关心的 1 句话」，会显示在 Toast / Dashboard 入口
 *   5. sections 按 added / improved / fixed 三类，每条一句中文，避免堆砌技术细节
 *
 * 数组顺序：最新版本在最上面（index=0）。RELEASES[0].version 就是「当前应该展示的版本」。
 */

export type ReleaseSection =
  | { kind: 'added';    items: string[] }
  | { kind: 'improved'; items: string[] }
  | { kind: 'fixed';    items: string[] }

export interface ReleaseEntry {
  version: string                 // 必须与 package.json 一致
  date: string                    // YYYY-MM-DD
  highlights: string              // 单句中文，约 20-40 字
  sections: ReleaseSection[]
}

export const RELEASES: ReleaseEntry[] = [
  {
    version: '0.2.3',
    date: '2026-05-09',
    highlights: 'PyInstaller 收齐 SMS SDK + 用户版拒绝静默降级 — 短信真正能发出去了',
    sections: [
      {
        kind: 'fixed',
        items: [
          'PyInstaller bundle 没把 alibabacloud_* 收进去：v0.2.2 即便客户在 UI 配齐了 SMS 凭据，sidecar 启动 import 仍然失败 → 走「SDK 未装」降级 → 验证码只 print 到 log。修：sidecar.spec COLLECT_PACKAGES 增加 alibabacloud_dysmsapi20170525 / Tea / darabonba 等 8 个包',
          '用户版 silent fallback 误导：凭据未配 / SDK 未装时仍返回 (True, None)，前端弹「已发送」toast 但用户永远收不到。修：BUILD_FLAVOR=user 时显式 502 + 明确错误（"短信服务未配置" / "短信 SDK 未打包到客户端"）；dev / ops 保留 stdout 降级',
        ],
      },
    ],
  },
  {
    version: '0.2.2',
    date: '2026-05-09',
    highlights: '短信凭据搬进应用 UI — 客户机可视化配置，不再依赖 env 变量',
    sections: [
      {
        kind: 'fixed',
        items: [
          '客户机短信发不出的关键缺口：之前 SMS 凭据靠 LINTU_SMS_* 环境变量，但生产 .app 双击启动不会读 ~/.zshrc / ~/.zshenv，凭据永远是空 — 客户体验上「短信发不出去」',
          '修复：sidecar 改为优先 env、兜底从本地 config.json 读 sms_* 6 个 key。dev 模式继续走 env 不破',
        ],
      },
      {
        kind: 'added',
        items: [
          '设置 → 短信服务（仅平台超管可见）：可视化配置阿里云 SMS 凭据（AccessKey ID/Secret + 签名 + 模板编号 + 可选 Endpoint/Region）',
          '状态卡：当前凭据「已配置 / 未配置」+ 关键参数预览（AccessKey 显前 6 位掩码）',
          '发测试短信入口：填手机号一键发，立刻验证凭据是否有效（测试码固定 999999，不入 sms_codes 表）',
          '/api/sms/status + /api/sms/test 两个端点（platform owner 鉴权）',
        ],
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-05-08',
    highlights: '升级路径补丁：v0.1 客户机升级后首位登录的人自动接管所有数据',
    sections: [
      {
        kind: 'fixed',
        items: [
          'v0.1 → v0.2 升级关键缺口：alembic 把现有 project 归到「默认组织」但没人 own，新用户登录后看到 projects=[]，资产库一片空白 — 看上去图全没了',
          '修复：sms_verify 端点新增「孤儿数据认领」逻辑。当默认组织没人但有 project 时，第一位完成验证的用户自动成为组织 owner + 平台超管 + 所有项目 project_admin',
          '前端登录页识别认领事件，弹「已自动接管本机 N 个项目」明确提示，避免用户疑惑',
          '安全约束：只触发一次。第二个用户登录时默认组织已有 owner，不可被抢',
        ],
      },
      {
        kind: 'improved',
        items: [
          'sms_verify 响应新增 claimed_orphan_data 和 is_new_user 字段，便于前端做新人引导差异化',
          '运维文档 user-system-onboarding.md 新增 §10 「升级路径」章节，含 4 种部署场景的操作矩阵',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-05-08',
    highlights: '组织化上线 — 一个公司多个员工 / 多个项目 / 角色权限矩阵一站打通',
    sections: [
      {
        kind: 'added',
        items: [
          '「组织」三层身份模型：平台超管 → 组织 owner/admin/member → 项目 admin/editor/viewer/labeler',
          '左下角组织切换器：单组织时直接显示当前组织；多组织展开下拉切换；平台超管能创建新组织',
          '设置 → 组织设置 / 组织成员 / 平台管理：完整的组织级管理面板',
          '/api/orgs/* + /api/platform/* 全套端点：组织 CRUD、成员管理、平台用量概览、跨组织运维',
          '@require_capability 装饰器 + roles.py 能力表：端点级声明式权限（owner/admin/editor/viewer/labeler）',
          '现有数据零感知升级：alembic 迁移自动创建「默认组织」并把所有 project / api_key 归属过去',
          '左下角用户徽章 → 个人设置：本地上传头像（自动裁 256×256 JPEG，base64 入库），改昵称',
          '组织设置 → Logo：本地上传图片（同上一致体验）',
          '主菜单分组：工作台 / 图片运营 / 系统 — 资产库提到第 2 位，导航更清晰',
        ],
      },
      {
        kind: 'improved',
        items: [
          'UI 文案大扫除：所有 tab / 页面去掉冗长副标题段落，必要解释挪到 InfoHint（hover ⓘ 才显）',
          'InfoHint 用 React Portal + 视口边界 clamp + side 自动翻转 — 在 Dialog 内不再被 transform 父级劫持',
          'Toast 关闭按钮重做：默认隐藏，hover toast 才显形（替代原先的「大圆环」）',
          '所有前端 fetch 走 apiFetchRaw 集中函数：自动注入 Bearer + 401 自动登出 + IPv4 强制（127.0.0.1）',
          'thumbnail / file / download / SSE 改用 ?token=query 鉴权（原生 <img> / EventSource 没法塞 header）',
          'Settings 侧栏 5 大分组：组织 / 当前项目 / 资源库 / 运维 / 应用，按角色动态过滤可见 tab',
        ],
      },
      {
        kind: 'fixed',
        items: [
          'Failed to fetch：sidecar 只听 IPv4 但 Chromium 解析 localhost 走 IPv6 → 全局改 127.0.0.1',
          '个人设置保存 500：UserAuthMiddleware 用独立 DB session 加载 user，endpoint 改它会被 SQLAlchemy 拒 — 改用 db.get(User, id) 重新加载',
          '资产库 1023 张图越权：list 端点的 total count 用 select_from(query.subquery()) 模式让 ORM hook 看不到 entity → 改用 with_loader_criteria + track_closure_variables=False',
          '组织名 / 项目名过长 UI 溢出：min-w-0 + overflow-hidden 修复 flex 子项 truncate 不生效',
          '阿里云 SMS endpoint：dysmsapi.cn-hangzhou.aliyuncs.com 被本机 fake-IP DNS 劫持 → 默认改用 dysmsapi.aliyuncs.com',
        ],
      },
    ],
  },
  {
    version: '0.1.5',
    date: '2026-05-08',
    highlights: '用户系统 Phase 1：登录 + 项目隔离上线，多人协作进入闭环',
    sections: [
      {
        kind: 'added',
        items: [
          '桌面端首次启动需登录 — 手机号验证码（短信未配置时验证码会打到 sidecar 日志，方便 dev 调试）',
          '用户与项目绑定：新用户登入只看到管理员加进的 project，跨景区数据彻底隔离（ORM 层 do_orm_execute 自动注入 WHERE）',
          'CLI 工具 lintu-admin：bootstrap-root（创建首个 root + 自动加进所有现有项目）/ add-member',
          '左下角用户徽章：头像 + 昵称 + root 标识，弹窗可退出登录',
          '所有写操作（POST/PUT/PATCH/DELETE）自动写 operation_logs 留痕',
        ],
      },
      {
        kind: 'improved',
        items: [
          'ops 版桌面应用自动派 root 身份，不弹登录页 — 现有运营机器零迁移成本升级',
          'dev 环境支持 LINTU_AUTH_BYPASS=1 env 跳过登录，方便本地调试',
          'token 走 OS keychain 加密落盘（safeStorage），跟 cloud-sync-creds 同保护级别',
          '401 自动登出 + 跳转登录页；30 天 session，每 6 小时后台自动续期（活跃用户永不到期）',
          '左下角用户徽章 → 我的登录设备：列出账号在所有机器的 session，可单独踢下线',
          '设置 → 操作日志：超级管理员可查全平台写操作 timeline（POST/PUT/PATCH/DELETE）',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '修复跨租户写入风险：INSERT/UPDATE 越权 project_id 在 before_flush 阶段直接 raise',
        ],
      },
    ],
  },
  {
    version: '0.1.4',
    date: '2026-05-07',
    highlights: '分发版本物理隔离 + 配置审计 + 冲突检测 — 多人改匹配策略安全网三连',
    sections: [
      {
        kind: 'added',
        items: [
          '应用打包分两个版本：「普通用户版」和「运营管理版」。普通版物理屏蔽云端同步凭据 — 改配置永远不会影响线上 UGC，下载用户随便玩',
          '关于页加版本徽章 — 一眼能看出当前装的是哪个版本',
          '匹配策略 Tab 顶部加同步状态条带：用户版显示「绝对不会改线上」；运营版显示目标 URL + 待同步数',
          '所有 config 改动写入 config_audit_logs：谁、在哪台机、什么时候、把什么 key 从什么改成什么 — 全程可追溯',
          '匹配策略 Tab 底部加「最近修改」时间线，按 key 维度展示历史 diff',
          '配置乐观锁：保存前后端比对版本号，「另一台机器刚改过」会弹冲突解决对话框（强制覆盖 / 丢弃修改 / 先看看）',
        ],
      },
      {
        kind: 'improved',
        items: [
          'GET /api/config 返回值带 __version 字段；PUT 接受 if_version 实现乐观锁',
          'API 错误改用 ApiError 子类，保留 HTTP status + 解析后的 body，便于结构化错误处理',
          'Build 脚本拆分：build:user / build:ops 用 esbuild --define 注入 BUILD_FLAVOR 常量',
        ],
      },
    ],
  },
  {
    version: '0.1.3',
    date: '2026-05-07',
    highlights: '匹配策略整合到一个 Tab；候选源换紧凑下拉多选；运营配置直接同步 UGC',
    sections: [
      {
        kind: 'improved',
        items: [
          '设置→匹配策略 入口已删除（重复入口）；所有匹配相关在「匹配实验室」内完成',
          '匹配实验室「默认策略」改名为「匹配策略」— 上线前的运营配置面板，保存即同步 UGC',
          '候选源精细化合并到「匹配策略」Tab：策略权重 + 候选源约束 = 一份完整的线上匹配配置',
          '候选源 UI 重做：所有维度改用紧凑下拉多选（点击触发器弹层选项 + 选中 chip 显示），不再铺开占据大半屏',
          '试匹配 Tab 仍可独立调过滤参数，与运营默认值解耦，便于"先试再保存"工作流',
        ],
      },
      {
        kind: 'added',
        items: [
          '后端新 config 键 match_default_filters：一份 JSON dict 存所有候选源默认（source_type / prompt_ids / folder_prefix / tags / image_ids）',
          'UGC 调匹配 API 时未传的字段自动 fallback 到 match_default_filters；显式传值仍然覆盖',
          '通用组件 MultiSelectPopover：触发器一行 + 弹层支持搜索 / 全选 / chip 反选',
        ],
      },
    ],
  },
  {
    version: '0.1.2',
    date: '2026-05-07',
    highlights: '匹配相关全部收到「匹配实验室」；候选源支持按 Prompt / 标签 / 图片白名单精细化',
    sections: [
      {
        kind: 'added',
        items: [
          '匹配实验室加「默认策略」Tab — 原 设置→匹配策略 全部搬迁至此，UGC 调匹配 API 的默认参数集中管理',
          '试匹配的「候选源」面板：支持按 Prompt 多选、按子目录、按标签维度（场景/季节/天气/设施/人物）多选过滤',
          '试匹配支持「图片 ID 白名单」强约束模式：粘贴或选定一组 image_id，只在这些图里召回评分',
          '匹配 API 新增 filters.prompt_ids / parent_ids / image_ids 三个字段（OpenAPI schema 已同步）',
          '默认策略加「季节加成」可视化滑块，后端 match_seasonal_boost_strength 从 0-0.3 可调',
        ],
      },
      {
        kind: 'improved',
        items: [
          '设置→匹配策略 改为指引页，三个一键跳转入口直达匹配实验室对应 Tab',
          '匹配实验室 Tab 顺序调整：试匹配 → 默认策略 → 匹配分析 → 同义词，符合"试-定-看-补"工作流',
        ],
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-05-07',
    highlights: '匹配质量与多样性大幅提升；新增应用内更新日志',
    sections: [
      {
        kind: 'added',
        items: [
          '新增「应用内更新日志」：每次升级首次启动会弹出本次更新内容；设置→关于可随时查看历史',
          '匹配 API 新增 exclude_ids（已展示图排除）、unique_per_source（同源原图最多 1 张）、fallback_url（缩略图失败兜底）三个参数',
          '新增 cdn 健康扫描脚本 apps/sidecar/scripts/check_cdn_health.py，可定期发现失效链接',
        ],
      },
      {
        kind: 'improved',
        items: [
          '匹配召回数翻倍至 400，候选池更大，刷新看到更多新图',
          'balanced 策略权重重平衡：质量 0.05 / 业务 0.02 / 多样性 0.13，缓解「永远那十几张图」的同质化',
          '同一原图的多个 AI 风格化版本默认只保留 1 张，结果丰富度提升',
          'query expansion 缓存改为 1 小时 TTL，同篇文案不再永远走同套扩展词',
        ],
      },
    ],
  },
]

/** 取最新版本的 release entry。约定：当前 app 版本 == RELEASES[0].version */
export function latestRelease(): ReleaseEntry | undefined {
  return RELEASES[0]
}

/** 给定「上次看过的版本」，返回升级后还没看过的所有 release（按从新到旧顺序） */
export function releasesSince(lastSeenVersion: string | null | undefined): ReleaseEntry[] {
  if (!lastSeenVersion) return RELEASES
  const idx = RELEASES.findIndex((r) => r.version === lastSeenVersion)
  if (idx < 0) return RELEASES   // 上次记录的版本不在列表里 — 安全起见展示全部
  return RELEASES.slice(0, idx)  // 比 lastSeen 更新的所有版本
}
