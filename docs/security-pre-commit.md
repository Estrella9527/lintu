# Pre-commit 敏感串拦截

仓库已从 private 转 public（2026-05-09），所有真实基础设施 / 客户标识
通过 git filter-repo 重写历史清除，并引入双层防护避免再次入库。

## Setup（clone 后必做一次）

1. 复制 hook 模板：
   ```bash
   cp scripts/hooks/pre-commit.sh.example .git/hooks/pre-commit
   chmod +x .git/hooks/pre-commit
   ```
2. 从内部知识库 / 1Password 拿到「敏感串黑名单」，编辑
   `.git/hooks/pre-commit`，把注释行的占位（`<REAL_IP_PATTERN>` 等）
   换成真实 regex。

   `.git/hooks/` 不入版本控制 → 每人本地维护，永不 commit 真值。

3. （可选）装 gitleaks 二道防线：
   ```bash
   brew install gitleaks
   cp .gitleaks.toml.example .gitleaks.toml
   # 编辑 .gitleaks.toml，把占位换成真值（同样本地维护，已 .gitignore）
   ```

   pre-commit hook 优先调 gitleaks，找不到时降级用本地 grep。

## 紧急绕过

```bash
git commit --no-verify
```

仅在确认是误报时使用。

## 维护

新增"必须拦截"的串时，**只改本地** `.git/hooks/pre-commit` 的
`PATTERNS` 数组 + 本地 `.gitleaks.toml`。
**不要把真值字面量 commit 到 .example 模板** — 那等于二次泄露。
