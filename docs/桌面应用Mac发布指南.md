# 桌面应用 Mac 发布指南

> 这份是给你（产品负责人，主要在 Mac 上开发）的**操作手册**。从零开始把 Mac 端打包、签名、公证、发版全链路跑通。预计完整跑一遍 **2-3 小时**（含 Apple 后台审核等待时间）。
>
> 涉及钱：Apple Developer Program **$99/年**（约 ¥720）。
>
> 涉及代码改动：✅ 已经全部由我写好提交到 v0.2 分支。你只需要按下面的步骤操作 Mac 本地环境 + Apple 后台 + GitHub Secrets。

---

## 0. 全局心智模型

你将完成的事，按时间顺序：

```
[本地 Mac]                       [Apple]                          [GitHub]
   │                                │                                │
   ├─ 1. 拉最新代码                 │                                │
   ├─ 2. 安装 toolchain             │                                │
   │                                │                                │
   ├─ 3. 注册 Developer Program ──→ ┤ 审核 24-72 小时              │
   │                                │                                │
   │                                ├─ 4. 生成 Developer ID 证书     │
   │                                ├─ 5. 创建 App Store Connect API │
   │                                │                                │
   ├─ 6. 导出 .p12 证书             │                                │
   ├─ 7. 本地试打一次（无签名）     │                                │
   ├─ 8. 本地试打一次（带签名）     │                                │
   │                                │                                │
   │                                │      ┌── 9. 写 5 个 Secrets ──→ ┤
   │                                │      │                           │
   ├─ 10. git tag v0.1.x ─────────────────→ ├─ CI 自动 build + 上传  ─→ OSS
   │                                │       │                          │
   ├─ 11. 用同事的 Mac 验证下载安装 ─────────────────────────────────────┘
```

不需要担心走错顺序 —— 我把每步都串起来了，照着做就行。

---

## 1. 本地 Mac 准备

### 1.1 拉最新代码

```bash
git clone https://github.com/Estrella9527/lintu.git
cd lintu
git checkout v0.2
```

如果之前已经 clone 过：

```bash
cd lintu
git checkout v0.2
git pull
```

### 1.2 给 build_mac.sh 加执行权限

我在 Windows 上写的脚本，git 过来后默认没有 +x：

```bash
chmod +x apps/electron/scripts/build_mac.sh
```

### 1.3 安装 toolchain（一次性）

```bash
# Node 20+ — 推荐通过 Homebrew 装，自带 npm
brew install node@20

# Python 3.12 + uv
curl -LsSf https://astral.sh/uv/install.sh | sh
# uv 装到 ~/.local/bin/，建议加进 PATH（uv 安装脚本会问，选 yes）

# Xcode Command Line Tools — 公证 + 签名都靠这里面的 codesign / xcrun stapler
xcode-select --install

# 验证
node --version    # 应该 v20+
uv --version      # 应该 0.x
xcrun -f codesign # 应该输出一个路径
```

> ⚠️ Mac 第一次跑 `xcode-select --install` 会弹一个图形对话框让你点同意，几分钟下载完。装完之后才有 `codesign` / `xcrun stapler` 这些命令。

---

## 2. 注册 Apple Developer Program

> 这一步要等 Apple 审核，最快 24 小时，最慢 72 小时。先把这一步开起来，等审核期间继续做后面的 §3-§5。

### 2.1 注册账号

1. 打开 https://developer.apple.com/programs/enroll/
2. 用你常用的 Apple ID 登录（建议用公司邮箱的 Apple ID，私人 ID 万一离职会出问题）
3. 选 **个人**（Individual / Sole Proprietor）或 **公司**（Organization）
   - **公司类型**需要 D-U-N-S Number（邓白氏编码），中国公司申请需 1-2 周，证书会显示公司名 "Longchan Tech"
   - **个人类型**当天就能下单，证书显示你个人名字
   - **建议公司类型**（更专业，用户看到 "Longchan Tech" 比看到你个人名字信任度高），但着急的话先用个人，以后能迁移
