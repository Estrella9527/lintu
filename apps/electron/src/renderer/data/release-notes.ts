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
    version: '0.3.7',
    date: '2026-07-21',
    highlights: '修复真实批量打标被 60 秒超时中断，降低并发并完善 Windows 运行日志',
    sections: [
      {
        kind: 'improved',
        items: [
          '**真实打标稳定性**:模型响应等待时间从 60 秒提升到 180 秒,适配完整标签提示词和批量图片在上游排队的实际耗时',
          '**安全并发**:默认并发与单批数量降为 6,避免官方视觉模型在高并发下排队、限流或超时',
          '**首图预热**:批量任务先用一张真实图片验证首选模型;遇到无权限会先切换备用模型,再展开后续并发请求',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**批量打标失败**:修复连接测试成功但真实任务因 60 秒读超时被误判失败的问题',
          '**错误信息缺失**:超时错误现在明确显示服务商、模型、等待时间和异常类型',
          '**Windows 日志**:sidecar 运行日志会滚动保存在用户数据目录,便于定位线上客户端的真实模型错误',
        ],
      },
    ],
  },
  {
    version: '0.3.6',
    date: '2026-07-21',
    highlights: '修复模型测试成功但实际调用失败，并校准线上时间线与令牌使用链路',
    sections: [
      {
        kind: 'improved',
        items: [
          '**模型真实测试**:连接测试现在会使用当前配置的模型和令牌发起一次真实图片调用,测试成功即代表打标链路可用',
          '**自动服务降级**:主模型遇到无权限、模型不可用等错误时立即切换到可用服务商,避免整批图片反复打标失败',
          '**错误反馈优化**:没有可用模型时保留各服务商的真实失败原因,便于快速判断令牌、模型名称或渠道权限问题',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**令牌使用修复**:模型测试与实际打标统一按服务商名称读取同一份配置;重命名服务商时也不会把已保存令牌误写成掩码',
          '**模型选择修复**:实际打标会使用设置中指定的通用模型,并过滤不支持图片理解的生成/向量模型',
          '**线上时间线修复**:任务、批次和操作记录统一返回带 UTC 标记的时间,Windows 客户端会正确显示本地北京时间',
        ],
      },
    ],
  },
  {
    version: '0.3.5',
    date: '2026-07-21',
    highlights: '修复 AI 打标任务“未打标却显示完成”，失败原因与失败数量现在清晰可见',
    sections: [
      {
        kind: 'improved',
        items: [
          '**打标任务反馈**:任务进度现在统计所有已尝试图片并显示失败数量;模型/API 错误会直接出现在任务卡片,可一键重试',
          '**项目任务隔离**:流水线打标页只显示当前项目的任务,不再误显示其他项目的完成记录',
          '**历史状态修复**:升级时自动把旧版本遗留的“未处理完却已完成”打标任务纠正为失败,避免继续误判',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**打标假完成**:逐图模型调用失败不再被静默吞掉;只要存在失败,整项任务进入失败态并保留首个真实错误',
          '**空任务假完成**:没有符合“质检通过 + 去重保留 + 待打标”条件的图片时给出明确提示,不再显示 0/0 已完成',
          '**重新打标保护**:新一轮 AI 打标失败时保留旧标签,不会先清空旧标签再留下空白图片',
          '**一键流水线错误传播**:打标失败会立即停止后续阶段,不再被当成临时轮询异常后等待到超时',
        ],
      },
    ],
  },
  {
    version: '0.3.4',
    date: '2026-07-11',
    highlights: '图片治理链路重构 — 导入≠上传,审核+打标齐才上云;新增文件夹/裁切;修"生成不了"',
    sections: [
      {
        kind: 'added',
        items: [
          '**资产库文件夹**:可新建/移动/重命名文件夹,把每批导入的照片归类,找图不再一锅端(参考 Eagle)',
          '**照片任意裁切**:资产库详情里框选要保留的区域直接裁切(覆盖原图),省去下载-裁切-重传',
          '**上传分发治理**:导入(拖入/扫描/生成)只进【本地资产库】,不再自动上云;想发布时选中图点「上传」→ 登记来源类型 → 进审核;**审核通过 + 必填标签齐,才上 OSS 交给 UGC**;每张图可追溯 来源/批次/上传人/审核人',
        ],
      },
      {
        kind: 'improved',
        items: [
          '**审核队列**:汇总所有来源(含手动上传),支持按上传批次整批通过/退回;标签没打齐的图会标「标签未齐」并提示,补齐后自动补传 OSS',
          '**编辑不再动云端**:裁切/压缩等编辑只改本地,不会偷偷覆盖 OSS 上的图',
          '**相机大图可生成**:超过 25MB 的原片,生成时自动降采样,不再直接失败',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**"生成不了"根因**:「模型分配」偶发被清空(进设置/切项目时)导致生成失败 — 已修,配置不再被冲空',
        ],
      },
    ],
  },
  {
    version: '0.3.3',
    date: '2026-06-10',
    highlights: '生成体验集中修复 — 比例生效/生成必达/文字更强,OSS 图库全面升级',
    sections: [
      {
        kind: 'added',
        items: [
          '**导出 SVG(矢量)**:画布右键 / 资产库详情一键把图转成矢量文件,缩放不糊;适合 logo、插画、海报元素',
          '**OSS 图库全面升级**:打开秒出结果(缓存+增量,不再每次长时间扫描);状态改为三类 — 已入库(本机)/ 云端已发布 / 未纳管;**其他电脑发布的图直接显示远端标签与状态,无需同步到本地**',
          '**OSS 文件管理**:可单张/批量删除仓内文件 — 未纳管直接删,已入库连记录一起删(本机+云端),云端发布的受保护;删除前弹窗列明影响',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**切换输出比例无效**:图生图此前不把所选比例传给模型,统一出成方图 — 现已生效;gpt-image 系列自动映射到其支持的横/竖/方档位,精确比例建议选 Seedream 模型',
          '**画布生成的图"显示不出来"**:生成期间切换项目/页面甚至重启,结果不再丢进历史 — 完成后自动放回发起它的画布(占位框原位);重启后画布上的"生成中"框会自动从历史接回结果',
          '**生成文字效果差**:「中文文字」操作默认改走文字渲染更强的 Seedream(即梦同源)模型,提示词同步强化笔画准确性;模型菜单中标注「文字强」便于手选',
        ],
      },
    ],
  },
  {
    version: '0.3.2',
    date: '2026-06-10',
    highlights: '多设备同步 — 其他电脑审核发布的图与标签,本机一键开关即可看到',
    sections: [
      {
        kind: 'added',
        items: [
          '**多设备同步开关**(设置 → 通用):打开后本机自动同步其他电脑上「已审核发布」的图片、标签和上下架状态;OSS 图库/资产库直接可见,可继续上架、参与匹配',
          '**跨端图片云端显示**:别的电脑发布的图,本机没有文件也能正常看(缩略图/原图自动走云端 CDN)',
          '协作手册:导入 → 打标 → 审核(=发布) → 上架 标准流程,见 docs/operations 多人协作文档',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '打标完成、上架/下架、加入资产库后,变更现在会自动同步到云端(此前只有审核动作才触发,导致其他电脑拿不到最新标签)',
          '审核/上架/入库状态纳入同步范围(此前跨端不流转)',
        ],
      },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-06-10',
    highlights: '用户反馈集中修复 — 原图保护、画布右键复制/保存、扩图与选图修复',
    sections: [
      {
        kind: 'added',
        items: [
          '**画布图片右键菜单**:右键画布上任意图片 → 复制图片(外部应用可直接粘贴)/ 保存原图(系统保存框)/ 加入资产库',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '**原图保护(重要)**:批量压缩不再覆盖源文件 — 压缩版写到独立目录仅用于云端分发,本地原图永不改动;此前被压缩替换过的原图已全部自动还原(.orig 备份恢复)',
          '**任意扩图点了没反应**:扩图的底部「生成/取消」操作条被图文输入框遮挡 — 进入扩图/局部重绘时输入框自动让位,操作条完整可点',
          '**局部重绘尺寸**:生成结果默认按原图宽高输出,不再退到模型默认尺寸(如 2048×2048)',
          '**从资产库选择点不了**:画布选图弹窗现在显示项目内全部图片(含画布草稿),并修复重复打开时选择状态不重置的问题',
          '资产库左侧文件夹数字与网格实时同步(上传/删除后立即刷新,统计口径与列表一致)',
          '双指滚动画布经过 AI 操作工具栏时不再中断(滚轮事件透传给画布)',
        ],
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-06-05',
    highlights: 'AI 工坊重做 — 创作画布(白板)+ 批量策略 双模式,「打样 → 固化 → 量产」一条线',
    sections: [
      {
        kind: 'added',
        items: [
          '**AI 工坊「创作画布」模式**:基于 react-konva 的白板,拖入/粘贴/资产库选图,真实分辨率渲染,滚轮以光标为中心缩放,空格 + 拖拽平移,⌘Z / ⌘⇧Z 撤销/重做,8 手柄缩放,自动 fit 视图',
          '**上下文 AI 操作栏(ContextBar)**:选中图后下方浮出,左侧 Ask AI 渐变主入口 + 一排操作按钮(任意扩图 / 抠图 / 超分 / 中文文字),空间不足自动翻转到上方',
          '**Ask AI 自然语言改图**:浮层输入「把天空换成晚霞」「去掉游客」等指令,生成候选 → 选一张替换原对象或新增到画布',
          '**任意尺寸扩图**:对话框输入目标 W×H 或选预设比例(1:1 / 16:9 / 3:4 / 21:9 等),原图区域像素保真,仅新增区域生成(真 8 手柄拖拽留 v0.4)',
          '**底部 Prompt 栏**:文生图 / 图生图入口切换,模型 / 比例 / 速度(草稿 ↔ 精修)/ 数量 / 风格档案 一栏配齐;⌘Enter 一键生成',
          '**候选变体网格**:一次生成 N 张,带 草稿/精修 + 尺寸 + cost 标识,hover 显示「替换原图」「新增到画布」两个动作',
          '**右面板属性页**:当前对象元信息(尺寸 / 位置)+ 删除 + 生成参数快照 + 页脚「存为策略」「加入资产库」',
          '**存为策略 → 一键转批量**:画布上的探索一键固化为 Strategy(带「来自画布 📐」provenance + canvas_snapshot 完整快照),批量策略 mode 立即可选',
          '**回画布微调**:批量策略 mode 里 hover「📐」策略 → 出现「回画布」按钮 → 切回创作画布并预填该策略的所有参数',
          '**风格档案 StyleArchive**:设置 → 风格档案 Tab 新增 CRUD,挑一组参考图存为档案(如「晨曦丁达尔」);画布 Prompt 栏右下拉应用,保证跨图视觉一致',
          '**资产库 / SeedSelector 加粘贴拖拽** ✨ 早期工作:整页接拖入,Ctrl+V 粘贴截图,SeedSelector 拖入图自动追加到种子选区',
        ],
      },
      {
        kind: 'improved',
        items: [
          'AI 工坊页头部改为 ModeTabs(创作画布 / 批量策略),同一时刻仅展示一个模式;v0.2 时期硬编码的 7 个内置 strategy tab 入口删除(策略本身仍在数据库,批量策略 mode 里继续可用)',
          '后端新增 `POST /api/generate` 统一图像生成端点,9 个 type(text2img/img2img/outpaint/inpaint/matting/eraser/upscale/text-zh/edit)全部走单一端点;Phase 1 内全部路由到现有 OpenAICompatProvider 的 image2 模型(gpt-image-2 / seedream-2 等),Agent 阶段再做模型 routing',
          '所有生成产物自动落 ImageRecord + 触发 OSS 同步,无需手动「加入资产库」',
          '`OpenAICompatProvider` 加 `generate_text2img` 方法,/v1/images/generations 支持纯文生图(原来只有 /v1/images/edits 图生图)',
          'Strategy 表扩展:加 provenance / canvas_snapshot / style_archive_id / speed / count_per_image 五个字段,向后兼容(老调用方不传也工作)',
        ],
      },
      {
        kind: 'fixed',
        items: [
          'apiFetchRaw 对 FormData / Blob / ArrayBuffer body 不再强塞 application/json — 让浏览器自己加 multipart boundary,修上传 422 missing-field 错误',
          'OrgGeneralTab 设置页 canEdit 在 useEffect 之前未声明导致 TDZ 错误(整页白屏)',
          '资产库 / 工坊上传文件按钮在 Electron 部分上下文 .click() 静默失败:把 `<input hidden>` 换成 sr-only 定位,所有上传按钮可靠触发',
        ],
      },
    ],
  },
  {
    version: '0.2.10',
    date: '2026-06-04',
    highlights: 'OSS 刷新按钮卡死体验修复 — 探测时显示 loading + 失败弹 toast',
    sections: [
      {
        kind: 'fixed',
        items: [
          '分发中心 → OSS 同步「刷新(含实时探测)」按钮看似无响应:bucket 大时后端 list 整个 i/ 前缀要几秒,按钮原来没 loading 也没 try/catch — 点了像没反应、失败也吞掉。现在改为按钮禁用 + Loader2 旋转图标 + HTTP / 异常都弹 toast',
        ],
      },
    ],
  },
  {
    version: '0.2.9',
    date: '2026-05-26',
    highlights: 'Windows 自动更新修复:证书指纹固定 + 反版本回滚保护',
    sections: [
      {
        kind: 'fixed',
        items: [
          'Windows 自动更新报错 "New version is not signed by the application owner / certificate chain terminated in untrusted root":覆盖 electron-updater 的链校验,改用 SHA-256 证书指纹完全匹配(指纹烤入 main 进程,与签发证书一一锁定);链信任问题彻底消除,publisher 名义伪造也防住',
        ],
      },
      {
        kind: 'improved',
        items: [
          '更新流程加反版本回滚保护:autoDownload 改为手动触发,update-available 时先比较 semver,远端版本 ≤ 当前版本直接拒绝下载,防止 latest.yml 被替换为老版本(即使老版本签名合法)的回滚攻击',
        ],
      },
    ],
  },
  {
    version: '0.2.8',
    date: '2026-05-26',
    highlights: '批量压缩 + OSS 对账 + 项目隔离 — 17 天本地深度调试一次性合入',
    sections: [
      {
        kind: 'added',
        items: [
          '资产库 → 批量操作 → **批量压缩(强力 · JPEG q80 + 2400px)**:节省 ~68% 存储+流量(2.8M → 0.9M),原地覆盖 + `.orig` 备份(可恢复),压缩成功自动入 OSS 上传队列(force=true 覆盖 CDN 旧图);任务内 4 并发 + scheduler 间 2 并发,SQLite 写锁加 retry',
          '分发中心 → OSS 同步 Tab 大改:加「OSS 实际」实时探测指标(后端 cache 持久化到 config.json,自动 poll 只读 cache 不每次 list OSS) + 自动检测「库 vs OSS 不一致」并提示',
          'OSS 「对账库 vs OSS」按钮:实时 list OSS 真实对象 → 把库里标记同步但 OSS 没有的「幽灵 cdn_path」清空 → 自动入 cloud sync 队列推到云端,解决「UGC 拿到 image URL 但 OSS 上无对象 404」的关键问题',
          'OSS 「强制重推全量到云端」(高级菜单):本地库已对齐但云端 sidecar 没收到时一次性 sync 所有 image',
          'OSS 「软重置」+ 「全清」操作(高级菜单,双重 confirm):软 = 只清本地 cdn_path + 删任务队列(OSS 对象保留);全清 = 软重置 + 真删 OSS bucket 上 `i/` 前缀全部对象;clear-remote 端点带友好错误提示(识别 AccessDenied → 指引加 RAM 权限)',
          '资产库选区「软重置 OSS 状态」(BatchActionBar 菜单):支持「先重传一部分图 → 再软重置剩下的」工作流',
        ],
      },
      {
        kind: 'improved',
        items: [
          '**项目隔离 P0-1**:任务中心加 activeProjectId 监听,切项目任务列表跟着变(原来共用一套显示所有项目任务)',
          '**项目隔离 P0-2**:匹配策略按项目独立存(`match_per_project_<pid>` 单顶层 key),每项目独立 strategy/diversity/randomness/cooldown/seasonal_boost/filters/prompt_ids;后端 hydrate 项目级优先 → 全局 fallback → hardcoded,UGC 调云端时 scope.primary_project_id 决定走哪套',
          '**项目隔离 P1-6**:Settings 分组改为「组织 / 当前项目 / 全局共享(所有项目共用) / 运维 / 应用」+ 鼠标 hover 分组标题显示作用范围 tooltip;OSS 连接从「当前项目」移到「全局共享」(更准确)',
          'OSS 同步 Tab 按钮区重构:常用 3 个按钮(回填 / 对账 / 重试失败)平铺 + 危险操作折叠到右侧「高级」dropdown(强制重推到云端 / 软重置 / 全清),降视觉噪音',
          '`Stat` 卡片加 `sub2` 双行显示,OSS 实际数 / 探测时间不再换行错乱',
          'enqueue_image_sync 加 `force=True` 参数(删历史 done/failed jobs 再 enqueue),修 OSS 重传一直被「已存在」跳过的 bug',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '多 compress task 并发时 SQLite locked 导致 task 整体 fail:加 `_safe_commit` retry(指数退避 5 次最多 ~5s);progress_cb 写失败也只 warn,task 继续跑;batch enqueue OSS 也 retry',
          'compress skipped 的图(`.orig` 已存在)不入 OSS 队列 → 首次 enqueue 失败后再跑没补传:skipped 也 enqueue(force=True 兜底,enqueue 内部会判断 done jobs 跳过避免重复)',
          'OSS clear-remote 错误信息晦涩(阿里云 "does not belong to you"):端点识别 AccessDenied 后给具体修复指引(挂 AliyunOSSFullAccess 系统策略)',
          'OssSyncTab 「OSS 实际」一直显示 `—` / 数字闪烁:后端 cache 持久化到 config.json,默认请求读 cache 永远有值,只有用户主动点刷新才真去探测',
          'BatchActionBar 强制重新同步 OSS 半失效:之前只清 cdn_path 但 done jobs 留着导致 enqueue 跳过,改为 cdn_path 清空 + 删 done jobs 双管齐下',
        ],
      },
      {
        kind: 'fixed',
        items: [
          '【安全】仓库从 private 转 public 完整清理:真实基础设施 IP / 生产域名 / 客户 OSS bucket 名 / 项目 UUID / 客户景区名全部替换为占位符;`git filter-repo` 重写全部 74 commits + 4 tags,grep history 全敏感模式 0 命中',
          '【安全】pre-commit hook + .gitleaks 配置防真值再次入库:常见模式(阿里云 LTAI AK / AWS / GitHub PAT / 私钥 / OpenAI sk-)默认拦截;仓库特有黑名单本地维护(不入 git 避免二次泄露)',
          '【安全】docs/internal/ 目录已 .gitignore:用作真值映射、OSS 配置导出等敏感文件本地存储',
        ],
      },
    ],
  },
  {
    version: '0.2.6',
    date: '2026-05-09',
    highlights: '匹配实验室崩溃修复 + 收紧 user 版鉴权 BYPASS',
    sections: [
      {
        kind: 'fixed',
        items: [
          '匹配实验室「匹配策略」Tab 进去就崩（"d.filter is not a function"）：CandidateFilters 用 raw fetch 调 /api/prompts/with-output-counts 没带 Bearer token，401 返回 {detail:...} 不是数组，下游 .filter 报 TypeError。修：改 apiFetchRaw 自动注入 token + Array.isArray 兜底',
          '/api/sms/status 端点必 500：v0.2.5 重写 sms_aliyun.py 时删了 _read_config_value 函数，但 sms.py router 还在调它。前端 SmsConnectTab 已删，这俩端点（status + test）属死代码 — 整个 router 删除',
        ],
      },
      {
        kind: 'improved',
        items: [
          '安全收紧：user 版打包物理屏蔽 LINTU_AUTH_BYPASS env — 即使客户机自己 export LINTU_AUTH_BYPASS=1 也拒绝跳过登录拿 root，跟 cloud sync env 同级别保护。dev 仍可用 BYPASS 调试，ops 自动派 root 不变',
        ],
      },
    ],
  },
  {
    version: '0.2.5',
    date: '2026-05-08',
    highlights: '修 Windows 客户机收不到验证码 — 烤入凭据没真正进 PyInstaller bundle',
    sections: [
      {
        kind: 'fixed',
        items: [
          'Windows v0.2.4 验证码发不出：collect_all() 在 Windows 漏收 alibabacloud_dysmsapi20170525 等子模块，sidecar.exe 运行时 ImportError 静默降级。修：sms_aliyun.py 改顶层 import（PyInstaller 静态分析强制覆盖）+ sidecar.spec 显式 collect_submodules 兜底 + sidecar 启动期 preflight 把 SDK / 凭据状态打到日志',
          '错误信息更友好：之前 user 版 SDK 加载失败提示「短信 SDK 未打包到客户端」，但客户拿不到原始 ImportError 反馈无门。现在错误 message 附带 ImportError 类型 + 详情，截图就能定位',
        ],
      },
      {
        kind: 'improved',
        items: [
          '移除 设置 → 短信服务 Tab：阿里云 SMS 凭据是发布方资产（龙蟾科技作为运营方），不该作为客户端配置项暴露。Phase 2 如真有客户自带凭据需求，会以「自带短信通道」独立功能形态做',
          'sms_aliyun.py 不再读 config.json：v0.2.2 引入的 config.json 兜底路径已无意义（user 版烤入凭据已可覆盖全部场景，dev / ops 走 env），删掉减少凭据来源不确定性',
        ],
      },
    ],
  },
  {
    version: '0.2.4',
    date: '2026-05-09',
    highlights: '客户机零配置发短信 — SMS 凭据由发布方烤入打包，装好即可登录',
    sections: [
      {
        kind: 'fixed',
        items: [
          '客户机短信凭据需手动配的体验问题：阿里云 SMS 凭据本质是龙蟾科技作为运营方的资产，不应该让每个客户机器单独配。现在 user 版打包通过 GitHub Secrets 在 CI 阶段自动烤入凭据，客户开箱即用',
          'main 进程启动 sidecar 时把烤入凭据通过 env 转发，凭据查找优先级：shell env > config.json > main.cjs 烤入值（保留 dev / ops / 客户自定义覆盖空间）',
        ],
      },
      {
        kind: 'added',
        items: [
          '设置 → 短信服务：新增「凭据来源」状态指示。烤入凭据生效时显示「已由发布方预配置（开箱即用，无需填写）」，UI 默认折叠不显示填表入口；只有需要覆盖时才展开',
          'GET /api/sms/status 返回 source 字段：env / config / mixed / null，让前端能区分凭据来源',
        ],
      },
      {
        kind: 'improved',
        items: [
          'CI build-installers workflow 改用 build-main.mjs 集中管理 esbuild --define 注入逻辑（之前 main.cjs 是直接 npx esbuild 跑的，没有注入入口）',
          'dev / ops 版打包不烤入 SMS 凭据：build-main.mjs 在 flavor !== "user" 时忽略 BAKED_SMS_* env，避免开发者本地构建时把 secret 嵌进二进制',
        ],
      },
    ],
  },
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
