# 阿里云短信服务接入指南（手机号登录）

> 灵图用户系统 Phase 1 的唯一登录通道是**手机号验证码**。
> 这份文档手把手把阿里云短信开起来，灵图就能给真实手机发验证码。
>
> **现状（未配置）**：sidecar 收到 `/api/auth/sms/send` 请求 → 验证码不发短信，**直接 print 到 sidecar 日志**。
> 开发期 / 阿里云审核期可以用，但**正式发给客户前必须接通**，否则任何能看到日志的人都能截获验证码。

---

## 全流程一览

```
开通服务 → 申请签名 → 申请模板 → 创建 RAM 子账号 → 配 5 个 env → 重启 sidecar → 收码
  5 min    1-2 工作日   2 小时       5 min            5 min          1 min
```

**一次性投入**：约 1.5 小时人力 + 1-2 工作日等审核。
**后续费用**：国内验证码 0.045 元 / 条，月用量 < 1000 条 ≈ 50 元。

---

## 准备清单

申请前先把这 4 样东西放在手边：

- [ ] **阿里云账号**（手机号 + 实名认证：企业认证用龙蟾科技营业执照）
- [ ] **龙蟾科技营业执照彩色扫描件**（PDF 或 JPG，A4 大小，≤5MB）
- [ ] **充值额度** ≥ 10 元（阿里云短信不开通免费额度，需要预充值才能审核签名）
- [ ] **测试手机号 1 个**（你自己的，签名审核通过后第一个测试目标）

> 没认证企业主体？先去「阿里云控制台 → 实名认证」走一遍企业实名（要营业执照 + 法人手机号验证），约 1 小时。

---

## 一、开通短信服务

1. 浏览器打开 <https://dysms.console.aliyun.com>
2. 首次进入会让「立即开通」→ 点开通（**免费开通，按量计费**）
3. 跳转后看到「**国内消息**」「**国际/港澳台消息**」两个 Tab — 我们只用国内
4. 顶部右上角检查地域 — 默认 **「华东1（杭州）」** 即可，灵图 sidecar 也用 cn-hangzhou

✅ 通过判定：左侧菜单出现「签名管理 / 模板管理 / 用量统计 ...」

---

## 二、申请短信签名

签名是短信开头方括号里的品牌名 — 用户收到的短信长这样：

> **【灵图】**您的灵图登录验证码是 482917，5 分钟内有效，请勿告诉他人。

### 2.1 提交申请

1. 左侧菜单「**国内消息 → 签名管理**」
2. 点「**添加签名**」
3. 按下表填写：

| 字段 | 填什么 |
|---|---|
| 签名 | `灵图`（2-12 字；与产品名一致最容易过审） |
| 签名来源 | **「企事业单位的全称或简称」** |
| 适用场景 | **勾「验证码」**（重要：验证码场景审核更快、价格更低，禁止行销使用） |
| 签名用途说明 | `龙蟾科技旗下景区图片 AI 生产平台「灵图」的桌面端 + Web 端用户登录手机验证码下发` |
| 资质证明文件 | **上传龙蟾科技营业执照**（彩色扫描件 / PDF；签名管理→新增签名页面有资质上传入口） |
| 是否在工信部备案 | 看龙蟾科技有没有 ICP 备案过`example.com` — 没有就选「否」也能过 |

4. 点「**确定**」提交，状态变「**审核中**」

### 2.2 审核

- **时长**：1-2 个工作日（周末顺延）
- **结果通知**：阿里云控制台站内信 + 注册手机短信
- **常见拒因**：
  - 签名跟主体名不沾边（如填「测试」「abc」）→ 必须是产品 / 公司简称
  - 营业执照模糊、过期、缺页
  - 「签名用途说明」太简略（如只写「登录用」）

### 2.3 审核通过后

- 签名状态变「**审核通过**」
- 签名管理列表里能看到你的「灵图」一行 — **记住这两个字一字不差**，后面配 env 要用

---

## 三、申请短信模板

签名通过后才能配模板。模板是短信正文。

### 3.1 提交申请

1. 左侧菜单「**国内消息 → 模板管理**」
2. 点「**添加模板**」
3. 按下表填写：

| 字段 | 填什么 |
|---|---|
| 模板类型 | **「验证码」** |
| 模板名称 | `灵图登录验证码` |
| 模板内容 | `您的灵图登录验证码是 ${code}，5 分钟内有效，请勿告诉他人。` |
| 模板说明 | `用户在桌面端 / Web 端登录时下发 6 位数字验证码，5 分钟过期；同手机号 60 秒冷却一次` |

4. 点「**确定**」提交

### 3.2 模板内容硬性规则

阿里云模板审核很严，**触犯任一条直接驳回**：

