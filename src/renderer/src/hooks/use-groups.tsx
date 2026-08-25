import React, { createContext, useContext, ReactNode } from 'react'
import useSWR, { KeyedMutator } from 'swr'
import { mihomoGroups } from '@renderer/utils/ipc'

interface GroupsContextType {
  groups: IMihomoMixedGroup[] | undefined
  mutate: KeyedMutator<IMihomoMixedGroup[]>
}

const GroupsContext = createContext<GroupsContextType | undefined>(undefined)

export const GroupsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // 必须用箭头函数显式无参调用 mihomoGroups()，不能把它裸传给 useSWR。
  // SWR 会把 key 作为第一个实参传给 fetcher，写成 useSWR('mihomoGroups', mihomoGroups)
  // 实际执行的是 mihomoGroups('mihomoGroups') —— 非空字符串是 truthy，
  // includeHidden 被意外置为 true，导致 hidden 策略组全部泄露到代理页面。
  const { data: groups, mutate } = useSWR<IMihomoMixedGroup[]>(
    'mihomoGroups',
    () => mihomoGroups(),
    {
      errorRetryInterval: 200,
      errorRetryCount: 10,
      refreshInterval: 30000,
      dedupingInterval: 5000,
      keepPreviousData: true,
      revalidateOnFocus: false
    }
  )

  React.useEffect(() => {
    const handler = (): void => {
      mutate()
    }
    window.electron.ipcRenderer.on('groupsUpdated', handler)
    return (): void => {
      window.electron.ipcRenderer.removeListener('groupsUpdated', handler)
    }
  }, [mutate])

  return <GroupsContext.Provider value={{ groups, mutate }}>{children}</GroupsContext.Provider>
}

export const useGroups = (): GroupsContextType => {
  const context = useContext(GroupsContext)
  if (context === undefined) {
    throw new Error('useGroups must be used within an GroupsProvider')
  }
  return context
}
