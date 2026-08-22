import { Button, Chip, Divider, Input, Select, SelectItem, Switch, Tooltip } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import { toast } from '@renderer/components/base/toast'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  createScriptApiToken,
  mihomoGroups,
  mihomoProxies,
  restartCore,
  restartScriptApiServer,
  scriptApiPort,
  scriptApiRunning,
  stopScriptApiServer
} from '@renderer/utils/ipc'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IoMdAdd, IoMdCopy, IoMdRefresh, IoMdTrash } from 'react-icons/io'
import useSWR from 'swr'
import {
  DEFAULT_SCRIPT_API_CONFIG,
  DEFAULT_SCRIPT_API_PORT,
  DEFAULT_SCRIPT_OUTLET_INTERVAL,
  DEFAULT_SCRIPT_OUTLET_TEST_URL,
  SCRIPT_API_LISTEN_ADDRESS,
  SCRIPT_OUTLET_LISTEN_ADDRESS
} from '../../../shared/appConfig'

/** 出口端口默认从 7900 起分配，远离 mihomo 默认的 7890/7891/7892 */
const OUTLET_PORT_BASE = 7900

const createId = (): string => `outlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const Outlet: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const outlets = useMemo(() => appConfig?.scriptOutlets ?? [], [appConfig?.scriptOutlets])
  const [applying, setApplying] = useState(false)

  // 节点名与策略组名列表，供下拉选择；未启动内核时为空，此时退化为手填
  const { data: proxiesData } = useSWR('mihomoProxies', mihomoProxies)
  const { data: groupsData } = useSWR('mihomoGroups', mihomoGroups)

  const proxyNames = useMemo(() => {
    const names = new Set<string>()
    if (proxiesData?.proxies) {
      Object.values(proxiesData.proxies).forEach((proxy) => {
        // 排除策略组自身，只留可直接作为出口的真实节点
        if (proxy && !('all' in proxy)) names.add(proxy.name)
      })
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [proxiesData])

  const groupNames = useMemo(() => {
    return (groupsData ?? []).map((group) => group.name).sort((a, b) => a.localeCompare(b))
  }, [groupsData])

  const selectableTargets = useMemo(() => {
    return [...groupNames, ...proxyNames]
  }, [groupNames, proxyNames])

  const nextPort = useMemo(() => {
    const used = new Set(outlets.map((outlet) => outlet.port))
    let port = OUTLET_PORT_BASE
    while (used.has(port)) port += 1
    return port
  }, [outlets])

  const saveOutlets = async (next: IScriptOutlet[]): Promise<void> => {
    await patchAppConfig({ scriptOutlets: next })
  }

  const addOutlet = async (): Promise<void> => {
    const outlet: IScriptOutlet = {
      id: createId(),
      enable: true,
      port: nextPort,
      type: 'mixed',
      mode: 'direct',
      target: '',
      targets: [],
      udp: true
    }
    await saveOutlets([...outlets, outlet])
  }

  const updateOutlet = async (id: string, patch: Partial<IScriptOutlet>): Promise<void> => {
    await saveOutlets(
      outlets.map((outlet) => (outlet.id === id ? { ...outlet, ...patch } : outlet))
    )
  }

  const removeOutlet = async (id: string): Promise<void> => {
    await saveOutlets(outlets.filter((outlet) => outlet.id !== id))
  }

  // listeners 属于入站结构，热重载无法可靠生效，必须重启内核
  const applyOutlets = async (): Promise<void> => {
    try {
      setApplying(true)
      await restartCore()
      toast.success(t('outlet.applySuccess'))
    } catch (e) {
      toast.detailedError(`${e}`, t('outlet.applyFailed'))
    } finally {
      setApplying(false)
    }
  }

  const copyProxyArg = async (port: number): Promise<void> => {
    await navigator.clipboard.writeText(
      `--proxy-server=http://${SCRIPT_OUTLET_LISTEN_ADDRESS}:${port}`
    )
    toast.success(t('common.copied'))
  }

  const duplicatedPorts = useMemo(() => {
    const seen = new Set<number>()
    const dup = new Set<number>()
    outlets.forEach((outlet) => {
      if (seen.has(outlet.port)) dup.add(outlet.port)
      seen.add(outlet.port)
    })
    return dup
  }, [outlets])

  // ==================== 脚本控制 API ====================

  const scriptApi = useMemo<IScriptApiConfig>(
    () => ({ ...DEFAULT_SCRIPT_API_CONFIG, ...(appConfig?.scriptApi ?? {}) }),
    [appConfig?.scriptApi]
  )
  const { data: apiRunning, mutate: mutateApiRunning } = useSWR(
    'scriptApiRunning',
    scriptApiRunning
  )
  const { data: apiPort, mutate: mutateApiPort } = useSWR('scriptApiPort', scriptApiPort)
  const [apiBusy, setApiBusy] = useState(false)

  const refreshApiStatus = async (): Promise<void> => {
    await Promise.all([mutateApiRunning(), mutateApiPort()])
  }

  /** 只落盘配置，不重启服务；端口/令牌这类高频输入避免每次按键都重建监听 */
  const patchScriptApi = async (patch: Partial<IScriptApiConfig>): Promise<void> => {
    await patchAppConfig({ scriptApi: { ...scriptApi, ...patch } })
  }

  const applyScriptApi = async (next?: Partial<IScriptApiConfig>): Promise<void> => {
    try {
      setApiBusy(true)
      const merged = { ...scriptApi, ...next }
      if (next) await patchAppConfig({ scriptApi: merged })
      // 令牌为空时服务端必定拒绝启动，这里提前短路，避免一次无意义的启动 IPC
      const tokenMissing = merged.enable === true && !merged.token?.trim()
      if (merged.enable && !tokenMissing) {
        await restartScriptApiServer()
      } else {
        await stopScriptApiServer()
      }
      await refreshApiStatus()
      if (tokenMissing) {
        toast.error(t('outlet.api.tokenRequired'))
      } else {
        toast.success(t('outlet.api.applySuccess'))
      }
    } catch (e) {
      toast.detailedError(`${e}`, t('outlet.api.applyFailed'))
    } finally {
      setApiBusy(false)
    }
  }

  const generateToken = async (): Promise<void> => {
    const token = await createScriptApiToken()
    await applyScriptApi({ token })
  }

  const copyApiToken = async (): Promise<void> => {
    if (!scriptApi.token) return
    await navigator.clipboard.writeText(scriptApi.token)
    toast.success(t('common.copied'))
  }

  const copyApiBaseUrl = async (): Promise<void> => {
    await navigator.clipboard.writeText(
      `http://${SCRIPT_API_LISTEN_ADDRESS}:${scriptApi.port ?? DEFAULT_SCRIPT_API_PORT}`
    )
    toast.success(t('common.copied'))
  }

  const apiPortInvalid =
    !Number.isInteger(scriptApi.port) ||
    (scriptApi.port ?? 0) <= 0 ||
    (scriptApi.port ?? 0) > 65535 ||
    outlets.some((outlet) => outlet.port === scriptApi.port)

  return (
    <BasePage
      title={t('outlet.title')}
      header={
        <>
          <Button
            size="sm"
            variant="flat"
            className="app-nodrag"
            startContent={<IoMdAdd />}
            onPress={addOutlet}
          >
            {t('outlet.add')}
          </Button>
          <Button
            size="sm"
            color="primary"
            className="app-nodrag"
            isLoading={applying}
            onPress={applyOutlets}
          >
            {t('outlet.apply')}
          </Button>
        </>
      }
    >
      <SettingCard>
        <SettingItem title={t('outlet.description')} />
        <Divider className="my-2" />
        <SettingItem title={t('outlet.securityNotice')} />
      </SettingCard>

      <SettingCard title={t('outlet.api.title')}>
        <SettingItem title={t('outlet.api.description')} />
        <Divider className="my-2" />
        <SettingItem title={t('outlet.api.enable')} divider>
          <div className="flex items-center gap-2">
            <Chip size="sm" variant="flat" color={apiRunning ? 'success' : 'default'}>
              {apiRunning
                ? `${SCRIPT_API_LISTEN_ADDRESS}:${apiPort ?? scriptApi.port}`
                : t('outlet.api.stopped')}
            </Chip>
            <Tooltip content={t('outlet.api.refresh')}>
              <Button size="sm" isIconOnly variant="light" onPress={refreshApiStatus}>
                <IoMdRefresh className="text-lg" />
              </Button>
            </Tooltip>
            <Switch
              size="sm"
              isSelected={scriptApi.enable}
              isDisabled={apiBusy}
              onValueChange={(v) => applyScriptApi({ enable: v })}
            />
          </div>
        </SettingItem>

        <SettingItem title={t('outlet.api.port')} divider>
          <Input
            size="sm"
            type="number"
            className="w-[40%]"
            isInvalid={apiPortInvalid}
            errorMessage={apiPortInvalid ? t('outlet.api.portInvalid') : undefined}
            value={`${scriptApi.port ?? DEFAULT_SCRIPT_API_PORT}`}
            onValueChange={(v) => patchScriptApi({ port: Number(v) })}
          />
        </SettingItem>

        <SettingItem title={t('outlet.api.token')} divider>
          <div className="flex items-center gap-2 w-[70%]">
            <Input
              size="sm"
              type="password"
              value={scriptApi.token ?? ''}
              placeholder={t('outlet.api.tokenPlaceholder')}
              onValueChange={(v) => patchScriptApi({ token: v })}
            />
            <Button size="sm" variant="flat" isDisabled={apiBusy} onPress={generateToken}>
              {t('outlet.api.generateToken')}
            </Button>
            <Tooltip content={t('outlet.api.copyToken')}>
              <Button size="sm" isIconOnly variant="light" onPress={copyApiToken}>
                <IoMdCopy className="text-lg" />
              </Button>
            </Tooltip>
          </div>
        </SettingItem>

        <SettingItem title={t('outlet.api.autoCloseConnection')} divider>
          <Switch
            size="sm"
            isSelected={scriptApi.autoCloseConnection !== false}
            onValueChange={(v) => patchScriptApi({ autoCloseConnection: v })}
          />
        </SettingItem>

        <SettingItem title={t('outlet.api.baseUrl')}>
          <div className="flex items-center gap-2">
            <Chip size="sm" variant="flat">
              {`http://${SCRIPT_API_LISTEN_ADDRESS}:${scriptApi.port ?? DEFAULT_SCRIPT_API_PORT}`}
            </Chip>
            <Tooltip content={t('outlet.api.copyBaseUrl')}>
              <Button size="sm" isIconOnly variant="light" onPress={copyApiBaseUrl}>
                <IoMdCopy className="text-lg" />
              </Button>
            </Tooltip>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              isLoading={apiBusy}
              onPress={() => applyScriptApi()}
            >
              {t('outlet.api.apply')}
            </Button>
          </div>
        </SettingItem>
      </SettingCard>

      {outlets.length === 0 ? (
        <SettingCard>
          <SettingItem title={t('outlet.empty')} />
        </SettingCard>
      ) : (
        outlets.map((outlet) => {
          const portInvalid =
            !Number.isInteger(outlet.port) ||
            outlet.port <= 0 ||
            outlet.port > 65535 ||
            duplicatedPorts.has(outlet.port)
          const targets = outlet.targets ?? []

          return (
            <SettingCard key={outlet.id}>
              <SettingItem
                title={
                  <div className="flex items-center gap-2">
                    <span>{outlet.remark?.trim() || t('outlet.item.untitled')}</span>
                    <Chip size="sm" variant="flat" color={outlet.enable ? 'success' : 'default'}>
                      {`${SCRIPT_OUTLET_LISTEN_ADDRESS}:${outlet.port}`}
                    </Chip>
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                  <Tooltip content={t('outlet.item.copyArg')}>
                    <Button
                      size="sm"
                      isIconOnly
                      variant="light"
                      onPress={() => copyProxyArg(outlet.port)}
                    >
                      <IoMdCopy className="text-lg" />
                    </Button>
                  </Tooltip>
                  <Switch
                    size="sm"
                    isSelected={outlet.enable}
                    onValueChange={(v) => updateOutlet(outlet.id, { enable: v })}
                  />
                  <Button
                    size="sm"
                    isIconOnly
                    color="danger"
                    variant="light"
                    onPress={() => removeOutlet(outlet.id)}
                  >
                    <IoMdTrash className="text-lg" />
                  </Button>
                </div>
              </SettingItem>
              <Divider className="my-2" />

              <SettingItem title={t('outlet.item.remark')} divider>
                <Input
                  size="sm"
                  className="w-[60%]"
                  value={outlet.remark ?? ''}
                  placeholder={t('outlet.item.remarkPlaceholder')}
                  onValueChange={(v) => updateOutlet(outlet.id, { remark: v })}
                />
              </SettingItem>

              <SettingItem title={t('outlet.item.port')} divider>
                <Input
                  size="sm"
                  type="number"
                  className="w-[40%]"
                  isInvalid={portInvalid}
                  errorMessage={portInvalid ? t('outlet.item.portInvalid') : undefined}
                  value={`${outlet.port}`}
                  onValueChange={(v) => updateOutlet(outlet.id, { port: Number(v) })}
                />
              </SettingItem>

              <SettingItem title={t('outlet.item.type')} divider>
                <Select
                  size="sm"
                  className="w-[40%]"
                  selectedKeys={new Set([outlet.type])}
                  onSelectionChange={(keys) => {
                    const key = Array.from(keys)[0] as ScriptOutletListenerType | undefined
                    if (key) updateOutlet(outlet.id, { type: key })
                  }}
                >
                  <SelectItem key="mixed">{t('outlet.item.typeMixed')}</SelectItem>
                  <SelectItem key="http">{t('outlet.item.typeHttp')}</SelectItem>
                  <SelectItem key="socks5">{t('outlet.item.typeSocks5')}</SelectItem>
                </Select>
              </SettingItem>

              <SettingItem title={t('outlet.item.mode')} divider>
                <Select
                  size="sm"
                  className="w-[40%]"
                  selectedKeys={new Set([outlet.mode])}
                  onSelectionChange={(keys) => {
                    const key = Array.from(keys)[0] as ScriptOutletMode | undefined
                    if (key) updateOutlet(outlet.id, { mode: key })
                  }}
                >
                  <SelectItem key="direct">{t('outlet.item.modeDirect')}</SelectItem>
                  <SelectItem key="fallback">{t('outlet.item.modeFallback')}</SelectItem>
                </Select>
              </SettingItem>

              {outlet.mode === 'direct' ? (
                <SettingItem title={t('outlet.item.target')} divider>
                  {selectableTargets.length > 0 ? (
                    <Select
                      size="sm"
                      className="w-[60%]"
                      placeholder={t('outlet.item.targetPlaceholder')}
                      selectedKeys={outlet.target ? new Set([outlet.target]) : new Set<string>()}
                      onSelectionChange={(keys) => {
                        const key = Array.from(keys)[0] as string | undefined
                        updateOutlet(outlet.id, { target: key ?? '' })
                      }}
                    >
                      {selectableTargets.map((name) => (
                        <SelectItem key={name}>{name}</SelectItem>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      size="sm"
                      className="w-[60%]"
                      value={outlet.target ?? ''}
                      placeholder={t('outlet.item.targetPlaceholder')}
                      onValueChange={(v) => updateOutlet(outlet.id, { target: v })}
                    />
                  )}
                </SettingItem>
              ) : (
                <>
                  <SettingItem title={t('outlet.item.targets')} divider>
                    {selectableTargets.length > 0 ? (
                      <Select
                        size="sm"
                        className="w-[60%]"
                        selectionMode="multiple"
                        placeholder={t('outlet.item.targetsPlaceholder')}
                        selectedKeys={new Set(targets)}
                        onSelectionChange={(keys) => {
                          updateOutlet(outlet.id, { targets: Array.from(keys) as string[] })
                        }}
                      >
                        {selectableTargets.map((name) => (
                          <SelectItem key={name}>{name}</SelectItem>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        size="sm"
                        className="w-[60%]"
                        value={targets.join(',')}
                        placeholder={t('outlet.item.targetsPlaceholder')}
                        onValueChange={(v) =>
                          updateOutlet(outlet.id, {
                            targets: v
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          })
                        }
                      />
                    )}
                  </SettingItem>
                  <SettingItem title={t('outlet.item.testUrl')} divider>
                    <Input
                      size="sm"
                      className="w-[60%]"
                      value={outlet.testUrl ?? ''}
                      placeholder={DEFAULT_SCRIPT_OUTLET_TEST_URL}
                      onValueChange={(v) => updateOutlet(outlet.id, { testUrl: v })}
                    />
                  </SettingItem>
                  <SettingItem title={t('outlet.item.interval')} divider>
                    <Input
                      size="sm"
                      type="number"
                      className="w-[40%]"
                      value={`${outlet.interval ?? DEFAULT_SCRIPT_OUTLET_INTERVAL}`}
                      onValueChange={(v) => updateOutlet(outlet.id, { interval: Number(v) })}
                    />
                  </SettingItem>
                </>
              )}

              <SettingItem title={t('outlet.item.udp')}>
                <Switch
                  size="sm"
                  isSelected={outlet.udp ?? true}
                  onValueChange={(v) => updateOutlet(outlet.id, { udp: v })}
                />
              </SettingItem>
            </SettingCard>
          )
        })
      )}
    </BasePage>
  )
}

export default Outlet
