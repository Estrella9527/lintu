#!/usr/bin/env node
/**
 * 主进程打包脚本 — 用 esbuild Node API 而不是 CLI，主要为了把 `--define:`
 * 的 JSON 字面量转义跨平台搞定（Windows PowerShell 的 quoting 跟 bash 不一样
 * 经常踩坑）。
 *
 * 控制变量：
 *   LINTU_BUILD_FLAVOR  'user' | 'ops' | 'dev'（默认 user — 保守）
 *
 * 输出：dist/main.cjs，里面 __BUILD_FLAVOR__ 已被替换成 "user" / "ops" / "dev"。
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

await build({
  entryPoints: [resolve(ROOT, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: resolve(ROOT, 'dist/main.cjs'),
  external: ['electron'],
  define: {
    __BUILD_FLAVOR__: JSON.stringify(flavor),
  },
  // sourcemap helps when packaged-app crashes — keeps stack traces readable
  sourcemap: 'inline',
  // minify only for "user" build to save bundle size; dev needs readable code
  minify: flavor !== 'dev',
})

console.log(`[build-main] dist/main.cjs ready`)
