import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import { ShieldCheck, Copy, Tags, RotateCw } from 'lucide-react'
import { QualityCheckTab } from './pipeline/QualityCheckTab'
import { DedupTab } from './pipeline/DedupTab'
import { TaggingTab } from './pipeline/TaggingTab'
import { OrientTab } from './pipeline/OrientTab'

const TABS = [
  { id: 'quality-check', label: '质量检查', icon: ShieldCheck, content: <QualityCheckTab /> },
  { id: 'orient', label: '视角纠正', icon: RotateCw, content: <OrientTab /> },
  { id: 'dedup', label: '去重', icon: Copy, content: <DedupTab /> },
  { id: 'tagging', label: '标注', icon: Tags, content: <TaggingTab /> },
]

export default function Pipeline() {
  const [activeTab, setActiveTab] = useState('quality-check')
  return (
    <TabPage title="流水线" tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
  )
}
