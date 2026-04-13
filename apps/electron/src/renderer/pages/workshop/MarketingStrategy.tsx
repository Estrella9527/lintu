import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  { name: 'template', label: '模板', type: 'select', options: ['小红书封面', '朋友圈分享', 'OTA详情页', '宣传海报'], default: '小红书封面' },
  { name: 'text', label: '文案', type: 'input', placeholder: '输入叠加文案（可选）', default: '' },
]

export function MarketingStrategy() {
  return <StrategyPage taskType="marketing" fields={FIELDS} />
}
