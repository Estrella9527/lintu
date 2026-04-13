import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  {
    name: 'scale',
    label: '放大倍率',
    type: 'select',
    options: ['2', '3', '4'],
    default: '2',
  },
]

export function UpscaleStrategy() {
  return <StrategyPage taskType="upscale" fields={FIELDS} />
}
