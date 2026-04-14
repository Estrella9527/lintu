import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAtom, useAtomValue } from 'jotai'
import { api } from '@/lib/api'
import { activeModuleAtom } from '@/atoms/navigation'
import { activeProjectIdAtom } from '@/atoms/project'
import { workshopPresetAtom } from '@/atoms/workshop'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { MatrixCell } from '@/lib/types'

const DIMENSIONS = [
  { id: 'season', label: '季节' },
  { id: 'scene', label: '场景' },
  { id: 'weather', label: '天气' },
  { id: 'angle', label: '角度' },
  { id: 'people', label: '人物' },
]

export default function CoverageMatrix() {
  const [rowDim, setRowDim] = useState('season')
  const [colDim, setColDim] = useState('scene')
  const [, setActiveModule] = useAtom(activeModuleAtom)
  const [, setWorkshopPreset] = useAtom(workshopPresetAtom)
  const projectId = useAtomValue(activeProjectIdAtom) || ''

  const { data, isLoading } = useQuery({
    queryKey: ['matrix', projectId, rowDim, colDim],
    queryFn: () => api.matrix.get({ project_id: projectId, row: rowDim, col: colDim }),
    enabled: !!projectId,
  })

  const cellMap = useMemo(() => {
    if (!data) return new Map<string, MatrixCell>()
    const map = new Map<string, MatrixCell>()
    data.cells.forEach((c) => map.set(`${c.row}:${c.col}`, c))
    return map
  }, [data])

  if (!projectId) {
    return (
      <div className="p-6">
        <h1 className="text-[15px] font-semibold text-foreground mb-6">覆盖矩阵</h1>
        <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30">
          请先在流水线中选择目录以创建项目
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[15px] font-semibold text-foreground">覆盖矩阵</h1>

        {/* Dimension selectors */}
        <div className="flex items-center gap-3 text-[13px]">
          <span className="text-foreground/50">行:</span>
          <Select value={rowDim} onValueChange={setRowDim}>
            <SelectTrigger className="w-24 h-8 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSIONS.filter((d) => d.id !== colDim).map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-foreground/50">列:</span>
          <Select value={colDim} onValueChange={setColDim}>
            <SelectTrigger className="w-24 h-8 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSIONS.filter((d) => d.id !== rowDim).map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="h-64 rounded-lg bg-foreground/[0.02] animate-pulse" />
      ) : (
        <>
          {/* Summary */}
          <div className="flex gap-4 text-[12px]">
            <span className="text-foreground/50">
              共 {data.summary.total_cells} 个单元格
            </span>
            <span className="text-destructive">
              P0 缺口: {data.summary.p0_gaps}
            </span>
            <span className="text-info">
              P1 待补: {data.summary.p1_gaps}
            </span>
          </div>

          {/* Heatmap table */}
          <div className="rounded-lg border border-foreground/5 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="p-2 text-[11px] text-foreground/40 text-left border-b border-foreground/5 bg-foreground/[0.02] sticky left-0">
                    {DIMENSIONS.find((d) => d.id === rowDim)?.label} ↓ \{' '}
                    {DIMENSIONS.find((d) => d.id === colDim)?.label} →
                  </th>
                  {data.col_values.map((c) => (
                    <th key={c} className="p-2 text-[11px] text-foreground/50 font-normal border-b border-foreground/5 bg-foreground/[0.02] min-w-[72px]">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.row_values.map((r) => (
                  <tr key={r}>
                    <td className="p-2 text-[11px] text-foreground/60 font-medium border-b border-foreground/5 bg-foreground/[0.01] sticky left-0">
                      {r}
                    </td>
                    {data.col_values.map((c) => {
                      const cell = cellMap.get(`${r}:${c}`)
                      const count = cell?.count ?? 0
                      const priority = cell?.priority ?? 'P0'
                      return (
                        <td
                          key={c}
                          className={cn(
                            'p-0 text-center border-b border-foreground/5 cursor-pointer transition-opacity hover:opacity-80',
                          )}
                          onClick={() => {
                            // Navigate to AI Workshop with preset
                            let strategy = 'seasonal'
                            let params: Record<string, any> = {}
                            let seedFilter: any = {}

                            if (rowDim === 'season') {
                              strategy = 'seasonal'
                              params = { season: r }
                              seedFilter = { scene: c }
                            } else if (colDim === 'season') {
                              strategy = 'seasonal'
                              params = { season: c }
                              seedFilter = { scene: r }
                            } else {
                              strategy = 'outpaint'
                            }

                            setWorkshopPreset({ strategy, params, seedFilter })
                            setActiveModule('ai-workshop')
                          }}
                        >
                          <div
                            className={cn(
                              'aspect-square flex items-center justify-center min-h-[48px]',
                              priority === 'P0' && count === 0 && 'bg-foreground/[0.02]',
                              priority === 'P0' && count > 0 && 'bg-destructive/15',
                              priority === 'P1' && 'bg-info/15',
                              priority === 'P2' && 'bg-success/15',
                            )}
                          >
                            <span
                              className={cn(
                                'text-[12px] tabular-nums',
                                priority === 'P0' && count > 0 && 'text-destructive font-medium',
                                priority === 'P0' && count === 0 && 'text-foreground/15',
                                priority === 'P1' && 'text-info',
                                priority === 'P2' && 'text-success',
                              )}
                            >
                              {count}
                            </span>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-[11px] text-foreground/40">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-destructive/15 border border-destructive/20" />
              P0 (&lt;50张)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-info/15 border border-info/20" />
              P1 (&lt;200张)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-success/15 border border-success/20" />
              P2 (≥200张)
            </span>
          </div>

          {/* Suggestions */}
          {data.summary.suggestions.length > 0 && (
            <div className="rounded-lg border border-foreground/5 p-4">
              <h3 className="text-[13px] font-medium text-foreground/60 mb-3">生产建议</h3>
              <div className="space-y-2">
                {data.summary.suggestions.map((s) => (
                  <div
                    key={s.gap}
                    className="flex items-center justify-between py-1.5 text-[12px] border-b border-foreground/[0.03] last:border-0"
                  >
                    <div>
                      <span className="text-foreground/70 font-medium">{s.gap}</span>
                      <span className="text-foreground/40 ml-2">当前 {s.current} 张</span>
                    </div>
                    <span className="text-foreground/40">{s.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
