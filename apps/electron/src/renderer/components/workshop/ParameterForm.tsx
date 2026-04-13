import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

export interface FieldConfig {
  name: string
  label: string
  type: 'select' | 'slider' | 'input' | 'number'
  options?: string[]
  min?: number
  max?: number
  step?: number
  default?: string | number
  placeholder?: string
}

interface ParameterFormProps {
  fields: FieldConfig[]
  values: Record<string, any>
  onChange: (values: Record<string, any>) => void
}

export function ParameterForm({ fields, values, onChange }: ParameterFormProps) {
  const update = (name: string, val: any) => onChange({ ...values, [name]: val })

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <label className="text-[12px] text-foreground/50">
            {field.label}
            {field.type === 'slider' && (
              <span className="ml-2 text-foreground/70">{values[field.name] ?? field.default}</span>
            )}
          </label>

          {field.type === 'select' && (
            <Select
              value={String(values[field.name] ?? field.default ?? '')}
              onValueChange={(v) => update(field.name, v)}
            >
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((opt) => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {field.type === 'slider' && (
            <Slider
              value={[Number(values[field.name] ?? field.default ?? field.min ?? 0)]}
              onValueChange={([v]) => update(field.name, v)}
              min={field.min ?? 0}
              max={field.max ?? 100}
              step={field.step ?? 1}
            />
          )}

          {field.type === 'input' && (
            <Input
              value={String(values[field.name] ?? field.default ?? '')}
              onChange={(e) => update(field.name, e.target.value)}
              placeholder={field.placeholder}
              className="h-8 text-[13px]"
            />
          )}

          {field.type === 'number' && (
            <Input
              type="number"
              value={String(values[field.name] ?? field.default ?? '')}
              onChange={(e) => update(field.name, parseFloat(e.target.value) || 0)}
              min={field.min}
              max={field.max}
              step={field.step}
              className="h-8 text-[13px]"
            />
          )}
        </div>
      ))}
    </div>
  )
}
