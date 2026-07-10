import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Image as ImageIcon, Pencil } from 'lucide-react'
import { useState } from 'react'

interface FolderNode {
  label: string         // display name of this segment
  fullPath: string      // full relative_dir ("" = root)
  count: number         // direct image count (exact match on relative_dir)
  totalCount: number    // including subfolders
  children: FolderNode[]
}

interface FolderTreeProps {
  projectId: string
  selected: string | null            // null = 全部；"" = 根；"xxx" = specific folder
  onSelect: (path: string | null) => void
  /** 与网格一致的资产库成员过滤;true=只数已入库,保证文件夹数字和网格张数对得上 */
  inLibrary?: boolean
}

/** Build a folder tree from the flat [{folder, count}] list. */
function buildTree(rows: { folder: string; count: number }[]): FolderNode {
  const root: FolderNode = { label: '', fullPath: '', count: 0, totalCount: 0, children: [] }
  const nodeByPath = new Map<string, FolderNode>([['', root]])

  for (const { folder, count } of rows) {
    if (folder === '') {
      root.count = count
      continue
    }
    const segments = folder.split('/')
    let cursor: FolderNode = root
    let accumulated = ''
    for (let i = 0; i < segments.length; i++) {
      accumulated = i === 0 ? segments[0] : `${accumulated}/${segments[i]}`
      let node = nodeByPath.get(accumulated)
      if (!node) {
        node = {
          label: segments[i],
          fullPath: accumulated,
          count: 0,
          totalCount: 0,
          children: [],
        }
        nodeByPath.set(accumulated, node)
        cursor.children.push(node)
      }
      cursor = node
    }
    cursor.count = count
  }

  // Compute totals with DFS post-order
  const computeTotal = (n: FolderNode): number => {
    n.totalCount = n.count
    for (const c of n.children) n.totalCount += computeTotal(c)
    return n.totalCount
  }
  computeTotal(root)

  // Sort children by label, natural order
  const sortNode = (n: FolderNode) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label, 'zh', { numeric: true }))
    n.children.forEach(sortNode)
  }
  sortNode(root)

  return root
}

export function FolderTree({ projectId, selected, onSelect, inLibrary }: FolderTreeProps) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['image-folders', projectId, inLibrary],
    queryFn: () => api.images.listFolders(projectId, undefined, inLibrary),
    refetchInterval: 10_000,
    enabled: !!projectId,
  })

  const renameMut = useMutation({
    mutationFn: ({ oldFolder, newFolder }: { oldFolder: string; newFolder: string }) =>
      api.images.renameFolder(projectId, oldFolder, newFolder),
    onSuccess: (d) => {
      toast.success(`已重命名文件夹（${d.updated} 张图）`)
      qc.invalidateQueries({ queryKey: ['image-folders'] })
      qc.invalidateQueries({ queryKey: ['images'] })
    },
    onError: (e: any) => toast.error(e?.message || '重命名失败'),
  })

  const handleRename = (fullPath: string) => {
    // 只改这一层的名字(末段),保留父路径;后端按前缀连子文件夹一起改。
    const segs = fullPath.split('/')
    const cur = segs[segs.length - 1]
    const next = window.prompt(`重命名文件夹「${cur}」为：`, cur)
    if (!next || !next.trim() || next.trim() === cur) return
    segs[segs.length - 1] = next.trim()
    renameMut.mutate({ oldFolder: fullPath, newFolder: segs.join('/') })
  }

  const root = useMemo(() => buildTree(data ?? []), [data])
  const grandTotal = useMemo(
    () => (data ?? []).reduce((s, r) => s + r.count, 0),
    [data],
  )

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-6 rounded bg-foreground/[0.04] animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-0.5 text-[12px]">
      <FolderRow
        label="全部图片"
        count={grandTotal}
        active={selected === null}
        depth={0}
        leaf
        onClick={() => onSelect(null)}
        icon={<ImageIcon size={13} className="text-foreground/45" />}
      />
      {root.count > 0 && (
        <FolderRow
          label="根目录（未分组）"
          count={root.count}
          active={selected === ''}
          depth={0}
          leaf
          onClick={() => onSelect('')}
          icon={<Folder size={13} className="text-foreground/45" />}
        />
      )}
      {root.children.map((child) => (
        <TreeNode
          key={child.fullPath}
          node={child}
          selected={selected}
          onSelect={onSelect}
          onRename={handleRename}
          depth={0}
        />
      ))}
      {root.children.length === 0 && root.count === 0 && (
        <p className="text-[11px] text-foreground/35 px-2 py-2">
          还没有图片。在流水线里选择一个包含子文件夹的目录扫描。
        </p>
      )}
    </div>
  )
}

function TreeNode({ node, selected, onSelect, onRename, depth }: {
  node: FolderNode
  selected: string | null
  onSelect: (path: string) => void
  onRename: (fullPath: string) => void
  depth: number
}) {
  const [expanded, setExpanded] = useState(depth === 0)  // top-level expanded by default
  const hasChildren = node.children.length > 0
  const isSelected = selected === node.fullPath

  return (
    <div>
      <FolderRow
        label={node.label}
        count={node.totalCount}
        active={isSelected}
        depth={depth}
        hasChildren={hasChildren}
        expanded={expanded}
        onToggleExpand={hasChildren ? () => setExpanded((v) => !v) : undefined}
        onClick={() => onSelect(node.fullPath)}
        onRename={() => onRename(node.fullPath)}
      />
      {hasChildren && expanded && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.fullPath}
              node={c}
              selected={selected}
              onSelect={onSelect}
              onRename={onRename}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FolderRow({
  label, count, active, depth, hasChildren, expanded, leaf,
  onClick, onToggleExpand, onRename, icon,
}: {
  label: string
  count: number
  active: boolean
  depth: number
  hasChildren?: boolean
  expanded?: boolean
  leaf?: boolean
  onClick: () => void
  onToggleExpand?: () => void
  onRename?: () => void
  icon?: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'w-full group flex items-center gap-1 px-1.5 py-1 rounded text-left transition-colors cursor-pointer',
        active
          ? 'bg-accent/10 text-accent'
          : 'text-foreground/70 hover:bg-foreground/[0.03]',
      )}
      style={{ paddingLeft: `${depth * 10 + 6}px` }}
    >
      {hasChildren ? (
        <span
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.() }}
          className="shrink-0 text-foreground/40 hover:text-foreground/70"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      ) : leaf ? (
        <span className="w-3 shrink-0" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {icon ?? (
        hasChildren && expanded ? (
          <FolderOpen size={13} className={cn(active ? 'text-accent' : 'text-foreground/45')} />
        ) : (
          <Folder size={13} className={cn(active ? 'text-accent' : 'text-foreground/45')} />
        )
      )}
      <span className="truncate flex-1">{label}</span>
      {onRename && (
        <span
          onClick={(e) => { e.stopPropagation(); onRename() }}
          title="重命名文件夹"
          className="shrink-0 opacity-0 group-hover:opacity-100 text-foreground/35 hover:text-accent transition-opacity"
        >
          <Pencil size={11} />
        </span>
      )}
      <span className={cn(
        'text-[10px] tabular-nums shrink-0',
        active ? 'text-accent/80' : 'text-foreground/35',
      )}>
        {count.toLocaleString()}
      </span>
    </div>
  )
}
