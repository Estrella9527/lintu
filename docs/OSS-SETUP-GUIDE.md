# 阿里云 OSS 配置教程（灵图 Lintu 接入）

适用版本：阿里云 OSS · 华东 1（杭州）或其他区域均可。

---

## 概览：你将完成 6 件事

1. 在阿里云为灵图建一个**专用 Bucket**（不和别的业务共用）
2. 设置 Bucket 的**访问权限**（公共读，最简单；或私有 + 签名 URL，最安全）
3. 配置 **CORS**（关键，否则前端浏览器拉不到图）
4. 在 **RAM 访问控制**新建子账号 + AccessKey（绝不用主账号 AK）
5. 给子账号授权**只能操作这个 Bucket**
6. 在灵图 → 分发中心 → OSS 同步**填 5 项配置 → 测试 → 回填**

完成后，Open API 返回的图片 URL 就直接走 OSS / CDN，外部 UGC 应用 < 200ms 拿到首图。

---

## 0. 准备

阿里云控制台已登录，能进入「对象存储 OSS」（你已经在了）。

> **强烈建议先建一个独立 bucket**，不要把灵图的图片和你现有的 `sando` bucket 混着放。理由：单独计费、独立权限、单独的 CDN/防盗链规则、删除时不会误伤别的业务。

---

## Part 1 · 新建专用 Bucket

### 1.1 进入创建页

控制台左侧 **Bucket 列表 → 创建 Bucket**（也可以从你截图右下角的「创建 Bucket」按钮直接进）。

### 1.2 关键选项填写

| 字段 | 推荐值 | 说明 |
|---|---|---|
| **Bucket 名称** | `lintu-prod`（或你想的名字） | **3-63 位小写字母/数字/短横线**；全阿里云全局唯一，建议加个后缀避免重名（例如 `lintu-yourcompany`） |
| **地域** | **华东 1（杭州）** | 就近选；和你现有 `sando` 一致即可 |
| **可用区** | 单可用区（默认） | 备份冗余够用，便宜 |
| **存储类型** | **标准存储** | 频繁读取必须；归档/低频读会限制 |
| **同城冗余存储** | 关闭 | 启用会贵一倍，500G 用不上 |
| **版本控制** | 关闭 | 我们的图入库后基本不改，开启会多花钱 |
| **读写权限** | **公共读** ⭐ | 最重要的选择，下一节详解 |
| **服务端加密** | 关闭（默认）即可 | OSS 自带的加密对我们透明 |
| **实名认证** | 跟随主账号 | 国内站默认要 |

> 💡 **「公共读」 vs 「私有」如何选？**
> - **公共读（推荐）**：任何人拿到 URL 都能直接打开看图，速度最快，体验最好，UGC 应用零配置。**唯一风险**是图片 URL 可被任意第三方爬。如果图片本身就是要让用户在公开应用里看，这个风险可以接受。
> - **私有 + 签名 URL**：每个 URL 带 token，过期自动失效（例如 1 小时）。安全但每次访问都要灵图后端发 token，UGC 应用集成更复杂。我在灵图 OSS 配置里留了「签名 URL 有效期」这一项，填 0 = 公共读，填 N 秒 = 私有签名。
> - **本教程默认你选「公共读」**，私有模式末尾有补充说明。

确认后点**确认**，bucket 就建好了。

---

## Part 2 · （可选）阻止公共访问的总开关

如果你刚选了**公共读**，要确认账号级的「阻止公共访问」是关闭的，否则 bucket 的公共读会被强制覆盖。

控制台左侧 **OSS → 阻止公共访问**（你截图左下能看到这个菜单）。

- 状态显示**「未阻止」** → 不用动
- 状态显示**「已阻止」** → 关闭它（或单独为这个 bucket 例外放行）

---

## Part 3 · 配置 CORS（关键步骤）

如果不配 CORS，浏览器（H5、小程序 webview、PC 网页）拉图会报跨域错误。**Server-to-server 调用不需要 CORS，但留着不影响。**

### 3.1 进入设置

进入 **Bucket lintu-prod → 数据安全 → 跨域设置**。

点**创建规则**。

### 3.2 填写规则（一条就够）

