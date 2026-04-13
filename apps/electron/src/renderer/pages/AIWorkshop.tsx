import { useState } from 'react'
import { TabPage, type TabConfig } from '@/components/shared/TabPage'
import { StrategyWorkspace } from '@/components/shared/StrategyWorkspace'
import {
  Maximize,
  Leaf,
  Palette,
  Scissors,
  Eye,
  Zap,
  Megaphone,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const STRATEGIES: TabConfig[] = [
  {
    id: 'outpaint',
    label: '画布扩展',
    icon: Maximize,
    content: <StrategyWorkspace />,
  },
  {
    id: 'seasonal',
    label: '季节变换',
    icon: Leaf,
    content: <StrategyWorkspace />,
  },
  {
    id: 'style',
    label: '风格变换',
    icon: Palette,
    content: <StrategyWorkspace />,
  },
  {
    id: 'inpaint',
    label: '局部编辑',
    icon: Scissors,
    content: <StrategyWorkspace />,
  },
  {
    id: 'crop',
    label: '视角裁剪',
    icon: Eye,
    content: <StrategyWorkspace />,
  },
  {
    id: 'upscale',
    label: '超分增强',
    icon: Zap,
    content: <StrategyWorkspace />,
  },
  {
    id: 'marketing',
    label: '营销素材',
    icon: Megaphone,
    content: <StrategyWorkspace />,
  },
]

export default function AIWorkshop() {
  const [activeTab, setActiveTab] = useState('outpaint')
  return (
    <TabPage
      title="AI工坊"
      tabs={STRATEGIES}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      actions={
        <Button variant="outline" size="sm" className="text-[12px] h-7">
          + 新建任务
        </Button>
      }
    />
  )
}
