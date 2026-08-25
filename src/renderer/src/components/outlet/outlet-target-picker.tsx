import {
  Button,
  Checkbox,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tooltip
} from '@heroui/react'
import IMESafeInput from '@renderer/components/base/base-ime-safe-input'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IoMdArrowDown, IoMdArrowUp, IoMdClose } from 'react-icons/io'
import { Virtuoso } from 'react-virtuoso'

interface Props {
  title: string
  /** 可选目标：策略组名 + 节点名 */
  options: string[]
  /** 当前已选，顺序即对应顺序 */
  value: string[]
  /**
   * 需要按顺序 1:1 对应的槽位名（批量出口的 test01~test10）。
   * 传入时右侧会显示「槽位 → 目标」，并按槽位数量提示是否选够。
   */
  slotLabels?: string[]
  onConfirm: (next: string[]) => void
  onClose: () => void
}

/**
 * 出口目标选择器：支持关键字筛选、一键全选筛选结果，并保留选择顺序。
 *
 * 顺序很关键：批量出口的第 i 个端口用第 i 个目标，所以这里不能用 Set 存选中项。
 */
const OutletTargetPicker: React.FC<Props> = (props) => {
  const { title, options, value, slotLabels, onConfirm, onClose } = props
  const { t } = useTranslation()
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string[]>(() =>
    value.filter((item, index) => value.indexOf(item) === index)
  )

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return options
    return options.filter((name) => name.toLowerCase().includes(kw))
  }, [keyword, options])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (name: string): void => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((i) => i !== name) : [...prev, name]))
  }

  /** 全选筛选结果：按当前列表顺序追加尚未选中的项，已选顺序保持不变 */
  const selectFiltered = (): void => {
    setSelected((prev) => {
      const exists = new Set(prev)
      return [...prev, ...filtered.filter((name) => !exists.has(name))]
    })
  }

  const unselectFiltered = (): void => {
    const inFilter = new Set(filtered)
    setSelected((prev) => prev.filter((name) => !inFilter.has(name)))
  }

  const move = (index: number, offset: number): void => {
    setSelected((prev) => {
      const next = [...prev]
      const target = index + offset
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const slotCount = slotLabels?.length ?? 0
  const countMismatch = slotCount > 0 && selected.length !== slotCount

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      size="3xl"
      hideCloseButton
      isOpen={true}
      onOpenChange={onClose}
      scrollBehavior="inside"
    >
      <ModalContent className="h-full max-h-[80vh]">
        <ModalHeader className="flex pb-0 app-drag">{title}</ModalHeader>
        <ModalBody className="h-full">
          <div className="flex gap-4 h-full min-h-0">
            <div className="w-1/2 flex flex-col min-h-0 gap-2">
              <IMESafeInput
                size="sm"
                isClearable
                value={keyword}
                placeholder={t('outlet.picker.searchPlaceholder')}
                onValueChange={setKeyword}
                onClear={() => setKeyword('')}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="flat" color="primary" onPress={selectFiltered}>
                  {t('outlet.picker.selectFiltered', { num: filtered.length })}
                </Button>
                <Button size="sm" variant="flat" onPress={unselectFiltered}>
                  {t('outlet.picker.unselectFiltered')}
                </Button>
              </div>
              <div className="flex-1 min-h-0 border border-divider rounded-lg px-2 py-1">
                {filtered.length === 0 ? (
                  <div className="text-center text-foreground-500 py-4 text-sm">
                    {t('outlet.picker.noMatch')}
                  </div>
                ) : (
                  <Virtuoso
                    style={{ height: '100%' }}
                    data={filtered}
                    computeItemKey={(_index, name) => name}
                    itemContent={(_index, name) => (
                      <div className="py-1">
                        <Checkbox
                          size="sm"
                          isSelected={selectedSet.has(name)}
                          onValueChange={() => toggle(name)}
                        >
                          <span className="text-sm break-all">{name}</span>
                        </Checkbox>
                      </div>
                    )}
                  />
                )}
              </div>
            </div>

            <div className="w-1/2 flex flex-col min-h-0 gap-2 border-l border-divider pl-4">
              <div className="flex items-center justify-between">
                <span
                  className={`text-sm ${countMismatch ? 'text-warning' : 'text-foreground-500'}`}
                >
                  {slotCount > 0
                    ? t('outlet.picker.selectedWithSlots', {
                        selected: selected.length,
                        total: slotCount
                      })
                    : t('outlet.picker.selected', { num: selected.length })}
                </span>
                <Button size="sm" variant="light" color="danger" onPress={() => setSelected([])}>
                  {t('outlet.picker.clear')}
                </Button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto border border-divider rounded-lg px-2 py-1">
                {selected.length === 0 ? (
                  <div className="text-center text-foreground-500 py-4 text-sm">
                    {t('outlet.picker.emptySelected')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {selected.map((name, index) => (
                      <div
                        key={`${name}-${index}`}
                        className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-content2"
                      >
                        <Chip size="sm" variant="flat" className="shrink-0">
                          {slotLabels?.[index] ?? index + 1}
                        </Chip>
                        <span className="flex-1 min-w-0 truncate text-sm" title={name}>
                          {name}
                        </span>
                        <Tooltip content={t('outlet.picker.moveUp')}>
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            isDisabled={index === 0}
                            onPress={() => move(index, -1)}
                          >
                            <IoMdArrowUp />
                          </Button>
                        </Tooltip>
                        <Tooltip content={t('outlet.picker.moveDown')}>
                          <Button
                            size="sm"
                            isIconOnly
                            variant="light"
                            isDisabled={index === selected.length - 1}
                            onPress={() => move(index, 1)}
                          >
                            <IoMdArrowDown />
                          </Button>
                        </Tooltip>
                        <Button
                          size="sm"
                          isIconOnly
                          variant="light"
                          color="danger"
                          onPress={() => toggle(name)}
                        >
                          <IoMdClose />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="pt-0">
          <Button size="sm" variant="light" onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" color="primary" onPress={() => onConfirm(selected)}>
            {t('common.confirm')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default OutletTargetPicker
