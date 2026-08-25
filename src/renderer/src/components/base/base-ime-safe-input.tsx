import { Input, InputProps } from '@heroui/react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * IME 安全的文本输入框。
 *
 * 为什么需要它：
 *   出口配置这类输入框是「完全受控 + 每次按键走异步 IPC 往返」的结构：
 *     onValueChange -> patchAppConfig -> IPC 写盘 -> 广播 appConfigUpdated
 *     -> SWR mutate 重新拉配置 -> value 回灌 -> React 重设 input 的 DOM value
 *
 *   中文/日文/韩文输入法在提交前会维持一个未完成的 composition 会话。上面这条链路
 *   每敲一个字母就会把 DOM value 重设一次，composition 会话被打断、拼音缓冲区清空，
 *   导致中文根本输不进去（英文不走 IME 所以无感）。
 *
 * 做法（与 base/collapse-input.tsx 既有实现保持一致）：
 *   1. 用本地 state 承接键入，输入过程中不受外部回灌影响；
 *   2. composition 进行中不向外抛值，避免半成品拼音触发配置写盘；
 *   3. composition 结束时抛一次最终值；
 *   4. 外部 value 变化只在非 composition 期间同步进来。
 *
 * 注意：仅用于自由文本输入。type=number 的端口/个数等输入框不经过 IME，无需替换。
 */
interface IMESafeInputProps extends Omit<InputProps, 'onValueChange' | 'onChange'> {
  onValueChange?: (value: string) => void
}

const IMESafeInput: React.FC<IMESafeInputProps> = (props) => {
  const { value, onValueChange, ...inputProps } = props
  const isComposingRef = useRef(false)
  const [localValue, setLocalValue] = useState<string>((value as string) ?? '')

  // 同步外部 value：composition 进行中必须跳过，否则会打断输入法
  useEffect(() => {
    if (!isComposingRef.current) {
      setLocalValue((value as string) ?? '')
    }
  }, [value])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value
      setLocalValue(next)
      // composition 期间不外抛，等 compositionend 再统一提交
      if (!isComposingRef.current) {
        onValueChange?.(next)
      }
    },
    [onValueChange]
  )

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false
      const next = e.currentTarget.value
      setLocalValue(next)
      onValueChange?.(next)
    },
    [onValueChange]
  )

  return (
    <Input
      {...inputProps}
      value={localValue}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  )
}

export default IMESafeInput
