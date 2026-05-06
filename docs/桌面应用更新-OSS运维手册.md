# 桌面应用更新 — OSS 运维手册

> 配套代码已落地（v0.2 分支）。这份文档讲怎么把 OSS bucket 配出来 + 怎么发版。
> 设计背景见 [`桌面应用更新机制设计.md`](./桌面应用更新机制设计.md)。

---

## 1. 一次性配置

### 1.1 创建 OSS bucket

阿里云控制台 → 对象存储 OSS → 创建 Bucket：

| 项 | 值 |
|---|---|
| Bucket 名称 | `lintu-releases` |
| 地域 | 华东 1（杭州）— 跟现有图床 bucket 同区域，省内网流量费 |
| 存储类型 | 标准存储 |
| 读写权限 | **公共读**（关键：不公共读 electron-updater 拿不到 latest.yml） |
| 服务端加密 | OSS 完全托管即可 |
| 同城冗余 | 关闭（更新包丢失最多重发一次，不值得双倍存储费） |
| 实时日志查询 | 关闭 |
| 版本控制 | 关闭 |

### 1.2 创建 RAM 子账号（CI 用）

阿里云控制台 → 访问控制 RAM → 用户：

1. **新建用户** `lintu-ci-publisher`
2. **添加权限**：自定义策略
   ```json
   {
     "Version": "1",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject", "oss:ListObjects"],
         "Resource": [
           "acs:oss:*:*:lintu-releases/windows/*",
           "acs:oss:*:*:lintu-releases/mac/*",
           "acs:oss:*:*:lintu-releases"
         ]
       }
     ]
   }
   ```
   > 这条策略只允许写 `lintu-releases/{windows,mac}/` 前缀，碰不到现有图床数据。**不要**给主账号 AccessKey 当 CI 凭证用。

3. **创建 AccessKey** → 立刻把 ID + Secret 复制出来，关掉页面就再也看不到 Secret 了
4. 登录控制台 → Bucket → 权限管理 → Bucket Policy → 给上面这个 RAM 用户授读写权限到 `windows/*` 和 `mac/*` 路径

### 1.3 把凭证喂给 GitHub Actions

仓库 → Settings → Secrets and variables → Actions，加四个 secret：

| Secret Name | 值 |
|---|---|
| `ALIYUN_OSS_ACCESS_KEY_ID` | 上一步生成的 AccessKey ID |
| `ALIYUN_OSS_ACCESS_KEY_SECRET` | 上一步生成的 AccessKey Secret |
| `ALIYUN_OSS_BUCKET` | `lintu-releases` |
| `ALIYUN_OSS_ENDPOINT` | `oss-cn-hangzhou.aliyuncs.com` |

### 1.4 (可选) 绑自定义域名 + CDN

如果想以后换 CDN 服务商不影响 app 端代码，**强烈建议第一次就绑域名**：

1. 备好一个域名 `update.lintu.app`（或类似），DNS 那边加 CNAME 记录指向 `lintu-releases.oss-cn-hangzhou.aliyuncs.com`
2. 阿里云 OSS 控制台 → 传输管理 → 域名管理 → 绑定域名
3. 绑成功后，把 `apps/electron/electron-builder.yml` 里的 publish.url 改成 `https://update.lintu.app/windows`
4. 推一个新版本，从这个版本起所有客户端都会改用新域名

不做的话默认走 OSS 公网域名 `https://lintu-releases.oss-cn-hangzhou.aliyuncs.com/windows`，**完全够用**，只是品牌感差点，且未来换厂商需要让所有用户重新装一次。

---

## 2. 发布流程

> ⚠️ 关键约定：**只有 git tag 触发的构建才会上传到 OSS**。push 到 v0.2 分支只跑构建测试（artifact 进 GitHub Actions 30 天保留），不会污染 live 更新通道。

### 2.1 标准发版

```bash
# 1. 改 apps/electron/package.json 里的 version 字段
# 2. 提交
git add apps/electron/package.json
git commit -m "v0.1.1: <一句话描述更新内容>"

# 3. 打 tag
git tag v0.1.1
git push origin v0.2 --tags
```

**接下来 10-15 分钟里 GitHub Actions 会自动**：

1. 构建签名后的 `灵图-Setup-0.1.1-x64.exe`
2. 上传到 `oss://lintu-releases/windows/`
3. 同时把 `latest.yml` 也覆盖上去（这是 electron-updater 的指挥棒）
4. 在 GitHub Releases 创建一个 `v0.1.1` release，附上文件 + 自动 changelog

### 2.2 客户端会发生什么

- 每个已安装的灵图 app，在下次启动后 10 秒会去拿 `latest.yml`
- 看到版本号比本地新 → 后台静默下载新 .exe
- 下载完成 → 右下角弹 toast "新版本 v0.1.1 已就绪"，附 [立即重启] 按钮
- 用户点重启 → 当场升级 → 自动启动新版本
- 用户不点 → 关闭 app 时 NSIS 会安静地把新版本装上，下次启动就是新版

### 2.3 如何"撤回"一个有问题的版本

发现 v0.1.1 有重大 bug，要让所有客户端回到 v0.1.0：

```bash
# 在 OSS 控制台，把 windows/latest.yml 编辑回 v0.1.0 的内容
# (latest.yml 当时已经在 oss://lintu-releases/windows/灵图-Setup-0.1.0-x64.exe.blockmap 旁的某次发版生成过)
```

更优雅的做法：再发一个 v0.1.2 修复版（即使没改实际代码也要 bump 版本号），客户端会从 v0.1.1 升到 v0.1.2。**electron-updater 不会让客户端"降级"**——版本号必须单调递增。