- ✅ 必须含 `${code}` 占位符（参数名固定就叫 `code`，不能改成 `verify_code` 之类）
- ✅ 必须明示用途（如「登录」「注册」「验证」）
- ❌ **不能含营销词**：「优惠 / 促销 / 活动 / 抢购 / 限时 / 折扣」等一律拒
- ❌ 不能加链接、表情、客服电话
- ❌ 不能含「群发」「批量」类描述

> **推荐文案**直接抄上面那条，已经反复验证能过审。

### 3.3 审核

- **时长**：通常 **2 小时内**（验证码模板审核快）
- **结果**：站内信通知
- **审核通过 → 拿到 TemplateCode**：形如 `SMS_490815xxx`，**记下来**，配 env 要用

---

## 四、创建 RAM 子账号 + AccessKey

**安全实践**：不要用阿里云主账号 AK 直接调短信（主账号 AK 权限大、泄漏代价高）。建一个**只能调短信**的子账号。

### 4.1 创建子账号

1. 阿里云控制台顶部搜「**RAM 访问控制**」点进去
2. 左侧「**身份管理 → 用户**」→「**创建用户**」
3. 填表：

| 字段 | 填什么 |
|---|---|
| 登录名 | `lintu-sms` |
| 显示名称 | `灵图短信服务` |
| 访问方式 | **只勾「OpenAPI 调用访问」** — 不要勾「控制台访问」（子账号不需要登 web） |

4. 点「**确定**」→ 弹窗显示 **AccessKey ID + AccessKey Secret**
5. **立刻复制保存到密码管理器**（如 1Password / Bitwarden）— **Secret 只显示一次，关闭后阿里云不再展示**

### 4.2 给子账号授权

新建的子账号默认零权限，必须挂上短信权限策略：

1. 回到「身份管理 → 用户」列表，点 `lintu-sms` 进详情页
2. 「**权限管理**」Tab →「**新增授权**」
3. 「**系统策略**」搜 `AliyunDysmsFullAccess` → 勾选 → 「**确定**」

> `AliyunDysmsFullAccess` = 短信发送 + 模板 / 签名管理。如果想再收紧，可以用
> `AliyunDysmsReadOnlyAccess` 加上自定义只允许 `SendSms` 的策略，但 Phase 1 不必。

### 4.3 验证 AccessKey 可用

```bash
# 装阿里云 CLI（一次性，5 min）
brew install aliyun-cli
# 配子账号
aliyun configure --profile lintu-sms
# 输入 AccessKey ID / Secret / 区域 cn-hangzhou / 输出格式 json
# 然后试调一下查询签名列表（不会真发短信，只验证 AK 通）
aliyun dysmsapi QuerySmsSignList --PageIndex 1 --PageSize 10 --profile lintu-sms
# 应该返回 JSON 含「灵图」签名一行
```

如果返回 401 / 403：检查 AccessKey 是否粘错、`AliyunDysmsFullAccess` 是否真的挂上了。

---

## 五、配置到灵图 sidecar

### 5.1 5 个环境变量

把以下 5 行加到 sidecar 启动环境（macOS 推荐 `~/.zshrc`）：

```bash
# 阿里云短信 - 灵图手机号登录
export LINTU_SMS_PROVIDER=aliyun
export LINTU_SMS_ACCESS_KEY=LTAI5tXXXXXXXXXX            # 子账号 AccessKey ID
export LINTU_SMS_ACCESS_SECRET=YYYYYYYYYYYYYYYYYY       # 子账号 Secret
export LINTU_SMS_SIGN_NAME=灵图                          # 跟阿里云审核通过的签名一字不差
export LINTU_SMS_TEMPLATE_CODE=SMS_490815xxx             # 模板审核通过后给的编号
# 可选：默认 cn-hangzhou，国际短信换 ap-southeast-1
# export LINTU_SMS_REGION=cn-hangzhou
```

### 5.2 让 env 生效

```bash
source ~/.zshrc                         # 当前 shell 立即生效
# 重启 sidecar：Cmd+Q 退出 Electron，再 `npx electron .`
# 或者只重启 sidecar 子进程：touch apps/sidecar/sidecar/main.py（dev 模式有 reload）
```

### 5.3 验证 env 进了 sidecar

```bash
# sidecar 进程必须能看到这几个环境变量
ps eww $(pgrep -f "uvicorn.*sidecar") | tr ' ' '\n' | grep LINTU_SMS_
# 期望看到 5 行 LINTU_SMS_*
```

如果什么都没输出：你 export 的 shell 跟启动 Electron 的 shell 不是同一个。最稳的做法是在**同一个终端**里 `source ~/.zshrc && npx electron .`。

---

## 六、端到端测试

### 6.1 命令行直接发

```bash
# 给自己手机号发一条
curl -X POST http://127.0.0.1:7879/api/auth/sms/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"你的手机号"}'

# 期望响应：{"ok":true,"ttl_sec":300}
# 期望手机：1 分钟内收到「【灵图】您的灵图登录验证码是 xxxxxx ...」
```

