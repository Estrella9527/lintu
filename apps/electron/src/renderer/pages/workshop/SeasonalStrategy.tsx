import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  { name: 'season', label: '目标季节', type: 'select', options: ['春季', '夏季', '秋季', '冬季'], default: '秋季' },
]

export function SeasonalStrategy() {
  return <StrategyPage taskType="seasonal" fields={FIELDS} />
}
