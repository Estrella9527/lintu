# 灵图备份系统

> 部署目标：ECS 192.0.2.1（api.example.com）
> 当前状态：脚本已就位，**等待 ECS 部署**

## 快速部署

```bash
# 1. 同步脚本到 ECS
scp -r scripts/backup ecs:/opt/lintu/scripts/

# 2. 在 ECS 上配置凭据
ssh ecs
cd /opt/lintu/scripts/backup
cp .env.example .env
chmod 600 .env
vim .env       # 填 PG 密码 / OSS bucket / 加密 key

# 3. 创建 OSS bucket（如未存在）
ossutil mb oss://lintu-backups
ossutil bucket-lifecycle --method put oss://lintu-backups lifecycle.xml

# 4. 创建本地备份目录 + 日志目录
mkdir -p /var/backups/lintu /var/log/lintu

# 5. 跑一次手动备份验证
bash /opt/lintu/scripts/backup/pg_dump_to_oss.sh --dry-run   # 不上传
bash /opt/lintu/scripts/backup/pg_dump_to_oss.sh             # 真上传

# 6. 跑一次还原冒烟测试
bash /opt/lintu/scripts/backup/restore_smoke.sh --keep       # 保留临时库供检查

# 7. 写 cron
sudo vim /etc/cron.d/lintu-backup
# 内容：
# 0 3 * * *  root  /opt/lintu/scripts/backup/pg_dump_to_oss.sh >> /var/log/lintu/backup.log 2>&1
# 0 4 * * 0  root  /opt/lintu/scripts/backup/restore_smoke.sh >> /var/log/lintu/restore-smoke.log 2>&1
```

## 文件清单

| 文件 | 用途 |
|---|---|
| `pg_dump_to_oss.sh`  | 每日 03:00 dump → 加密 → 推 OSS |
| `restore_smoke.sh`   | 每周日 04:00 拉最新备份 → 还原 → 校验 |
| `.env.example`       | 环境变量模板（凭据填这里，不入 git） |
| `README.md`          | 本文件 |

## 数据恢复 SOP

### 场景 1：误删表 / 误更新数据

1. 用 `restore_smoke.sh --target lintu_recovery_<ts> --keep` 还原到副本库
2. 在副本库 `pg_dump --table=<bad-table> ... | psql --dbname=lintu` 单表覆盖

### 场景 2：整库损坏

1. **先停 sidecar**：`docker stop lintu-sidecar`（避免新写入污染恢复期）
2. `dropdb lintu` （生产 PG，**有破坏性，先用副本库验证流程**）
3. `bash restore_smoke.sh --target lintu`（直接还原到 lintu 主库）
4. 重启 sidecar：`docker start lintu-sidecar`
5. 通过 `/open-api/v1/health` 验证

### 场景 3：磁盘故障

1. ECS 上挂新盘 → 安装 PG + 装 ossutil
2. 配置 .env（同上）
3. `bash restore_smoke.sh --target lintu --keep` 还原最新备份
4. 改 sidecar `LINTU_DB_URL` 指向新 host

## 加密密钥管理

`LINTU_BACKUP_KEY` 是恢复备份的**唯一凭证**。丢失等于备份全部作废。

- ECS 上：`/opt/lintu/scripts/backup/.env`（chmod 600）
- 离线副本：拷贝到 1Password / 手写纸条放保险柜
- **绝对不要写进 git / 飞书 / 邮件**

## 监控点

部署 P0-01' 后（应用内 release notes 已替代飞书告警计划），未来可以扩展：
- 失败的 cron 应该走系统邮件 / Sentry
- 每日 INFO 摘要可以推到飞书群（需先建 webhook）
