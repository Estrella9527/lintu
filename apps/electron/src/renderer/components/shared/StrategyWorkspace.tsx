import type { ReactNode } from 'react'

interface StrategyWorkspaceProps {
  /** Step 1: Seed image selector */
  seedSelector?: ReactNode
  /** Step 2: Parameter form */
  parameterForm?: ReactNode
  /** Step 3: Production actions (trial run, full run) */
  productionActions?: ReactNode
  /** Right panel: Task summary */
  taskSummary?: ReactNode
  /** Right panel: Trial preview */
  trialPreview?: ReactNode
}

export function StrategyWorkspace({
  seedSelector,
  parameterForm,
  productionActions,
  taskSummary,
  trialPreview,
}: StrategyWorkspaceProps) {
  return (
    <div className="grid grid-cols-3 gap-6 h-full">
      {/* Left main area (2/3) — three-step config */}
      <div className="col-span-2 space-y-4">
        {/* Step 1: Seed selector */}
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">
            1. 选择种子图
          </h3>
          {seedSelector || (
            <div className="flex items-center justify-center h-24 rounded-md bg-foreground/[0.02] text-[13px] text-foreground/30">
              从覆盖矩阵缺口选择 / 手动从资产库选择 / 按筛选条件选择
            </div>
          )}
        </section>

        {/* Step 2: Parameters */}
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">
            2. 参数配置
          </h3>
          {parameterForm || (
            <div className="flex items-center justify-center h-24 rounded-md bg-foreground/[0.02] text-[13px] text-foreground/30">
              策略参数配置区
            </div>
          )}
        </section>

        {/* Step 3: Production */}
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">
            3. 试产与确认
          </h3>
          {productionActions || (
            <div className="flex items-center justify-center h-16 rounded-md bg-foreground/[0.02] text-[13px] text-foreground/30">
              试产 5 张 → 人工目检 → 全量生产
            </div>
          )}
        </section>
      </div>

      {/* Right panel (1/3) — summary + preview */}
      <div className="col-span-1 space-y-4">
        {/* Task Summary */}
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">
            任务摘要
          </h3>
          {taskSummary || (
            <div className="space-y-2 text-[13px] text-foreground/40">
              <div className="flex justify-between">
                <span>种子图</span>
                <span>—</span>
              </div>
              <div className="flex justify-between">
                <span>策略</span>
                <span>—</span>
              </div>
              <div className="flex justify-between">
                <span>Provider</span>
                <span>—</span>
              </div>
              <div className="flex justify-between">
                <span>预估费用</span>
                <span>—</span>
              </div>
              <div className="flex justify-between">
                <span>预估时长</span>
                <span>—</span>
              </div>
            </div>
          )}
        </section>

        {/* Trial Preview */}
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">
            试产预览
          </h3>
          {trialPreview || (
            <div className="flex items-center justify-center h-40 rounded-md bg-foreground/[0.02] text-[13px] text-foreground/30">
              等待试产
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