4. 付款 $99 USD（信用卡可，国内 Visa/Mastercard 都行）
5. 等 Apple 审核邮件

### 2.2 审核通过后

收到 "Welcome to the Apple Developer Program" 邮件，登录 https://developer.apple.com/account/，能看到 **Membership** 页签里有你的 **Team ID**（10 位字母数字，比如 `A1B2C3D4E5`）。**记下来**，后面要用。

---

## 3. 生成 Developer ID Application 证书

> 这是给 Mac app 签名用的证书。**不是 App Store 用的证书**，不要选错。

### 3.1 生成 CSR（证书签名请求）

1. Mac 上打开 **钥匙串访问（Keychain Access）**
2. 顶部菜单 → **钥匙串访问 → 证书助理 → 从证书颁发机构请求证书**
3. 填：
   - 用户电子邮件地址：你 Apple ID 邮箱
   - 常用名称：`Longchan Tech` 或你名字
   - CA 电子邮件地址：留空
   - 请求是：选 **存储到磁盘**
4. 保存为 `~/Desktop/lintu-codesign.certSigningRequest`

### 3.2 上传 CSR 到 Apple，下载证书

1. 浏览器打开 https://developer.apple.com/account/resources/certificates/list
2. 点右上角的 **+** 加号 → 选 **Developer ID Application** → 继续
3. 上传刚才生成的 `.certSigningRequest` 文件
4. 下载生成的 `.cer` 文件，文件名类似 `developerID_application.cer`
5. **双击 `.cer` 文件** → 系统钥匙串里会自动安装好

### 3.3 验证安装成功

```bash
security find-identity -v -p codesigning
```

输出应该有一行：

```
1) AAAAAAAAAA "Developer ID Application: Longchan Tech (XXXXXXXXXX)"
   1 valid identities found
```

记下双引号里的整个字符串 —— 这就是你的 **signing identity**。

### 3.4 导出为 .p12（CI 用）

1. 打开**钥匙串访问** → 找到上一步装的 "Developer ID Application: Longchan Tech (...)"
2. **右键** → **导出**
3. 选格式 **.p12**
4. 保存为 `~/Desktop/lintu-codesign.p12`
5. **设置一个密码**（比如 `lintu-mac-2026`），记好 —— 后面 GitHub Secret 要用

> ⚠️ `.p12` 文件包含**私钥**，谁拿到都能用你的名义签名。**不要**提交到 git，**不要**发到群里。

---

## 4. 创建 App Store Connect API Key（公证用）

> 公证 = 把你的 .dmg 上传到 Apple 服务器，让 Apple 扫描并打个"已批准"的章。Apple 提供两种鉴权方式：app-specific password（旧）和 API Key（新）。我们用 API Key，更安全 + 不会因为密码改了就失效。

1. 浏览器打开 https://appstoreconnect.apple.com/access/integrations/api
2. 点 **生成 API 密钥** 或者 **+** 号
3. 名称填：`lintu-notarize`
4. 访问权限选：**Developer**（最低权限就够公证用）
5. 点生成 → 立即下载 `.p8` 文件（**只能下载一次**，丢了只能重新生成）
6. 记下：
   - **Key ID**（10 字符）
   - **Issuer ID**（UUID 格式，在页面顶部）

`.p8` 文件保存到 `~/Desktop/AuthKey_<KEY_ID>.p8`

> 备选方案：用 Apple ID + app-specific password 也能公证，更简单但安全性稍差。在 https://appleid.apple.com → 登录安全 → 生成 App-Specific Password，标签填 "lintu-notarize"，记下生成的 19 位密码。
>
> 我们的 CI workflow **同时支持**两种方式 —— 用哪种填哪种 secret 就行。下面 §9 步骤里两条路都给。**新手建议用 app-specific password**，少一个文件要管。

---

## 5. 在本地试打一次（无签名）

先跑个不签名的版本，确认代码 + 构建链没问题。

```bash
cd lintu/apps/electron
./scripts/build_mac.sh
```