| 字段 | 值 |
|---|---|
| 规则名称 | `lintu-cors` |
| **来源** | `*`（最简单）<br/>**或**指定你的 UGC 应用域名，例如：<br/>`https://h5.example.com`<br/>`https://*.example.com` |
| **允许 Methods** | 勾选 **GET, HEAD, OPTIONS**（写场景不需要 PUT/POST/DELETE，OSS 写由灵图后端走） |
| **允许 Headers** | `*` |
| **暴露 Headers** | `Content-Length`, `ETag`, `Content-Type` |
| 缓存时间（秒） | `600` |
| **返回 Vary: Origin** | 勾选 |

> ⚠️ 来源用 `*` 是最简方式，但风险是任何域名都能在浏览器里直接拉你的图。生产环境**强烈建议**改为白名单（只填你 UGC 应用的域名）。

确定。

---

## Part 4 · 创建 RAM 子账号（关键安全步骤）

> 🔴 **绝对不要把主账号的 AccessKey 填进灵图**。主账号 AK 一旦泄露，整个阿里云账号都会失守（包括你的 ECS、其他 OSS、域名等）。
> 永远用 **RAM 子账号**，给它**最小权限**。

### 4.1 进入 RAM 控制台

阿里云搜索栏搜「**RAM 访问控制**」进入，或直接点头像 → **AccessKey 管理 → 推荐使用 RAM 子账号**。

### 4.2 创建用户

左侧 **身份管理 → 用户 → 创建用户**。

| 字段 | 值 |
|---|---|
| 登录名 | `lintu-oss-writer` |
| 显示名称 | 灵图 OSS 写入器 |
| **访问方式** | **勾选「使用永久 AccessKey 访问」** |
| 控制台访问 | **不勾**（这个账号不需要登网页） |

确认后**立刻**会显示一次 **AccessKey ID + AccessKey Secret**。

> 🚨 **AccessKey Secret 只显示一次**！立刻：
> 1. 点「下载 CSV 文件」保存到本地（我下面教你删掉）
> 2. 或手动复制 ID + Secret 到密码管理器（1Password / Bitwarden）
> 3. 关掉对话框前**确认你已经保存**

把这 2 个值记下来，等下要填到灵图：
```
AccessKey ID:     LTAI5tXXXXXXXXXXXXXXXXXX
AccessKey Secret: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## Part 5 · 给子账号授权（最小权限原则）

子账号默认没有任何权限，得显式授权。

### 5.1 进入授权页

RAM → **用户 → lintu-oss-writer → 权限管理 → 新增授权**。

### 5.2 推荐授权方式：**自定义策略 + 单 bucket 限制**

不要用 `AliyunOSSFullAccess`（那是全部 bucket 的权限）。建一个专属策略：

#### 5.2.1 创建策略

RAM → **权限策略 → 创建权限策略**。

| 字段 | 值 |
|---|---|
| 名称 | `LintuOSSWriter-lintu-prod` |
| 配置模式 | **脚本编辑** |
| 策略内容 | 见下方 JSON |

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:DeleteObject",
        "oss:GetObjectMeta",
        "oss:HeadObject",
        "oss:AbortMultipartUpload",
        "oss:ListMultipartUploads",
        "oss:ListParts",
        "oss:GetBucketInfo"
      ],
      "Resource": [
        "acs:oss:*:*:lintu-prod",
        "acs:oss:*:*:lintu-prod/*"
      ]
    }
  ]
}
```

> ⚠️ 把 JSON 里两处 `lintu-prod` 替换成**你刚才建的 bucket 实际名称**。

确认。

#### 5.2.2 把策略授给子账号

回 RAM → **用户 → lintu-oss-writer → 权限管理 → 新增授权**：

- 授权范围：**整个云账号**
- 选择权限策略：搜 `LintuOSSWriter-lintu-prod` → 选中
- 确认

> 💡 这个策略只允许操作 `lintu-prod` 这一个 bucket。即使 AK 泄露，攻击者也碰不到你别的 bucket。

---

## Part 6 · 收集 5 项配置

打开记事本写下：

