import { useEffect } from 'react'
import { useAtom } from 'jotai'
import { BookText, LineChart, Settings as SettingsIcon, Sparkles } from 'lucide-react'

import { TabPage } from '@/components/shared/TabPage'
import { matchLabNavRequestAtom } from '@/atoms/navigation'
import { matchLabActiveTabAtom } from '@/atoms/ui-state'
import { MatchPlaygroundTab } from '@/components/asset-library/MatchPlaygroundTab'
import { MatchAnalyticsTab } from '@/components/distribution/MatchAnalyticsTab'
import { SynonymsTab } from '@/components/match-lab/SynonymsTab'
import { MatchStrategyTab } from '@/components/match-lab/MatchStrategyTab'

/**
 * 匹配实验室 — 集中管理 文图匹配 (text→image) 的全套调试 + 调优工作流：
 *   - 试匹配：直接打 /open-api/v1/images/match，临时调权重 + 候选源做对比测试
 *   - 匹配策略：上线前的运营配置 — 排序权重 + 候选源默认，UGC 调用时自动应用
 *               （原 设置→匹配策略 + 默认策略，2026-05-07 整合到这一个 Tab）
 *   - 匹配分析：调用量、命中率、p95 延迟、未命中 query top
 *   - 同义词：alias → canonical 词典，影响 jieba 分词前的归一化
 *
 * 评估集 (eval_dataset.json) tab 暂不做。
 */
export default function MatchLab() {
  const [activeTab, setActiveTab] = useAtom(matchLabActiveTabAtom)
  const [navRequest, setNavRequest] = useAtom(matchLabNavRequestAtom)

  // Apply external deep-link (e.g. analytics card → playground 复跑) once.
  useEffect(() => {
    if (!navRequest) return
    if (navRequest.tab) setActiveTab(navRequest.tab)
    setNavRequest(null)
  }, [navRequest, setNavRequest, setActiveTab])

  const TABS = [
    {
      id: 'playground',
      label: '试匹配',
      icon: Sparkles,
      content: <MatchPlaygroundTab />,
    },
    {
      id: 'default-strategy',
      label: '匹配策略',
      icon: SettingsIcon,
      content: <MatchStrategyTab />,
    },
    {
      id: 'analytics',
      label: '匹配分析',
      icon: LineChart,
      content: <MatchAnalyticsTab />,
    },
    {
      id: 'synonyms',
      label: '同义词',
      icon: BookText,
      content: <SynonymsTab />,
    },
  ]

  return (
    <TabPage
      title="匹配实验室"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
