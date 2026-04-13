import { StrategyPage } from '@/components/workshop/StrategyPage'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

const FIELDS: FieldConfig[] = [
  { name: 'edit_type', label: '编辑类型', type: 'select', options: ['去水印', '去人物', '换天空', '去文字'], default: '去水印' },
]

export function InpaintStrategy() {
  return <StrategyPage taskType="inpaint" fields={FIELDS} />
}
