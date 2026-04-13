import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  { name: 'style', label: '风格', type: 'select', options: ['水彩', '油画', '素描', '复古', '高对比', '柔焦'], default: '水彩' },
]

export function StyleStrategy() {
  return <StrategyPage taskType="style" fields={FIELDS} />
}
