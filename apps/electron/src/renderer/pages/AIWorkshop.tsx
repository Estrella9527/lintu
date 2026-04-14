import { useState, useEffect } from 'react'
import { useAtom } from 'jotai'
import { TabPage } from '@/components/shared/TabPage'
import { Maximize, Leaf, Palette, Scissors, Eye, Zap, Megaphone } from 'lucide-react'
import { workshopPresetAtom } from '@/atoms/workshop'
import { CropStrategy } from './workshop/CropStrategy'
import { UpscaleStrategy } from './workshop/UpscaleStrategy'
import { OutpaintStrategy } from './workshop/OutpaintStrategy'
import { SeasonalStrategy } from './workshop/SeasonalStrategy'
import { StyleStrategy } from './workshop/StyleStrategy'
import { InpaintStrategy } from './workshop/InpaintStrategy'
import { MarketingStrategy } from './workshop/MarketingStrategy'

const STRATEGIES = [
  { id: 'outpaint', label: '画布扩展', icon: Maximize, content: <OutpaintStrategy /> },
  { id: 'seasonal', label: '季节变换', icon: Leaf, content: <SeasonalStrategy /> },
  { id: 'style', label: '风格变换', icon: Palette, content: <StyleStrategy /> },
  { id: 'inpaint', label: '局部编辑', icon: Scissors, content: <InpaintStrategy /> },
  { id: 'crop', label: '视角裁剪', icon: Eye, content: <CropStrategy /> },
  { id: 'upscale', label: '超分增强', icon: Zap, content: <UpscaleStrategy /> },
  { id: 'marketing', label: '营销素材', icon: Megaphone, content: <MarketingStrategy /> },
]

export default function AIWorkshop() {
  const [activeTab, setActiveTab] = useState('outpaint')
  const [preset, setPreset] = useAtom(workshopPresetAtom)

  // When preset arrives from CoverageMatrix, switch to the right tab
  useEffect(() => {
    if (preset) {
      setActiveTab(preset.strategy)
    }
  }, [preset])

  return (
    <TabPage title="AI工坊" tabs={STRATEGIES} activeTab={activeTab} onTabChange={setActiveTab} />
  )
}