```
1. Endpoint:           oss-cn-hangzhou.aliyuncs.com
2. Bucket:             lintu-prod   ← 你刚才建的
3. AccessKey ID:       LTAI5t...    ← Part 4 拿到
4. AccessKey Secret:   ...          ← Part 4 拿到
5. CDN 域名:           （暂时留空，Part 8 再加）
```

### Endpoint 怎么找？

控制台 → **Bucket lintu-prod → 概览**，找「访问域名」表格：
- **外网访问** 行 → **Endpoint**：`oss-cn-hangzhou.aliyuncs.com`（华东 1）
- 不要用「内网 Endpoint」（那是 ECS 内部用的，外部访问会失败）

---

## Part 7 · 在灵图填配置

启动灵图（你的 Electron 应用）→ 左侧 **分发中心 → OSS 同步** Tab。

### 7.1 填表单

| 字段 | 填什么 |
|---|---|
| 服务商 | **阿里云 OSS** |
| Endpoint | `oss-cn-hangzhou.aliyuncs.com` |
| Bucket | `lintu-prod` |
| Access Key ID | 粘贴 |
| Access Secret | 粘贴 |
| CDN 域名 | **暂时留空**（先用 OSS 直连验证；通了再配 CDN） |
| 签名 URL 有效期 | `0` |

点「**保存配置**」。

### 7.2 测试连接

点「**测试连接**」按钮。

- ✅ 显示绿色「**连接成功 · bucket=lintu-prod · 区域=oss-cn-hangzhou**」 → 配置 OK
- ❌ 显示红色错误 → 见末尾「常见错误」章节

### 7.3 一键回填全库

测试通过后，点「**一键回填全库**」按钮，确认弹窗。

后台 worker 会按每秒数张的速度把你现有的 **3465 张图片**全部推到 OSS：
- 上传顺序：原图 → 800px 缩略图 → 300px 缩略图
- 进度可在「同步状态」卡看到（每 5 秒刷新）
- 失败的会进入「失败」队列，显示失败按钮可重试

> 💡 **3465 张图按平均 2MB 估算约 7GB**，初次同步约 30-60 分钟（看带宽）。期间灵图可以正常用，worker 在后台跑。

### 7.4 验证一张图能从 OSS 读

回到「同步状态」卡，等「已同步」从 0 涨到几张。

打开浏览器，访问任意一张已同步图的 URL（比如 `https://lintu-prod.oss-cn-hangzhou.aliyuncs.com/i/{image_id}.jpg`，把 `{image_id}` 换成 lintu 数据库里任意一张已同步图的 id）。

- ✅ 浏览器直接显示图 → 链路通了
- ❌ XML 报错 `AccessDenied` → bucket 不是公共读，回 Part 1 改

---

## Part 8 · （可选）配 CDN 加速

OSS 直连已经能用，但有两个体验问题：
1. 跨地域访问慢（北京用户访问杭州 OSS 要 50-100ms）
2. 流量费按 OSS 外网走，比 CDN 贵

配 CDN 后，**CDN 边缘节点**（全国上千个）会把图缓存下来，全国用户访问 < 50ms，流量费便宜约 60%。

### 8.1 准备一个域名

需要一个**已经备案**的域名（在工信部备案过的），例如 `cdn.example.com` 这样的子域名。

> 没备案的域名只能解析到境外节点，国内 CDN 用不了。

### 8.2 创建 CDN 加速域名

阿里云搜「**CDN 加速服务**」 → **域名管理 → 添加域名**。

| 字段 | 值 |
|---|---|
| 加速域名 | `cdn.example.com`（你自己的） |
| 业务类型 | **图片小文件** |
| 加速区域 | 中国大陆 |
| 源站信息 | **OSS 域名**：选 `lintu-prod.oss-cn-hangzhou.aliyuncs.com` |
| 端口 | 80 |
| HTTPS 监听 | 强烈建议**开启**（用免费 Let's Encrypt 证书） |

提交后约 5-10 分钟生效。

### 8.3 把 CNAME 配到你的 DNS

CDN 创建后会给你一个 CNAME 值（形如 `cdn.example.com.w.kunlunsl.com`）。

去你的域名 DNS 控制台（阿里云 DNS / Cloudflare / DNSPod）添加：
- 类型：`CNAME`
- 名称：`cdn`（如果你用 cdn.example.com）
- 值：CDN 给的 CNAME