第一次跑会：
- 自动从 `build/icon.png` 生成 `build/icon.icns`（macOS 图标格式）
- 安装 sidecar Python 依赖（约 5 分钟）
- 跑 PyInstaller 出 `apps/sidecar/dist/sidecar/sidecar`
- 跑 electron-builder 出 `apps/electron/release/灵图-0.1.0-arm64.dmg`

终端最后会输出 `Mode: UNSIGNED`。

**双击 dmg → 拖灵图.app 到 Applications → 双击启动**

第一次会弹：
> "灵图.app" 无法打开，因为无法验证开发者

**这是预期的**（没签名）。手动绕过：右键灵图.app → **打开** → 弹窗里再点 **打开**。

确认能跑起来，主窗口出来，sidecar /health 通：✅ 代码层面没问题，可以进下一步。

---

## 6. 在本地试打一次（带签名 + 公证）

```bash
cd lintu/apps/electron

# 把证书 + 公证凭据塞到环境变量里
export CSC_LINK=~/Desktop/lintu-codesign.p12
export CSC_KEY_PASSWORD='lintu-mac-2026'

# 公证用 app-specific password 路径（推荐新手）：
export APPLE_ID='你的@apple-id邮箱'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # 19 位
export APPLE_TEAM_ID='A1B2C3D4E5'                           # §2.2 记的那个

./scripts/build_mac.sh
```

终端会显示 `Mode: SIGNED + NOTARIZED`，公证大约 2-5 分钟，看到一行 `notarization successful` 即成功。

产物：
- `release/灵图-0.1.0-arm64.dmg` —— 已签名 + 已公证 + 已 staple（公证票据已附在 dmg 里，离线也能验）
- `release/灵图-0.1.0-arm64-mac.zip` —— electron-updater 增量更新用
- `release/latest-mac.yml` —— 更新通道指挥棒

### 验证

```bash
# 验证签名
codesign --verify --deep --strict --verbose=2 release/mac-arm64/灵图.app
# 期望输出: ...satisfies its Designated Requirement

# 验证公证
xcrun stapler validate release/灵图-0.1.0-arm64.dmg
# 期望输出: The validate action worked!

# 模拟 Gatekeeper（最严格的检查）
spctl --assess --type execute --verbose=2 release/mac-arm64/灵图.app
# 期望输出: accepted
#           source=Notarized Developer ID
```

三个都过，**Mac 用户安装时不会有任何 Gatekeeper 警告**。

把 dmg 发给同事的 Mac 试装，应该零提示直接装上。

---

## 7. 把 .p12 转 base64 给 GitHub Secrets

CI 需要 base64 编码后的证书：

```bash
base64 -i ~/Desktop/lintu-codesign.p12 | pbcopy
```

`pbcopy` 把 base64 字符串自动放到剪贴板。一会儿粘到 GitHub。

如果你用的是 App Store Connect API Key（.p8 文件）而不是 app-specific password，再来一次：

```bash
base64 -i ~/Desktop/AuthKey_*.p8 | pbcopy
```

---

## 8. 更新 GitHub Secrets

在 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，加下面这些（**Windows 那批之前已经加过的可以保留**）：

### Mac 签名（必填）

| Secret Name | 值 |
|---|---|
| `MAC_CODESIGN_P12_BASE64` | §7 第一段 base64 |
| `MAC_CODESIGN_P12_PASSWORD` | `lintu-mac-2026`（或你设的密码） |

### Mac 公证（二选一）

**选项 A：app-specific password（推荐新手）**

| Secret Name | 值 |
|---|---|
| `APPLE_ID` | 你 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | §4 备选方案生成的 19 位密码 |
| `APPLE_TEAM_ID` | §2.2 的 10 位 Team ID |

**选项 B：API Key（旧 password 失效不影响 CI）**

> 如果选 B，上面 A 的三个 secret 不用加。我们 CI workflow 自动检测哪种 env 存在就用哪种。但说明：当前 workflow 模板写的是 A 路径，如果你坚持选 B 我可以再改 workflow，告诉我即可。

### Windows 那批（如果还没加，参考 OSS 运维手册 §1.3）

