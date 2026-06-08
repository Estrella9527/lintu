import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

const STORAGE_KEY = 'lintu_onboarding_done'

/** 已完成 / 跳过过引导。一旦置 true 就不再自动弹出（设置→关于可手动重看）。 */
export const onboardingDoneAtom = atomWithStorage<boolean>(STORAGE_KEY, false, undefined, {
  getOnInit: true,
})

/** 命令式触发引导显示 — 从「重新观看引导」按钮 set true 来强制弹出，
 *  组件关闭时再 set false。与 onboardingDone 解耦：done=true 也能再次手动看。 */
export const onboardingForceOpenAtom = atom<boolean>(false)