DNS 传播需要几分钟到 1 小时。

### 8.4 在灵图填 CDN 域名

回灵图 → OSS 同步 → CDN 域名填 `https://cdn.example.com` → 保存。

之后 Open API 返回的所有 URL 自动走 CDN。

---

## 常见错误排查

### ❌ 测试连接失败：`AccessDenied`
- 原因：RAM 子账号没绑对策略
- 解决：回 Part 5 重新授权，确认策略 JSON 里 `Resource` 的 bucket 名拼对了

### ❌ 测试连接失败：`InvalidAccessKeyId`
- 原因：AccessKey ID 拷错了，或者用了主账号 AK 但被禁用了
- 解决：确认 AK 来自你新建的 RAM 子账号，且子账号是「启用」状态

### ❌ 测试连接失败：`SignatureDoesNotMatch`
- 原因：AccessKey Secret 拷错，或者首尾有空格
- 解决：去 RAM → 用户 → lintu-oss-writer → AccessKey 管理 → **重新生成** AccessKey 后再填

### ❌ 浏览器访问图：`AccessDenied`
- 原因 1：Bucket 是私有的 → 改成公共读，或在灵图配置「签名 URL 有效期」填 3600
- 原因 2：账号级「阻止公共访问」是开的 → 关闭

### ❌ H5 应用拉图：CORS 跨域错误
- 原因：Part 3 没配 CORS
- 解决：照 Part 3 配，注意「来源」要包含你 H5 应用的实际域名

### ❌ 上传失败：`RequestTimeTooSkewed`
- 原因：你电脑的系统时间不准（OSS 要求与服务器时差 < 15 分钟）
- 解决：系统设置 → 日期与时间 → 自动同步

### ❌ 一键回填卡在「待上传」很久不动
- 原因：worker 没启动 / sidecar 没重启
- 解决：完全重启灵图（关掉再开），让 sidecar 重读配置

---

## 安全检查清单（上线前过一遍）

- [ ] 用的是 **RAM 子账号** AK，不是主账号
- [ ] RAM 策略只授权**你的 bucket**，不是 `AliyunOSSFullAccess`
- [ ] CORS 「来源」是**白名单**，不是 `*`（如果不能改成白名单，至少把方法限制在 GET/HEAD/OPTIONS）
- [ ] 关键 secret（AccessKey Secret、bucket 名）**只存在密码管理器**，不要进 git
- [ ] 主账号开了**两步验证**
- [ ] OSS 的「**Referer 防盗链**」配置上你的允许域名（防止图片被其他网站盗链刷你流量）
  - 入口：Bucket → 数据安全 → 防盗链
  - 「Referer 白名单」填你 H5/网站域名（如 `*.example.com`）
  - **空 Referer** 视情况：H5 一般要勾允许（手机里 referer 经常是空）

---

## 计费小提示（500GB 套餐）

| 项 | 你的 500GB 包包含 | 超出部分 |
|---|---|---|
| 存储容量 | 500GB | ¥0.12/GB/月 |
| 内网流量 | 不计费 | — |
| 外网流出流量 | **不在套餐里** | 约 ¥0.5/GB |
| 请求次数 | 200 万 PUT + 2000 万 GET（套餐通常含） | ¥0.01/万次 |

> 💡 灵图场景下：**外网流出**是主要成本（每次 UGC 用户看图就消耗）。配上 **CDN 后**，CDN 流量约 ¥0.24/GB（便宜一半），且 CDN 回源只算一次 OSS 出流量。500GB 容量的 bucket 配上 CDN，月流量费一般在 ¥100-300 内可控。

---

## 完成 ✅

到这一步，你已经：
- 建好了独立、安全、最小权限的 OSS
- 灵图能把所有图同步上去
- Open API 返回的 URL 自动走 CDN（如果配了）
- UGC 应用从全国任意位置都能 < 200ms 拿到首图

接下来灵图 S5.3（文图匹配）开发完成后，你就可以用一个 API Key + 一段文本，让外部应用拿到匹配好的图片 URL（直接来自 CDN）。

有任何步骤卡住，把控制台截图和错误信息发给我，我对应排查。
