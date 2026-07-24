import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Trash2 } from 'lucide-react'

import {
  canvasObjectsAtom, isImageObject, isPlaceholderObject,
  selectedObjectIdAtom,
} from '@/atoms/canvas'
import { activeModuleAtom } from '@/atoms/navigation'
import { workshopModeAtom, workshopBatchDialogAtom } from '@/atoms/workshop'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

import { SaveAsStrategyDialog } from './SaveAsStrategyDialog'

interface PropertyPanelProps {
  /** 把整个 canvas 当前的生成参数快照传进来,用于「存为策略」 */
  canvasSnapshot: Record<string, unknown>
  /** 用户挑了「一键转批量」时回调 — 切到 batch mode 并预填 */
  onTransferToBatch: () => void
}

/**
 * 画布右面板 — PRD §3.7 属性页(语义图层、智能体页留 v0.4)。
 *
 * Phase 1 内容:
 *   - 当前对象的元信息(名称 / 尺寸 / 种子)
 *   - 删除对象按钮
 *   - 页脚:存为策略 / 上传到图库
 *
 * 当画布没选中对象时,显示空态提示。
 */
export function PropertyPanel({ canvasSnapshot, onTransferToBatch }: PropertyPanelProps) {
  const objects = useAtomValue(canvasObjectsAtom)
  const [, setObjects] = useAtom(canvasObjectsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedObjectIdAtom)
  const [, setMode] = useAtom(workshopModeAtom)
  const [, setShowBatch] = useAtom(workshopBatchDialogAtom)
  const [showSave, setShowSave] = useState(false)

  const [, setActiveModule] = useAtom(activeModuleAtom)
  // 选中的对象 — 可能是 image 也可能是 placeholder
  const rawSelected = objects.find((o) => o.id === selectedId) || null
  // 我们的属性页面板只完全展示 image 信息;placeholder 单独显示一个轻量状态(避免 .image_id undefined 之类崩)
  const obj = rawSelected && isImageObject(rawSelected) ? rawSelected : null
  const placeholderObj = rawSelected && isPlaceholderObject(rawSelected) ? rawSelected : null

  const removeObject = () => {
    if (!rawSelected) return
    setObjects((prev) => prev.filter((o) => o.id !== rawSelected.id))
    setSelectedId(null)
  }

  // 画布草稿只有在用户明确点击时才会发布到图库；不再经过审核队列。
  const publishToLibrary = async () => {
    if (!obj) return
    try {
      await api.images.publishToLibrary([obj.image_id])
      toast.success('已上传到图库，压缩完成后将自动同步 OSS', {
        action: {
          label: '去图库',
          onClick: () => setActiveModule('asset-library'),
        },
      })
    } catch (e) {
      toast.error(`上传到图库失败:${(e as Error).message}`)
    }
  }

  return (
    <>
      <aside className="w-[300px] shrink-0 border-l border-foreground/5 bg-background flex flex-col">
        <div className="px-4 py-2.5 h-[40px] border-b border-foreground/5 flex items-center">
          <h3 className="text-[12.5px] font-medium text-foreground/85">属性</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {placeholderObj ? (
            <Section title="生成任务">
              <Row label="状态">
                <span className={cn(
                  'text-[11.5px] font-medium',
                  placeholderObj.status === 'pending' ? 'text-accent' : 'text-destructive',
                )}>
                  {placeholderObj.status === 'pending' ? '生成中…' : '生成失败'}
                </span>
              </Row>
              <Row label="类型">
                <span className="text-foreground/75">{placeholderObj.requestType}</span>
              </Row>
              <Row label="尺寸">
                <span className="text-foreground/75 tabular-nums">
                  {Math.round(placeholderObj.width)} × {Math.round(placeholderObj.height)}
                </span>
              </Row>
              {placeholderObj.errorMessage && (
                <div className="text-[11px] text-destructive bg-destructive/[0.06] rounded-md p-2 mt-1 break-all">
                  {placeholderObj.errorMessage}
                </div>
              )}
              <div className="pt-1">
                <Button
                  variant="outline" size="sm"
                  className="w-full h-7 text-[11.5px] text-destructive border-destructive/20 hover:bg-destructive/10"
                  onClick={removeObject}
                >
                  <Trash2 size={11} className="mr-1.5" /> 移除占位
                </Button>
              </div>
            </Section>
          ) : !obj ? (
            <div className="py-8 text-center text-[11.5px] text-foreground/40 leading-relaxed">
              没有选中对象 ·
              <br />
              点击画布上一张图查看属性
            </div>
          ) : (
            <>
              <Section title="当前对象">
                <Row label="ID">
                  <code className="text-[10.5px] font-mono text-foreground/65">
                    {obj.image_id.slice(0, 12)}…
                  </code>
                </Row>
                <Row label="尺寸">
                  <span className="text-foreground/75 tabular-nums">
                    {Math.round(obj.width)} × {Math.round(obj.height)}
                  </span>
                </Row>
                <Row label="位置">
                  <span className="text-foreground/55 tabular-nums">
                    {Math.round(obj.x)}, {Math.round(obj.y)}
                  </span>
                </Row>
                <div className="pt-1">
                  <Button
                    variant="outline" size="sm"
                    className="w-full h-7 text-[11.5px] text-destructive border-destructive/20 hover:bg-destructive/10"
                    onClick={removeObject}
                  >
                    <Trash2 size={11} className="mr-1.5" /> 从画布移除(资产库保留)
                  </Button>
                </div>
              </Section>

              <Section title="生成参数">
                <div className="text-[11px] text-foreground/55 leading-relaxed">
                  右下角 Prompt 栏 + ContextBar 是真实操作入口;
                  这里只展示当前画布的固化参数,作为「存为策略」的数据源。
                </div>
                <div className="rounded-md bg-foreground/[0.02] border border-foreground/8 p-2 mt-1 space-y-0.5">
                  {Object.entries(canvasSnapshot).slice(0, 5).map(([k, v]) => (
                    <Row key={k} label={k}>
                      <span className="text-foreground/65 truncate max-w-[140px]">
                        {typeof v === 'string' || typeof v === 'number' ? String(v) : '…'}
                      </span>
                    </Row>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-foreground/5 flex gap-2">
          <Button
            variant="outline" size="sm"
            className="flex-1 h-8 text-[12px]"
            disabled={!obj}
            onClick={() => void publishToLibrary()}
            title="将当前选中对象上传到图库（压缩完成后自动同步 OSS）"
          >
            上传到图库
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-[12px]"
            onClick={() => setShowSave(true)}
          >
            存为策略
          </Button>
        </div>
      </aside>

      <SaveAsStrategyDialog
        open={showSave}
        onClose={() => setShowSave(false)}
        canvasSnapshot={canvasSnapshot}
        defaultTaskType="custom"
        onSaved={() => {
          // 给用户一个直达入口:可以立刻去批量 mode 用这条策略
          toast.success('已存为策略,可去批量策略 mode 立即使用', {
            action: { label: '去批量策略', onClick: () => { setMode('batch'); setShowBatch(true) } },
          })
        }}
      />
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] uppercase tracking-wide text-foreground/40 font-medium">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2 text-[11.5px]')}>
      <span className="text-foreground/45">{label}</span>
      <div>{children}</div>
    </div>
  )
}
