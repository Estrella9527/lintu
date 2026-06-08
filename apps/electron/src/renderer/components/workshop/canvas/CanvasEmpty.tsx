import { FolderOpen, ImagePlus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface CanvasEmptyProps {
  onPickFromLibrary?: () => void
}

/**
 * 空态:画布上没有任何对象时显示。
 * PRD §6.2 要求每个数据组件都要有空态;画布空态承担"起步引导"角色。
 *
 * 提供三条入口提示:
 *   1. 直接拖入 / 粘贴本机图片(交互由 useImageDropPaste 完成,这里只文字提示)
 *   2. 从资产库挑(单击按钮打开 SeedPickerDialog)
 *   3. (PR-6 上线后) 文生图 — 暂时只文字提到 Prompt 栏
 *
 * 注意:wrapper 是 pointer-events-none 让 drop 事件穿透;但内层 Button 重新
 * 启用 pointer-events 才能点。
 */
export function CanvasEmpty({ onPickFromLibrary }: CanvasEmptyProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl
                      bg-primary/8 ring-1 ring-foreground/5">
        <ImagePlus size={26} strokeWidth={1.4} className="text-primary" />
      </div>
      <div className="text-[13.5px] font-medium text-foreground/80">从一张图开始</div>
      <div className="text-[11.5px] text-foreground/45 leading-relaxed max-w-xs">
        直接把本机图片拖入画布(或 Ctrl+V 粘贴截图)— 也可以从资产库挑现有图
      </div>
      {onPickFromLibrary && (
        <div className="pointer-events-auto mt-1">
          <Button
            variant="outline" size="sm"
            className="h-7 text-[12px]"
            onClick={onPickFromLibrary}
          >
            <FolderOpen size={12} className="mr-1.5" />
            从资产库选择
          </Button>
        </div>
      )}
      <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] text-foreground/35">
        <Sparkles size={10} /> 选中图片后会浮出 AI 操作栏
      </div>
    </div>
  )
}
