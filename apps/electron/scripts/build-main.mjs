#!/usr/bin/env node
/**
 * 主进程打包脚本 — 用 esbuild Node API 而不是 CLI，主要为了把 `--define:`
 * 的 JSON 字面量转义跨平台搞定（Windows PowerShell 的 quoting 跟 bash 不一样
 * 经常踩坑）。
 *
 * 控制变量：
 *   LINTU_BUILD_FLAVOR              'user' | 'ops' | 'dev'（默认 user — 保守）
 *   BAKED_SMS_ACCESS_KEY            CI 注入的阿里云 SMS AccessKey ID（可选）
 *   BAKED_SMS_ACCESS_SECRET         同上 Secret
 *   BAKED_SMS_SIGN_NAME             同上 签名（如 "杭州龙蟾"）
 *   BAKED_SMS_TEMPLATE_CODE         同上 模板编号（如 "SMS_xxxxxxxx"）
 *
 * 输出：dist/main.cjs，里面 __BUILD_FLAVOR__ / __BAKED_SMS_*__ 已被替换。
 *
 * 凭据策略（user 版才注入；dev / ops 不烧凭据）：
 *   user：CI Secrets → main.cjs → 启动 sidecar 时 env-forward → 客户零配置发短信
 *   ops：本地运维机有 LINTU_SMS_* env 兜底
 *   dev：本地开发者从终端 source ~/.lintu-secrets.zsh
 */
import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const flavor = process.env.LINTU_BUILD_FLAVOR || 'user'
if (!['user', 'ops', 'dev'].includes(flavor)) {
  console.error(`[build-main] invalid LINTU_BUILD_FLAVOR=${flavor}; must be user|ops|dev`)
  process.exit(1)
}

console.log(`[build-main] BUILD_FLAVOR=${flavor}`)

// 只 user 版烧 SMS 凭据。dev / ops 不烧（开发自带 env / ops 运维机自带 env）。
// 如果 CI 没注入 secrets（开发者本地跑这个脚本），全部留空字符串 — 运行时
// main 进程检测到空字符串就跳过 baked 路径，相当于没烧。
const bakedSms = flavor === 'user' ? {
  access_key:    process.env.BAKED_SMS_ACCESS_KEY    || '',
  access_secret: process.env.BAKED_SMS_ACCESS_SECRET || '',
  sign_name:     process.env.BAKED_SMS_SIGN_NAME     || '',
  template_code: process.env.BAKED_SMS_TEMPLATE_CODE || '',
} : { access_key: '', access_secret: '', sign_name: '', template_code: '' }

const bakedSmsPresent = !!(bakedSms.access_key && bakedSms.access_secret &&
                           bakedSms.sign_name && bakedSms.template_code)
console.log(`[build-main] baked SMS credentials: ${bakedSmsPresent ? 'YES' : 'no (will fall back to config.json)'}`)

await build({
  entryPoints: [resolve(ROOT, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: resolve(ROOT, 'dist/main.cjs'),
  external: ['electron'],
  define: {
    __BUILD_FLAVOR__: JSON.stringify(flavor),
    __BAKED_SMS_ACCESS_KEY__:    JSON.stringify(bakedSms.access_key),
    __BAKED_SMS_ACCESS_SECRET__: JSON.stringify(bakedSms.access_secret),
    __BAKED_SMS_SIGN_NAME__:     JSON.stringify(bakedSms.sign_name),
    __BAKED_SMS_TEMPLATE_CODE__: JSON.stringify(bakedSms.template_code),
  },
  // sourcemap helps when packaged-app crashes — keeps stack traces readable
  sourcemap: 'inline',
  // minify only for "user" build to save bundle size; dev needs readable code
  minify: flavor !== 'dev',
})

console.log(`[build-main] dist/main.cjs ready`)
