# 灵图云端部署 · 完整 Runbook

> 一份手把手的部署手册。从空白阿里云 ECS → UGC 能调通匹配。
> 写于 2026-04-28，对应代码版本 v0.2。
>
> **预估总耗时**：2-3 小时（DNS 生效等待时间不算在内）。

## 目录

- [Part 0 · 准备清单](#part-0--准备清单)
- [Part 1 · ECS 环境隔离 + 基础加固](#part-1--ecs-环境隔离--基础加固)
- [Part 2 · 域名 DNS + SSL 证书](#part-2--域名-dns--ssl-证书)
- [Part 3 · Nginx 反向代理](#part-3--nginx-反向代理)
- [Part 4 · 部署灵图云端 sidecar](#part-4--部署灵图云端-sidecar)
- [Part 5 · 本地端配置](#part-5--本地端配置)
- [Part 6 · 全量回填 + 闭环测试](#part-6--全量回填--闭环测试)
- [Part 7 · 排错速查](#part-7--排错速查)
- [Part 8 · 日常运维](#part-8--日常运维)

---

## Part 0 · 准备清单

开始前确认你已经有：

| 项 | 检查方式 |
|---|---|
| 阿里云 ECS（Ubuntu 22.04 LTS，2C4G 起） | 控制台能 SSH 上去 |
| 公网 IP | 控制台 ECS 详情页能看到 |
| 一个域名（如 `example.com`） | 控制台能管理 DNS |
| 你打算用的子域名（如 `api.example.com`） | 还没解析过即可 |
| 阿里云 OSS bucket 已经在用（图片同步那个） | 灵图桌面端 OSS 同步功能能跑 |
| 本地灵图桌面端正常运行 | macOS 上启动 Electron 不报错 |
| 本地有 ApiKey 创建权限（即你是开发者本人） | 桌面端「分发中心 → API Keys」能新建 |

如果有任何一项打不上勾，先停下来补齐再继续。

---

## Part 1 · ECS 环境隔离 + 基础加固

### 1.1 SSH 上 ECS（用 root 第一次登录）

```bash
ssh root@<你的_ECS_IP>
```

如果你已经设了 SSH key，跳过下一步。如果首次登录还是密码，强烈建议**立刻**改用 key：

```bash
# 在你本机生成（如果没有的话）
ssh-keygen -t ed25519 -C "lintu-deploy"
# 把公钥推到 ECS（root 用户）
ssh-copy-id root@<你的_ECS_IP>
```

### 1.2 创建一个非 root 用户跑灵图

**为什么必须**：root 跑 docker = 容器漏洞直接拿到主机 root。运维上的最小特权原则。

```bash
# 在 ECS 上（以 root 身份）执行
adduser lintu --disabled-password --gecos ""
usermod -aG sudo lintu
mkdir -p /home/lintu/.ssh
cp /root/.ssh/authorized_keys /home/lintu/.ssh/
chown -R lintu:lintu /home/lintu/.ssh
chmod 700 /home/lintu/.ssh
chmod 600 /home/lintu/.ssh/authorized_keys
```

测试新用户能登录：

```bash
# 在你本机
ssh lintu@<你的_ECS_IP>
# 进去后能 sudo
sudo whoami   # 应当输出 root
```

### 1.3 禁用 root SSH 登录 + 禁密码

```bash
# 在 ECS 上以 lintu 用户操作
sudo nano /etc/ssh/sshd_config
```

确认（或修改）这两行：

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
sudo systemctl restart ssh
```

**测试**：另开一个终端窗口（不要关掉当前的，万一锁出去了能救），尝试 `ssh root@<IP>` 必须被拒。然后 `ssh lintu@<IP>` 必须成功。

### 1.4 配置阿里云安全组

阿里云控制台 → ECS → 安全组 → 新增规则。**只**开这三个端口，其它全部 deny：

| 端口 | 协议 | 来源 | 用途 |
|---|---|---|---|
| 22 | TCP | 你的办公/家网 IP/32 | SSH（生产环境别开 0.0.0.0/0） |
| 80 | TCP | 0.0.0.0/0 | nginx HTTP（仅用于跳 HTTPS + ACME 证书校验） |
| 443 | TCP | 0.0.0.0/0 | nginx HTTPS（UGC 调用） |

**特别注意**：5432（PostgreSQL）**不要**开公网。docker-compose 里已经限定 `127.0.0.1:5432`，nginx 也不代理，安全组再多一道门。

### 1.5 系统更新 + 自动安全补丁

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # 选 Yes
```

### 1.6 时区 + 时间同步

时间不准会让 SSL 校验、HMAC 鉴权、日志混乱。

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo systemctl enable --now systemd-timesyncd
timedatectl status   # 看到 "System clock synchronized: yes"
```

### 1.7 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker lintu
# 退出 SSH 重新登录让 group 生效
exit
ssh lintu@<你的_ECS_IP>
docker --version       # 应当输出
docker compose version # 应当输出
```

### 1.8 准备项目目录

```bash
sudo mkdir -p /srv/lintu
sudo chown -R lintu:lintu /srv/lintu
```

到此 ECS 基础环境准备完成。

---

## Part 2 · 域名 DNS + SSL 证书

### 2.1 在域名服务商配置 A 记录

去你买域名的地方（万网 / Cloudflare / 阿里云 DNS / 等），加一条：

| 类型 | 主机记录 | 解析路线 | 解析值 | TTL |
|---|---|---|---|---|
| A | `api` | 默认 | `<你的_ECS_公网_IP>` | 600 |

效果：`api.example.com` → ECS 公网 IP。

**等待 DNS 生效**（10 分钟到几小时），用 `dig`（macOS）或在线 DNS 检查工具验证：

```bash
# 在你本机
dig +short api.example.com
# 应当返回你的 ECS 公网 IP
```

如果还没生效，喝杯茶等会儿再继续。**未生效不要往下做 SSL**，证书签发会失败。

### 2.2 安装 nginx

```bash
# 在 ECS 上以 lintu 用户操作
sudo apt install -y nginx
sudo systemctl enable --now nginx
# 验证：在你本机
curl http://api.example.com
# 应当看到 nginx 默认欢迎页
```

如果 curl 没响应，回头检查安全组 80 端口是否开通。

### 2.3 申请 SSL 证书（Let's Encrypt 免费）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

按提示：
- 输入邮箱（用于证书过期提醒，建议团队公共邮箱）
- 同意服务条款（A）
- 是否分享邮箱给 EFF（N，看心情）
- 是否自动 redirect HTTP → HTTPS：**选 2（Redirect）**

certbot 会自动改 `/etc/nginx/sites-enabled/default` 加 SSL 配置。验证：

```bash
# 在你本机
curl -I https://api.example.com
# 应当看到 200 OK + nginx + Strict-Transport-Security 头
```

### 2.4 验证证书自动续期

certbot 装的时候会顺手装 systemd timer，每天检查两次。手动验证：

```bash
sudo systemctl list-timers | grep certbot
# 应当看到 certbot.timer 在跑
sudo certbot renew --dry-run
# 应当输出 "Congratulations, all simulated renewals succeeded"
```

到此域名和 HTTPS 就绪。

---

## Part 3 · Nginx 反向代理

### 3.1 替换 nginx 配置

certbot 默认配置只是托管静态网页，需要改成反代到容器。

```bash
sudo nano /etc/nginx/sites-available/lintu
```

粘贴：

```nginx
# 灵图云端 sidecar 反代配置
# 上游 sidecar 监听 7879，nginx 套 TLS 暴露给 UGC

upstream lintu_sidecar {
    server 127.0.0.1:7879;
    keepalive 16;
}

# HTTP → HTTPS 强制跳转（除了 ACME 校验）
server {
    listen 80;
    server_name api.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS 主站
server {
    listen 443 ssl http2;
    server_name api.example.com;

    # 证书路径由 certbot 管理
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # 安全头
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 请求体大小：UGC 上传图片不走这条路（直传 OSS），最大就是 prompt 文档导入
    client_max_body_size 50m;

    # 内部 sync 端点禁止公网访问 — 只能本地推
    location /internal/ {
        deny all;
        return 403;
    }

    location / {
        proxy_pass         http://lintu_sidecar;
        proxy_http_version 1.1;
        proxy_set_header   Connection "";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE / 长连接 — 别缓冲，超时拉长
        proxy_buffering    off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

**重要**：`location /internal/ { deny all; }` 这一段把内部 sync 端点彻底挡在 nginx 层 —— UGC 应用即使知道 token 也调不到。本地 sync_worker 也走 nginx，所以本地的写入会被 deny ⚠️ 这是个矛盾点，下面 3.3 解决。

### 3.2 启用配置 + reload

```bash
sudo ln -sf /etc/nginx/sites-available/lintu /etc/nginx/sites-enabled/lintu
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t   # 必须看到 "syntax is ok" + "test is successful"
sudo systemctl reload nginx
```

### 3.3 内部 sync 入口的两种选项

#### 选项 A · 本地通过 nginx 推（默认推荐，简单）

把 `location /internal/` 那段改成：

```nginx
    # 内部 sync 端点 — 仅允许本地办公网 IP（CIDR），其它一律 403
    location /internal/ {
        allow <你的办公网/家网公网IP>;
        # 如果 IP 经常变（家用 PPPoE）就把这条删了，改用下面选项 B
        deny all;

        proxy_pass         http://lintu_sidecar;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_read_timeout 300s;
    }
```

本地 export `LINTU_CLOUD_SYNC_URL=https://api.example.com`，走公网。

#### 选项 B · 本地通过 SSH 隧道推（IP 经常变 / 多人协作）

ECS 上 nginx 保持 `deny all` for `/internal/`。本地建一个隧道：

```bash
# 在你本机后台跑（autossh 自动重连）
brew install autossh
autossh -M 0 -fNT \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 7880:127.0.0.1:7879 \
  lintu@<你的_ECS_IP>
```

本地 export `LINTU_CLOUD_SYNC_URL=http://127.0.0.1:7880`，走隧道。

**选哪个？**
- 个人/小团队：选 A 简单
- 不想留管理端口公网入口 / IP 经常变：选 B
- 极度严格：上 VPN（WireGuard），但这次不展开

---

## Part 4 · 部署灵图云端 sidecar

### 4.1 拉代码

```bash
# 在 ECS 上以 lintu 用户操作
cd /srv/lintu
# 用 deploy key 或者 PAT，私有仓库需要鉴权
git clone https://<你的GitHub用户>:<你的PAT>@github.com/Estrella9527/lintu.git .
# 或者更安全：先在 ECS 生成 ssh-keygen，把公钥加到 GitHub repo 的 deploy keys
git checkout v0.2
```

### 4.2 配置 .env

```bash
cd /srv/lintu/deploy
cp .env.example .env
nano .env
```

把这几个**必须**改掉：

```bash
# 用 openssl rand -base64 32 生成
POSTGRES_PASSWORD=<32 位随机串>

# 用 openssl rand -hex 32 生成。下面"本地端配置"会要这个值
LINTU_INTERNAL_SYNC_TOKEN=<64 位随机十六进制>

# UGC 站点的域名，逗号分隔
LINTU_ALLOW_CORS=https://ugc.example.com,https://*.example.com
```

可选（让云端能跑 query expansion，提升匹配召回；不配也行）：

```bash
# 跟你本地 ~/lintu-data/config.json 里的 default_image_embedding_provider 一致
LINTU_DEFAULT_IMAGE_EMBEDDING_PROVIDER=relay:ark-embedding
# JSON 字符串，跟本地 custom_relays 一致（注意整段是字符串，外面套引号）
LINTU_CUSTOM_RELAYS='[{"name":"ark-embedding","base_url":"https://ark.cn-beijing.volces.com/api/v3","api_key":"sk-xxx","model":"doubao-embedding-vision-251215"}]'
```

> **Tip**：这两个 provider 配置后续也会被本地 sync 推过来覆盖（步骤 6.1 的 bulk 脚本会推 config 子集）。所以这里不填也行 —— 但建议填，避免首次部署还没回填时云端就被 UGC 调用。

文件权限锁紧：

```bash
chmod 600 .env
```

### 4.3 启动容器

```bash
cd /srv/lintu/deploy
docker compose up -d
docker compose ps
```

应当看到两个容器 running：

```
NAME             STATUS         PORTS
lintu-pg         Up (healthy)   127.0.0.1:5432->5432/tcp
lintu-sidecar    Up (healthy)   0.0.0.0:7879->7879/tcp
```

如果 sidecar 状态是 `unhealthy` 或反复重启：

```bash
docker compose logs -f sidecar
# 常见：等 PG 启动 → 自动重试。等 30 秒
# 如果一直 alembic 报错 → 看 part 7 排错
```

### 4.4 Smoke test 云端

```bash
# 在 ECS 上
curl http://127.0.0.1:7879/health
# {"status":"ok","mode":"server"}

curl http://127.0.0.1:7879/open-api/v1/health
# {"status":"ok","version":"v1"}

# 在你本机
curl https://api.example.com/health
# 同上

curl https://api.example.com/open-api/v1/health
# 同上
```

四个都 200 就 OK。任何一个失败回到对应步骤排查。

---

## Part 5 · 本地端配置

> 全部在你的 MacBook 上操作。

### 5.1 把云端 token 拿到本地

`LINTU_INTERNAL_SYNC_TOKEN` 必须和云端 `.env` 里的**完全一致**。从 ECS 上拿：

```bash
ssh lintu@<你的_ECS_IP> 'grep LINTU_INTERNAL_SYNC_TOKEN /srv/lintu/deploy/.env'
```

复制等号后面那串。

### 5.2 持久化环境变量

**zsh（macOS 默认）**：

```bash
nano ~/.zshrc
```

在文件**末尾**追加：

```bash
# 灵图 — 推送本地数据到云端 sidecar
export LINTU_CLOUD_SYNC_URL=https://api.example.com
export LINTU_INTERNAL_SYNC_TOKEN=<刚刚拿到的 token>
```

让本终端立即生效：

```bash
source ~/.zshrc
echo $LINTU_CLOUD_SYNC_URL          # 应当输出 URL
echo $LINTU_INTERNAL_SYNC_TOKEN | head -c 12
```

### 5.3 让 Electron 桌面应用也能读到这些 env

`source ~/.zshrc` 只对终端起作用。Electron 是从 GUI 启的，**不读 ~/.zshrc**。两种解法：

#### 方法 A · 永远从终端启 Electron（开发期用）

每次干活前先开个终端：

```bash
cd /Users/yang/projects/lintu/apps/electron
bunx electron .
```

继承当前 shell 的 env。简单但每次都要这么开。

#### 方法 B · 写 launchd plist（推荐，一劳永逸）

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.lintu.env.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lintu.env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>LINTU_CLOUD_SYNC_URL</string>
    <string>https://api.example.com</string>
    <string>LINTU_INTERNAL_SYNC_TOKEN</string>
    <string>替换成实际 token</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.lintu.env.plist
launchctl getenv LINTU_CLOUD_SYNC_URL    # 应当输出 URL
```

GUI 启的应用就能读到。**重启电脑或注销重新登录**让全局生效。

### 5.4 重启灵图桌面端

完全退出桌面应用（Cmd+Q），重新打开。打开后**第一件事**：在终端跑

```bash
ps eww $(pgrep -f "Electron.*lintu" | head -1) | grep -oE "LINTU_CLOUD_SYNC_URL=[^ ]*"
# 应当看到你设的 URL
```

看不到 URL 说明 env 没传进去，回到 5.3 再排查。

### 5.5 验证 cloud_sync_worker 已启动

启动后看 sidecar 的实时日志（应用菜单 → 帮助 → 打开日志，或直接看 `~/Library/Logs/灵图/sidecar.log`）：

```
INFO  cloud_sync_worker: started → https://api.example.com
```

看到这行就对了。如果看到 `cloud_sync_worker: disabled (LINTU_CLOUD_SYNC_URL empty)` 说明 env 还是没传到，回 5.3。

---

## Part 6 · 全量回填 + 闭环测试

### 6.1 跑全量回填脚本

第一次部署，云端的 PG 是空的。在本机：

```bash
cd /Users/yang/projects/lintu/apps/sidecar
uv run python scripts/sync_to_cloud_bulk.py
```

预期输出：

```
Bulk-syncing local DB → https://api.example.com

  config: 6 pushed in 0.0s
  projects: 4 pushed in 0.5s
  api-keys: 2 pushed in 0.3s
  synonyms: 0 pushed in 0.4s
  tag-schema: 12 pushed in 0.4s
  images:   100 / 4497 (180/s, eta 24s)
  ...
  images: 4497 pushed in 27s

Done. The cloud sidecar's /open-api/v1/* should now serve real data.
```

如果失败：
- `cloud sidecar unreachable` → 检查 https URL 是否能 curl 通
- `HTTP 401` → token 不对，回 5.1 重新拿一遍贴
- `HTTP 502/504` → ECS 上的 sidecar 没起来或 nginx 配错

### 6.2 在云端 PG 验证数据

```bash
ssh lintu@<你的_ECS_IP>
cd /srv/lintu/deploy
docker compose exec postgres psql -U lintu lintu -c "
  SELECT
    (SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM images)   AS images,
    (SELECT count(*) FROM tags)     AS tags,
    (SELECT count(*) FROM api_keys WHERE is_active = true) AS active_keys;
"
```

数字应当和本地一致（项目 / 图片 / 标签数）。

### 6.3 在桌面端创建一把 UGC 用的 ApiKey

灵图桌面端 → 分发中心 → API Keys → 新建：

- 名称：`UGC 生产 v1`
- 客户端类型：`server`（让 UGC 后端代理调用，比纯 H5 安全）
- scopes：`images:read,images:match,tags:read`（只给读 + 匹配，不给写）
- 限流：per_minute=60，per_day=10000（按业务预估调）

提交后弹窗里**立刻**复制 `Bearer Token`（仅显示一次），保存好。

等 5 秒，让 sync_worker 把这条 key 推到云端。验证：

```bash
# 在你本机
ssh lintu@<你的_ECS_IP> 'docker compose -f /srv/lintu/deploy/docker-compose.yml exec -T postgres psql -U lintu lintu -tc "SELECT key_id FROM api_keys WHERE name=\\'UGC 生产 v1\\';"'
```

应当看到 `lk_live_xxx` 输出。看不到 → sync 没推过去，看本地日志 `cloud_sync_worker` 报错。

### 6.4 用 UGC 视角调云端匹配

模拟 UGC 后端（用 curl 代替）：

```bash
# 替换 TOKEN 为上面复制的 Bearer Token
TOKEN="lk_live_xxx.your_secret"

# 替换 PRIMARY_PROJECT_ID 为你想 scope 的项目 id
# 拿一个：
PROJECT_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.example.com/open-api/v1/stats \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('project_id', '请去桌面端查项目ID'))")

curl -s -X POST https://api.example.com/open-api/v1/images/match \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"夏天来漂流，水花四溅\",
    \"limit\": 5,
    \"scope\": { \"primary_project_id\": \"$PROJECT_ID\" }
  }" | python3 -m json.tool
```

期望看到：
- `matches` 数组有 5 张图
- 每张有 `url`（OSS CDN 直链）+ `is_primary_project: true`
- `scope_decision` 显示自动算的权重

### 6.5 拿一张 CDN URL 在浏览器打开

复制响应里的 `url` 字段，扔浏览器地址栏。应当直接看到图片。看不到 → OSS bucket 没设公开读，去阿里云 OSS 控制台改 bucket policy。

### 6.6 闭环：本地改 → 云端立即生效

最后一个测试 —— 验证增量同步路径。

1. 在桌面端**改一个 prompt 名字**（设置 → Prompt 库 → 双击改）
2. 等 3 秒
3. 在 ECS 上查：
   ```bash
   docker compose -f /srv/lintu/deploy/docker-compose.yml exec -T postgres \
     psql -U lintu lintu -c "SELECT name FROM prompts ORDER BY updated_at DESC LIMIT 3;"
   ```
4. 看到改后的名字 → 闭环成功 ✓

类似的：
- 加一个同义词 → 几秒后云端 `/internal/sync/synonyms` 已经收到
- 标记一张图为「淘汰」并删除 → 云端对应行被删，UGC 再调匹配不会再出现

---

## Part 7 · 排错速查

| 症状 | 大概率原因 | 怎么修 |
|---|---|---|
| `curl https://api.example.com` 超时 | DNS 没生效 / 安全组没开 443 / nginx 没起 | `dig` 验 DNS；`sudo systemctl status nginx`；ECS 控制台看安全组 |
| HTTPS 但证书错误 | certbot 失败 / 证书过期 | `sudo certbot renew --force-renewal` |
| `/health` 502 | sidecar 容器没起来 | `docker compose logs sidecar`，看 alembic 报错 |
| sidecar 容器一直重启 | 多半是 PG 还没 ready | 等 30s；如果还不行 `docker compose ps` 看 PG 是 healthy 没 |
| `/open-api/v1/match` 401 | Bearer token 无效 / 已停用 / 过期 | 桌面端新建 key 试试；3 秒后重试 |
| 401 但 token 一定对 | 本地 sync 没把 key 推到云端 | 本地日志看 `cloud_sync_worker` 报错；查本地 `cloud_sync_jobs` 表 status=failed 行 |
| 匹配返回 `matches: []` | 云端没图 / 云端 embed 失败 | 跑 `scripts/sync_to_cloud_bulk.py` 全量回填；检查云端 `LINTU_DEFAULT_IMAGE_EMBEDDING_PROVIDER` 配了 |
| UGC 浏览器报 CORS | CORS 白名单没包含 UGC 域名 | ECS 上 `nano /srv/lintu/deploy/.env` 改 `LINTU_ALLOW_CORS`；`docker compose restart sidecar` |
| 拿到 url 但浏览器图片 403 | OSS bucket 没设公网读 | 阿里云 OSS 控制台 → 权限管理 → bucket 读写权限 → 公共读 |
| `cloud_sync_worker: disabled` | 桌面端没读到 env | Part 5.3 检查 launchctl plist；GUI app 必须用 launchctl setenv，不读 .zshrc |
| 本地新建项目，云端没收到 | env 设了但应用没重启 | Cmd+Q 完全退出再开 |
| 网络流量异常 | 大概率被人扫端口或调用 | 看 nginx access log + 桌面端「分发中心 → 调用日志」；可疑 IP 在阿里云安全组黑掉 |

---

## Part 8 · 日常运维

### 8.1 看实时日志

```bash
# ECS 上
docker compose -f /srv/lintu/deploy/docker-compose.yml logs -f sidecar
# nginx 访问日志
sudo tail -f /var/log/nginx/access.log
# nginx 错误日志
sudo tail -f /var/log/nginx/error.log
```

### 8.2 备份 PG（每天）

```bash
# 加个 cron（lintu 用户）
crontab -e
# 加这行 — 每天凌晨 3 点
0 3 * * * cd /srv/lintu/deploy && docker compose exec -T postgres pg_dump -U lintu lintu | gzip > /srv/lintu/backups/pg-$(date +\%F).sql.gz
```

```bash
mkdir -p /srv/lintu/backups
# 测试备份能跑
cd /srv/lintu/deploy && docker compose exec -T postgres pg_dump -U lintu lintu | gzip > /srv/lintu/backups/pg-test.sql.gz
ls -lh /srv/lintu/backups/
```

每月手动 `scp` 一份到本机或 OSS 冷存储，防整机失联。

### 8.3 升级灵图（拉最新代码）

```bash
ssh lintu@<你的_ECS_IP>
cd /srv/lintu
git fetch origin
git checkout v0.3   # 或者新版本
cd deploy
docker compose build sidecar
docker compose up -d sidecar
docker compose logs -f sidecar   # 确认启动 + alembic 自动迁移成功
```

### 8.4 SSL 证书续期监控

certbot timer 每 60 天自动续。**额外保险**：用阿里云告警 / Uptime Kuma 监控 HTTPS 过期，30 天前提醒。

### 8.5 更换 token

如果怀疑 `LINTU_INTERNAL_SYNC_TOKEN` 泄漏，定期轮换：

```bash
# 1. 生成新 token
NEW_TOKEN=$(openssl rand -hex 32)
echo "新 token: $NEW_TOKEN"

# 2. 改 ECS .env
ssh lintu@<你的_ECS_IP>
cd /srv/lintu/deploy
sudo nano .env   # 替换 LINTU_INTERNAL_SYNC_TOKEN
docker compose restart sidecar

# 3. 改本机 launchctl
launchctl setenv LINTU_INTERNAL_SYNC_TOKEN "$NEW_TOKEN"
# 改 ~/Library/LaunchAgents/com.lintu.env.plist 的对应字段
# 重启灵图桌面应用
```

---

## 附：检查清单

部署完成后逐项打勾：

- [ ] ECS 用 lintu 非 root 用户
- [ ] root SSH + 密码登录已禁
- [ ] 安全组只开 22（限 IP）/ 80 / 443
- [ ] DNS A 记录解析到 ECS
- [ ] HTTPS 可访问，证书有效期 > 80 天
- [ ] nginx `/internal/` 已限 IP 或走隧道
- [ ] docker compose 两个容器 healthy
- [ ] `.env` 文件 chmod 600
- [ ] 本地 launchctl env 设好，桌面端能读到
- [ ] 本机日志看到 `cloud_sync_worker: started`
- [ ] 全量回填脚本跑完，云端 PG 数据 ≈ 本地 SQLite
- [ ] UGC 用 Bearer token 调云端匹配返回真实数据
- [ ] CDN URL 浏览器能直接打开图片
- [ ] 本地改 prompt 名字 → 3 秒后云端 PG 同步
- [ ] PG 备份 cron 每天跑

全部打勾就上线了。