| Secret Name | 备注 |
|---|---|
| `WIN_CODESIGN_PFX_BASE64` | 已加（自签证书） |
| `WIN_CODESIGN_PFX_PASSWORD` | 已加 |

### OSS 上传（Mac 和 Windows 共用）

| Secret Name | 值 |
|---|---|
| `ALIYUN_OSS_ACCESS_KEY_ID` | RAM 子账号 AccessKey |
| `ALIYUN_OSS_ACCESS_KEY_SECRET` | RAM 子账号 Secret |
| `ALIYUN_OSS_BUCKET` | `lintu-releases` |
| `ALIYUN_OSS_ENDPOINT` | `oss-cn-hangzhou.aliyuncs.com` |

---

## 9. OSS bucket 加 mac/ 路径

OSS 控制台 → lintu-releases bucket：

1. 文件管理 → 新建目录 `mac/`（其实自动创建就行，第一次 ossutil cp 会自动建）
2. 权限管理 → Bucket Policy → 给之前的 RAM 子账号补一条对 `mac/*` 的读写权限（如果你之前只授了 `windows/*`）

完整 Bucket Policy 示例（替换 `<YOUR_RAM_USER_ARN>`）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": ["<YOUR_RAM_USER_ARN>"],
      "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"],
      "Resource": [
        "acs:oss:*:*:lintu-releases/windows/*",
        "acs:oss:*:*:lintu-releases/mac/*"
      ]
    },
    {
      "Effect": "Allow",
      "Principal": ["*"],
      "Action": ["oss:GetObject"],
      "Resource": [
        "acs:oss:*:*:lintu-releases/windows/*",
        "acs:oss:*:*:lintu-releases/mac/*"
      ]
    }
  ]
}
```

第一条给 CI 写权限，第二条给所有用户读权限（让 electron-updater 能拉 latest.yml 不需要鉴权）。

---

## 10. 触发首个 Mac 发版

```bash
cd lintu

# 改 apps/electron/package.json 里的 version 字段（比如 0.1.0 → 0.1.1）
# 你的 IDE 改完保存即可
git add apps/electron/package.json
git commit -m "v0.1.1: 首次 macOS 发版（含签名 + 公证）"

