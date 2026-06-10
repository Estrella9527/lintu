import { createStore } from 'jotai'

/**
 * 全局共享的 jotai store(显式实例,传给 main.tsx 的 <Provider>)。
 *
 * 为什么需要它:画布生成是"发射后不管"(1-3 分钟),完成回调可能发生在
 * 组件卸载、甚至用户已切到别的项目之后 —— 此时 hook 里的值是过期快照,
 * 必须通过 store.get/set 读写"实时"状态(当前项目、画布存档),才能把
 * 结果图写回正确的地方而不是静默丢弃。
 */
export const jotaiStore = createStore()
