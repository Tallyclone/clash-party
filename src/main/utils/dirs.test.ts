import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let packaged = false
let portable = false
let appName = 'mihomo-party'
const paths: Record<string, string> = {}
const setPath = vi.fn((name: string, value: string) => {
  paths[name] = value
})
const setName = vi.fn((value: string) => {
  appName = value
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged
    },
    getPath: (name: string) => paths[name],
    setPath,
    setName,
    getName: () => appName
  }
}))

// 被测代码全程用 path.join / path.dirname 拼路径，产出的分隔符跟当前平台一致。
// 所以这里的 fixture 与断言也必须用 path.join 组装，写死 POSIX 正斜杠会让 mock 在
// Windows 上永远不命中，portable 用例会静默退化成非 portable。
const appDataDir = path.join('/tmp', 'app-data')
const exeFile = path.join('/tmp', 'runtime', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const exeDirPath = path.dirname(exeFile)
const portableMarker = path.join(exeDirPath, 'PORTABLE')
const portableDataPath = path.join(exeDirPath, 'data')

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>()
  return {
    ...original,
    existsSync: (value: string) => portable && value === portableMarker
  }
})

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

beforeEach(() => {
  packaged = false
  portable = false
  appName = 'mihomo-party'
  Object.assign(paths, {
    appData: appDataDir,
    userData: path.join(appDataDir, 'mihomo-party'),
    home: path.join('/tmp', 'home'),
    exe: exeFile
  })
  setPath.mockClear()
  setName.mockClear()
  vi.resetModules()
})

afterEach(() => vi.restoreAllMocks())

describe('configureAppPaths', () => {
  it('isolates an unpackaged local development app', async () => {
    const { configureAppPaths } = await import('./dirs')
    configureAppPaths()

    expect(setName).toHaveBeenCalledWith('mihomo-party-dev')
    expect(paths.userData).toBe(path.join(appDataDir, 'mihomo-party-dev'))
  })

  it('leaves packaged stable and dev-release builds on production paths', async () => {
    packaged = true
    const { configureAppPaths } = await import('./dirs')
    configureAppPaths()

    expect(setName).not.toHaveBeenCalled()
    expect(setPath).not.toHaveBeenCalled()
    expect(paths.userData).toBe(path.join(appDataDir, 'mihomo-party'))
  })

  it('keeps portable userData precedence over local development isolation', async () => {
    portable = true
    const { configureAppPaths } = await import('./dirs')
    configureAppPaths()

    expect(setName).toHaveBeenCalledWith('mihomo-party-dev')
    expect(paths.userData).toBe(portableDataPath)
    expect(setPath).toHaveBeenLastCalledWith('userData', portableDataPath)
  })
})