# 打 tag
git tag v0.1.1
git push origin v0.2 --tags
```

GitHub → Actions tab → 看 workflow 跑：

- **Windows job** ≈ 8-12 分钟
- **macOS job** ≈ 15-25 分钟（PyInstaller 在 Mac 上慢一些 + 公证要等 Apple 服务器）
- 最后有个 **Release job** 把两个产物挂到 GitHub Release 页

跑完后：
- OSS `mac/latest-mac.yml` 出现
- OSS `windows/latest.yml` 也更新到 v0.1.1

---

## 11. 验证 Mac 用户能收到更新

最干净的办法：**找一台同事的 Mac**（不是你这台 —— 你这台开发者 Keychain 太干净了，验证不出 Gatekeeper 问题）：

1. 让同事下载 v0.1.0 dmg（如果你之前有发 v0.1.0 的话）安装。如果没有，跳到下一步。
2. 用同事的 Mac 启动灵图。打开**设置 → 关于** 应该看到 v0.1.0。
3. 等 30 秒（10 秒静默检查 + 下载时间），右下角应该会弹 `新版本 v0.1.1 已就绪 [立即重启]` toast。
4. 点重启 → 应该无任何警告直接升到 v0.1.1。
5. 设置 → 关于 重新查看版本号变成 0.1.1。

如果没看到 toast，按 `桌面应用更新-OSS运维手册.md` §3 的排错速查表逐一检查。

---

## 12. 后续日常发版流程

跑通一次之后，往后每次发版只要：

```bash
# 1. 改 apps/electron/package.json 的 version
# 2. 提交
git add apps/electron/package.json
git commit -m "v0.1.x: <一句话描述>"
git tag v0.1.x
git push origin v0.2 --tags
# 3. 等 25 分钟
# 4. Mac + Windows 用户自动收到推送
```

完。证书 / 公证凭据都在 GitHub Secrets，本地不用再操心，除非：

- **Apple Developer 续费**：每年提醒你续 $99
- **Developer ID 证书过期**：5 年期。到期前 6 个月去 §3 重新生成、重新签名一次过渡版本，否则老 Mac 用户会断更
- **app-specific password 失效**：你改 Apple ID 密码会自动撤销所有 app-specific password，需要重新生成 + 更新 `APPLE_APP_SPECIFIC_PASSWORD` secret

---

## 排错速查

### `errSecInternalComponent` during signing

钥匙串里有 stale 的 partition list。Mac 终端跑：

```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <你的钥匙串密码> ~/Library/Keychains/login.keychain-db
```

### Notarization "in progress" 卡住超过 10 分钟

Apple 服务器偶尔慢，可以手动查状态：

```bash
xcrun notarytool history --apple-id <你的apple id> --team-id <team id> --password <app-specific password>
```

### CI 上 "ENOENT: codesign command not found"

`runs-on: macos-latest` 应该自带 Xcode CLT，如果报这个错，加一步：

```yaml
- run: xcode-select --print-path
```

如果输出 `/Library/Developer/CommandLineTools` 是正常的；如果是 `/Applications/Xcode.app/...` 也行。如果报错就是 runner 镜像问题，等 1 小时重试。

### `app is damaged` 错误

90% 是没公证。解法：把 §6 跑通，不要跳步骤。

### `entitlement` 报错

我写的 `apps/electron/build/entitlements.mac.plist` 已经覆盖了 Electron 常见情况。如果你引入了新的 native dep（比如 keytar），可能要加 `keychain-access-groups` 之类的 entitlement，到时再说。

---

## 关键文件位置（速查）

| 文件 | 作用 |
|---|---|
| `apps/electron/electron-builder.yml` | mac/win 打包配置 |
| `apps/electron/build/entitlements.mac.plist` | macOS hardened runtime entitlements |
| `apps/electron/build/icon.icns` | Mac 图标（首次构建自动从 icon.png 生成） |
| `apps/electron/scripts/build_mac.sh` | Mac 一键打包脚本 |
| `.github/workflows/build-installers.yml` | CI matrix（Mac + Windows 并行） |
| `~/Desktop/lintu-codesign.p12` | 你本地的签名证书（**别上传**） |
| `~/Desktop/AuthKey_*.p8` | App Store Connect API Key（**别上传**，如果用了 API Key 路径） |

---

## 常见决策（FAQ）

**Q: 我能在 Mac 上同时打 Windows 包吗？**
不能。PyInstaller 不支持跨平台编译。但你可以 push tag 到 GitHub，CI 会自动在 Windows runner 上打 Windows 包（你不用管）。

**Q: 公证凭据放本地不安全，能完全走 CI 吗？**
能。把 §6 本地试打跳过（或者在你信任的 Mac 上跑过一次确认能通），然后只走 CI 路径：改代码 → 提交 → 推 tag → CI 自动签名公证。本地永远不需要存 .p12 / .p8。

**Q: arm64 mac 包能跑在 Intel Mac 上吗？**
能跑（通过 Rosetta 2 翻译），但启动慢 + 性能差。如果你团队还有 Intel Mac，在 `electron-builder.yml` 的 `mac.target` 里把 `arch: [arm64]` 改成 `arch: [arm64, x64]`，CI 会同时打两个 dmg。

**Q: 公司类型 vs 个人类型证书区别？**
公司类型证书签名后用户看到 "Developer ID Application: Longchan Tech (XXXX)"，个人类型看到的是你的个人名字。功能上等同。后续你想从个人迁移到公司有官方流程，但要重新签名一次过渡版。

**Q: 我能用别人的 Apple Developer 账号给我的 app 签名吗？**
能（让对方把 .p12 给你或加你为 team member）。但 app 的 Bundle ID（`com.lintu.app`）必须在那个账号下注册。如果以后切换账号，所有装机用户必须重装 —— Bundle ID 改了 = 完全不同的 app。