如果返回 `{"detail":{"code":"sms_send_failed", ...}}`：看 detail.message 里的阿里云错误码，常见：
- `isv.SMS_SIGNATURE_ILLEGAL` → 签名名字写错了，跟控制台对一下
- `isv.MOBILE_NUMBER_ILLEGAL` → 手机号格式错（必须 11 位 1 开头）
- `isv.AMOUNT_NOT_ENOUGH` → 阿里云账户余额不足（去充值 10 元）
- `isv.OUT_OF_SERVICE` → 模板被冻结（模板里出现违禁词）

### 6.2 桌面端走完整登录流

1. 启动 Electron：`cd apps/electron && npx electron .`
2. 弹出登录页 → 输入手机号 → 点「获取验证码」
3. 手机收码 → 输入 6 位数 → 点「登录 / 注册」
4. 进入 AppShell — 第一次登录的新用户**还没被加进任何项目**，左下角徽章会显示「未加入项目」
5. 用 root 账号 / CLI 把新用户加成员：

```bash
cd apps/sidecar
uv run python -m sidecar.cli.admin add-member \
  --phone 13900001234 --project-id <项目ID> --display-name "张三"
```

6. 让对方刷新或重新登录 → 看到分配的项目数据

---

## 七、监控 + 计费

### 7.1 用量看板

阿里云控制台「**短信服务 → 国内消息 → 数据统计**」：
- 每日发送条数 / 成功率
- 失败原因 TOP 5（一般是手机号无效 / 黑名单）

### 7.2 配置告警（防被刷）

如果 sidecar 暴露在公网（不是 Electron 桌面专用），任何人都能调 `/api/auth/sms/send` 烧你的钱。**必装阈值告警**：

1. 阿里云控制台「**短信服务 → 系统设置 → 用量阈值告警**」
2. 设阈值：**单日发送 ≥ 500 条**（按业务规模调） → 触发邮件 + 短信告警
3. 告警接收人填运营 / 你自己

### 7.3 计费

- **国内验证码**：0.045 元 / 条
- **国际验证码**：按目标国 0.20-0.50 元 / 条不等
- 没有月租 / 套餐费，纯按量
- 阿里云控制台「费用 → 现金券」常有新人 100 元短信代金券，记得领

---

## 八、回退预案

### 8.1 阿里云不可用 / 余额耗尽

sidecar 行为：调 `/api/auth/sms/send` 返回 502。**用户登不进**。

应急方案：
- 临时清空 `LINTU_SMS_ACCESS_KEY` env 重启 sidecar → 自动降级到 stdout 模式
- 让用户 / 客服报手机号，运维去 sidecar 日志找验证码（搜 `[sms] DEV FALLBACK`）念给用户

> 这是**应急**用法，不要长期开。生产环境每个能看 sidecar 日志的人都能截获所有人的码。

### 8.2 签名 / 模板被封

阿里云有时会因「投诉数过多」临时冻结签名。处理：
1. 站内信会通知冻结原因
2. 申诉 → 一般 1-3 工作日恢复
3. 期间临时申请第二个签名顶上（如「灵图科技」），改 `LINTU_SMS_SIGN_NAME` 切换

---

## 九、上线 Checklist

正式发给真实客户前过一遍：

- [ ] 阿里云签名 `灵图` 审核通过
- [ ] 阿里云模板审核通过，TemplateCode 已记录
- [ ] RAM 子账号 `lintu-sms` 已建，AccessKey 存进密码管理器
- [ ] 5 个 `LINTU_SMS_*` env 已配进 sidecar 启动环境
- [ ] sidecar 重启后 `ps eww` 能看到 env
- [ ] 真实手机号端到端登录成功 1 次
- [ ] 「用量阈值告警」已配，单日 500 条触发邮件
- [ ] 阿里云余额 ≥ 50 元（避免节假日耗尽）
- [ ] 文档 `docs/operations/sms-aliyun-onboarding.md` 同步更新到当前实际值

---

## 附 · 环境变量速查表

| 变量 | 必需 | 示例 | 来源 |
|---|---|---|---|
| `LINTU_SMS_PROVIDER` | 是 | `aliyun` | 固定值 |
| `LINTU_SMS_ACCESS_KEY` | 是 | `LTAI5tXXXX...` | RAM 子账号创建时给 |
| `LINTU_SMS_ACCESS_SECRET` | 是 | `YYYY...` | 同上，只显示一次 |
| `LINTU_SMS_SIGN_NAME` | 是 | `灵图` | 控制台签名管理 |
| `LINTU_SMS_TEMPLATE_CODE` | 是 | `SMS_490815xxx` | 控制台模板管理 |
| `LINTU_SMS_REGION` | 否 | `cn-hangzhou` | 默认杭州，国际换 ap-southeast-1 |

任意一个没配 → sidecar 自动降级到 stdout 模式。

---

**END.** 有问题对照 §六 的错误码表先自查；阿里云控制台「**工单**」可以提技术支持，平均 4 小时回复。
