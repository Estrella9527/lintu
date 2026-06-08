import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Cloud, Folder, FolderOpen } from 'lucide-react'
import type { OssDirNode } from '@/lib/api'

/**
 * OSS 图库左侧目录树 —— 按 object key 前缀分组,视觉对齐资产库的 FolderTree。
 * 数据来自 /oss-library/scan 的 dirs。selected: null=全部目录;否则该目录精确值。
 */

interface TreeNodeData {
  label: string
  fullPath: string
  count: number       // 本目录直接对象数(精确)
  orphans: number     // 本目录库外数
  totalCount: number  // 含子目录
  children: TreeNodeData[]
}

function buildTree(dirs: OssDirNode[]): TreeNodeData {
  const root: TreeNodeData = { label: '', fullPath: '', count: 0, orphans: 0, totalCount: 0, children: [] }
  const byPath = new Map<string, TreeNodeData>([['', root]])
  for (const { folder, count, orphans } of dirs) {
    if (folder === '') { root.count = count; root.orphans = orphans; continue }
    const segs = folder.split('/')
    let cursor = root
    let acc = ''
    for (let i = 0; i < segs.length; i++) {
      acc = i === 0 ? segs[0] : `${acc}/${segs[i]}`
      let node = byPath.get(acc)
      if (!node) {
        node = { label: segs[i], fullPath: acc, count: 0, orphans: 0, totalCount: 0, children: [] }
        byPath.set(acc, node)
        cursor.children.push(node)
      }
      cursor = node
    }
    cursor.count = count
    cursor.orphans = orphans
  }
  const total = (n: TreeNodeData): number => {
    n.totalCount = n.count
    for (const c of n.children) n.totalCount += total(c)
    return n.totalCount
  }
  total(root)
  const sort = (n: TreeNodeData) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label, 'zh', { numeric: true }))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

export function OssFolderTree({ dirs, selected, onSelect }: {
  dirs: OssDirNode[]
  selected: string | null
  onSelect: (folder: string | null) => void
}) {
  const root = useMemo(() => buildTree(dirs), [dirs])
  const grandTotal = useMemo(() => dirs.reduce((s, d) => s + d.count, 0), [dirs])

  return (
    <div className="space-y-0.5 text-[12px]">
      <Row label="全部对象" count={grandTotal} active={selected === null} depth={0} leaf
        onClick={() => onSelect(null)} icon={<Cloud size={13} className="text-foreground/45" />} />
      {root.count > 0 && (
        <Row label="根目录" count={root.count} active={selected === ''} depth={0} leaf
          onClick={() => onSelect('')} icon={<Folder size={13} className="text-foreground/45" />} />
      )}
      {root.children.map((c) => (
        <Node key={c.fullPath} node={c} selected={selected} onSelect={onSelect} depth={0} />
      ))}
      {root.children.length === 0 && root.count === 0 && (
        <p className="text-[11px] text-foreground/35 px-2 py-2">bucket 里暂无对象</p>
      )}
    </div>
  )
}

function Node({ node, selected, onSelect, depth }: {
  node: TreeNodeData; selected: string | null; onSelect: (p: string) => void; depth: number
}) {
  const [expanded, setExpanded] = useState(depth === 0)
  const hasChildren = node.children.length > 0
  return (
    <div>
      <Row
        label={node.label} count={node.totalCount} orphans={node.orphans}
        active={selected === node.fullPath} depth={depth}
        hasChildren={hasChildren} expanded={expanded}
        onToggleExpand={hasChildren ? () => setExpanded((v) => !v) : undefined}
        onClick={() => onSelect(node.fullPath)}
      />
      {hasChildren && expanded && node.children.map((c) => (
        <Node key={c.fullPath} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} />
      ))}
    </div>
  )
}

function Row({
  label, count, orphans, active, depth, hasChildren, expanded, leaf, onClick, onToggleExpand, icon,
}: {
  label: string; count: number; orphans?: number; active: boolean; depth: number
  hasChildren?: boolean; expanded?: boolean; leaf?: boolean
  onClick: () => void; onToggleExpand?: () => void; icon?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn('w-full group flex items-center gap-1 px-1.5 py-1 rounded text-left transition-colors',
        active ? 'bg-accent/10 text-accent' : 'text-foreground/70 hover:bg-foreground/[0.03]')}
      style={{ paddingLeft: `${depth * 10 + 6}px` }}
    >
      {hasChildren ? (
        <span onClick={(e) => { e.stopPropagation(); onToggleExpand?.() }}
          className="shrink-0 text-foreground/40 hover:text-foreground/70">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      ) : <span className="w-3 shrink-0" />}
      {icon ?? (hasChildren && expanded
        ? <FolderOpen size={13} className={cn(active ? 'text-accent' : 'text-foreground/45')} />
        : <Folder size={13} className={cn(active ? 'text-accent' : 'text-foreground/45')} />)}
      <span className="truncate flex-1">{label}</span>
      {orphans != null && orphans > 0 && (
        <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0" title={`${orphans} 张库外`}>
          {orphans.toLocaleString()}
        </span>
      )}
      <span className={cn('text-[10px] tabular-nums shrink-0', active ? 'text-accent/80' : 'text-foreground/35')}>
        {count.toLocaleString()}
      </span>
    </button>
  )
}
