import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import {
  Maximize, Leaf, Palette, Scissors, Eye, Zap, Megaphone,
} from 'lucide-react'
import { CropStrategy } from './workshop/CropStrategy'
import { UpscaleStrategy } from './workshop/UpscaleStrategy'
import { PlaceholderStrategy } from './workshop/PlaceholderStrategy'

const STRATEGIES = [
  { id: 'crop', label: '视角裁剪', icon: Eye, content: <CropStrategy /> },
  { id: 'upscale', label: '超分增强', icon: Zap, content: <UpscaleStrategy /> },
  { id: 'outpaint', label: '画布扩展', icon: Maximize, content: <PlaceholderStrategy name="画布扩展" /> },
  { id: 'seasonal', label: '季节变换', icon: Leaf, content: <PlaceholderStrategy name="季节变换" /> },
  { id: 'style', label: '风格变换', icon: Palette, content: <PlaceholderStrategy name="风格变换" /> },
  { id: 'inpaint', label: '局部编辑', icon: Scissors, content: <PlaceholderStrategy name="局部编辑" /> },
  { id: 'marketing', label: '营销素材', icon: Megaphone, content: <PlaceholderStrategy name="营销素材" /> },
]

export default function AIWorkshop() {
  const [activeTab, setActiveTab] = useState('crop')
  return (
    <TabPage
      title="AI工坊"
      tabs={STRATEGIES}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
