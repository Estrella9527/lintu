import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  {
    name: 'ratio',
    label: '目标比例',
    type: 'select',
    options: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    default: '16:9',
  },
]

export function CropStrategy() {
  return <StrategyPage taskType="crop" fields={FIELDS} />
}