### 2.4 如何强制不让某些版本继续运行

`electron-updater` 不直接支持。要做的话，sidecar 端检查请求时验证 app 的 User-Agent / 版本号 header，如果是 deny-list 上的版本就返回特殊错误码，前端弹"请先更新"全屏遮罩。这是后续路径 D 的范畴，先不做。

---

## 3. 排错速查表

### 3.1 客户端日志在哪

Windows: `%APPDATA%\灵图\logs\main.log` —— electron-updater 默认写在这里。所有 `[updater]` 前缀的日志都进了主进程 console.log，但 packaged build 没有 console window，所以查 main.log 是唯一靠谱方式。

Mac/Linux 后续支持后路径会不一样，到时再补。

### 3.2 用户反馈"没收到更新"

检查清单：

1. **app 版本号**：让用户截图设置 → 关于 → 当前版本。比 `latest.yml` 里的版本号低吗？
2. **网络可达性**：让用户在浏览器访问 `https://lintu-releases.oss-cn-hangzhou.aliyuncs.com/windows/latest.yml`，能下载下来吗？下载下来内容是最新版本号吗？
3. **签名校验**：日志里有 `signature` / `verify` / `cert` 字样的报错吗？如果有，说明新版本和老版本的代码签名证书发布者名（CN）对不上，老版本会拒绝升级。这是换证书时的硬伤，**唯一解法是手动重装一次**。
4. **下载完成但没提示重启**：让用户点设置 → 关于 → 检查更新，看下面的状态。如果显示"已就绪"+ [立即重启] 按钮，让他们点。如果状态卡在"下载中"且进度条不动，可能是磁盘满了，让他们看 `%LOCALAPPDATA%\lintu-updater` 的可用空间。

### 3.3 GitHub Actions 上传 OSS 失败

最常见原因：

- ossutil cp 时 403 → RAM 子账号策略没给 `oss:PutObject` 权限到 `windows/*`，重新看 1.2 步
- ossutil cp 时 SignatureDoesNotMatch → AccessKey Secret 漏了或者复制时多带了空格，重新粘到 GitHub secret
- ossutil 找不到 → setup ossutil 那个 step 跑挂了，看下 GitHub Actions 日志

### 3.4 如何本地测试整个流程（不走 GitHub Actions）

```bash
# 1. 改 apps/electron/package.json version 到一个临时高版本号，比如 99.0.0
# 2. 本地跑构建脚本
cd apps/electron && powershell scripts/build_win.ps1
# 3. 手动把 release 目录里的 .exe + .exe.blockmap + latest.yml 三件套传到一台 staging OSS bucket
# 4. 改 electron-builder.yml 的 publish.url 临时指向 staging bucket
# 5. 重新构建一个版本 0.1.0 的 build，装上
# 6. 关闭 app；改 staging bucket 的 latest.yml 让 version 变成 99.0.0；启动 app
# 7. 等 10 秒 → 应该后台开始下载 → 30 秒后右下角弹 [立即重启] toast
```

---

## 4. 成本估算（参考）

| 项 | 单价 | 月用量假设 | 月成本 |
|---|---|---|---|
| OSS 存储 | ¥0.12/GB/月 | 6 个版本 × 250 MB ≈ 1.5 GB | ¥0.18 |
| 下载流量 | ¥0.50/GB（外网，国内） | 100 用户 × 4 周更新 × 250 MB | ¥50 |
| 请求次数 | ¥0.0001/次 | 每用户每天检查 1 次 × 100 用户 × 30 天 = 3000 次 | ¥0.30 |
| **小计** | | | **~¥50/月** |

按用户量线性增长。绑了 CDN 之后流量单价降到 ¥0.20/GB，节省一半。

---

## 5. macOS 发版（已落地）

macOS 走独立的 OSS 路径：

```
oss://lintu-releases/
├── windows/
│   ├── latest.yml
│   ├── 灵图-Setup-x.x.x-x64.exe
│   └── 灵图-Setup-x.x.x-x64.exe.blockmap
└── mac/
    ├── latest-mac.yml
    ├── 灵图-x.x.x-arm64.dmg          # 用户首次安装
    ├── 灵图-x.x.x-arm64-mac.zip      # electron-updater 增量更新走这个
    └── 灵图-x.x.x-arm64.dmg.blockmap
```

CI 在 `macos-latest` runner 上 build 出这一套，按相同的 ossutil 流程上传到 `mac/` 前缀。具体配置流程见 [`桌面应用Mac发布指南.md`](./桌面应用Mac发布指南.md)。

需要在 GitHub Secrets 额外加（仅 Mac 链路用）：
- `MAC_CODESIGN_P12_BASE64`
- `MAC_CODESIGN_P12_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

---

## 6. 已知限制 + 后续工作

- **Linux 还没适配**：当前只 Windows + macOS。Linux 走 AppImage + electron-updater，思路一样，有 Linux 用户再做
- **没有灰度发布**：当前所有用户拿同一个 `latest.yml`。设计文档 §5 有 channel-based 灰度的草案，等用户量上 100+ 再上
- **没有发版 changelog 直接展示在 app 里**：现在只有 GitHub Release 页面里有 auto-generated changelog，app 内"关于"页只显示"已就绪"。后续可以让 `latest.yml` 带一个 `releaseNotes` 字段，AboutTab 渲染出来
- **签名证书过期没有续期机制**：当前自签证书 5 年（到 2031）。未来真换商业 EV 证书时，需要在 sidecar / app 里加双签兼容期 —— 先发个版本同时用新旧两把证书签，让所有老客户端先升到这个"过渡版"，之后再纯用新证书发版。否则换证书那次会让所有客户端断更
