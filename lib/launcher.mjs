/**
 * 让「灵灵」桌宠跟着 DSH 一起起来。
 *
 * 这里只做三件事，剩下的都在 `app/` 里（那是一个完整的小 Electron 应用）：
 *
 *   1. 找一个能用的 Electron 运行时（优先复用用户已经装好的独立版，
 *      其次用本插件自己下过的，最后才下载）；
 *   2. 用那个运行时把 `app/` 跑起来，进程 detach，DSH 退出也不带走它；
 *   3. 记 pid，让 `pet_desktop` 工具能查状态、能停掉。
 *
 * 为什么不把 Electron 打进 npm 包：一个 win32-x64 的运行时解开是 198 MB，
 * 而 npm 对单个包的大小是有上限的。所以按需下载，走国内镜像。
 */

import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 桌宠应用目录（本包内的 `app/`）。 */
export const APP_DIR = join(HERE, '..', 'app')

const HOME_DIR = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const LOCAL_DIR = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')

/** 与独立安装版共用同一个数据目录，所以形象、大小、位置是同一份配置。 */
export const DATA_DIR = join(HOME_DIR, 'dsh-pet')
const RUNTIME_DIR = join(DATA_DIR, 'runtime')
const PID_FILE = join(DATA_DIR, 'pet.pid')
const LOG_FILE = join(DATA_DIR, 'pet.log')

const ELECTRON_VERSION = '33.4.11'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

function platformZip() {
  if (process.platform === 'win32') return `electron-v${ELECTRON_VERSION}-win32-${ARCH}.zip`
  if (process.platform === 'darwin') return `electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`
  return `electron-v${ELECTRON_VERSION}-linux-${ARCH}.zip`
}

function exeName() {
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return 'electron'
}

/** 下载源，按顺序试；前两个是国内镜像，第三个是官方。 */
function mirrorUrls() {
  const zip = platformZip()
  return [
    `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/${zip}`,
    `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${zip}`,
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zip}`,
  ]
}

/** 单次 HTTP GET，跟随重定向，写到 dest。返回字节数。 */
function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error(`重定向次数过多：${url}`))
      return
    }
    const req = httpsGet(url, { headers: { 'user-agent': 'dsh-plugin-pet' } }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).href
        resolve(downloadTo(next, dest, redirects + 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status}：${url}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let done = 0
      let lastLog = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk) => {
        done += chunk.length
        // 每 16 MB 打一行，方便在 DSH 日志里看进度。
        if (total > 0 && done - lastLog > 16 * 1024 * 1024) {
          lastLog = done
          log(`downloading electron ${Math.round((done / total) * 100)}% (${Math.round(done / 1048576)}/${Math.round(total / 1048576)} MB)`)
        }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(done)))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60000, () => {
      req.destroy(new Error(`下载超时：${url}`))
    })
  })
}

/** 为什么用系统的 tar：Windows 10 1803+ 自带 bsdtar，能直接解 zip，不必背一个解压库。 */
function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true })
  const win = process.platform === 'win32'
  const bin = win ? 'tar' : 'unzip'
  const args = win ? ['-xf', zipPath, '-C', destDir] : ['-q', zipPath, '-d', destDir]
  const r = spawnSync(bin, args, { stdio: 'pipe' })
  if (r.status !== 0) {
    const msg = (r.stderr ? r.stderr.toString() : '') || (r.stdout ? r.stdout.toString() : '')
    throw new Error(`${bin} 解压失败（exit ${r.status}）：${msg.trim()}`)
  }
}

let logger = null
function log(message) {
  if (logger) logger(`[dsh-pet] ${message}`)
  else console.log(`[dsh-pet] ${message}`)
}

/**
 * 找一个可用的 Electron 可执行文件。
 * 顺序：用户已装的独立版 → 本插件下过的运行时 → 现下载。
 */
export async function ensureElectron(ctxLogger) {
  if (ctxLogger) logger = ctxLogger

  const standalone = join(LOCAL_DIR, 'Programs', 'dsh-pet', exeName())
  if (existsSync(standalone)) return { exe: standalone, source: 'standalone' }

  const cached = join(RUNTIME_DIR, exeName())
  if (existsSync(cached)) return { exe: cached, source: 'cache' }

  mkdirSync(DATA_DIR, { recursive: true })
  const zipPath = join(DATA_DIR, `electron-${ELECTRON_VERSION}-${ARCH}.zip`)
  const errors = []
  for (const url of mirrorUrls()) {
    try {
      log(`downloading ${url}`)
      const bytes = await downloadTo(url, zipPath)
      log(`downloaded ${Math.round(bytes / 1048576)} MB`)
      extractZip(zipPath, RUNTIME_DIR)
      rmSync(zipPath, { force: true })
      if (!existsSync(cached)) throw new Error('解压后没找到 electron 可执行文件')
      return { exe: cached, source: 'download' }
    } catch (error) {
      errors.push(`${url} → ${error && error.message ? error.message : error}`)
      rmSync(zipPath, { force: true })
    }
  }
  throw new Error(`Electron 运行时获取失败，试过的源：\n${errors.join('\n')}`)
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 读 pid 文件，进程不在了就顺手清掉。 */
export function readPid() {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim()
    const pid = Number(raw)
    if (!isAlive(pid)) {
      rmSync(PID_FILE, { force: true })
      return null
    }
    return pid
  } catch {
    return null
  }
}

/**
 * 起桌宠。已经在跑就直接返回（桌宠自己有单实例锁，再 spawn 一次也只会闪一下）。
 */
export async function launchPet(ctxLogger) {
  if (ctxLogger) logger = ctxLogger
  const running = readPid()
  if (running) return { ok: true, already: true, pid: running }

  const { exe, source } = await ensureElectron(logger)
  mkdirSync(DATA_DIR, { recursive: true })

  // 必须传 fd 数字：createWriteStream 在 open 之前 fd 是 null，直接丢给 spawn 的
  // stdio 会被 Node 判为非法参数（ERR_INVALID_ARG_VALUE）。
  const logFd = openSync(LOG_FILE, 'a')
  let child
  try {
    child = spawn(exe, [APP_DIR], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DSH_PET_FROM_PLUGIN: '1' },
    })
  } finally {
    closeSync(logFd)
  }
  child.unref()

  writeFileSync(PID_FILE, String(child.pid), 'utf8')
  log(`launched pid=${child.pid} exe=${exe} source=${source}`)
  return { ok: true, already: false, pid: child.pid, source }
}

/** 停掉桌宠（只杀我们自己起的那个 pid）。 */
export function stopPet() {
  const pid = readPid()
  if (!pid) {
    rmSync(PID_FILE, { force: true })
    return { ok: true, stopped: false, detail: '桌宠没有在跑' }
  }
  try {
    process.kill(pid)
  } catch (error) {
    rmSync(PID_FILE, { force: true })
    return { ok: false, stopped: false, detail: error && error.message ? error.message : String(error) }
  }
  rmSync(PID_FILE, { force: true })
  return { ok: true, stopped: true, pid }
}

/** 状态：在不在跑、数据目录、日志在哪。 */
export function petStatus() {
  const pid = readPid()
  let logBytes = 0
  try {
    logBytes = statSync(LOG_FILE).size
  } catch {
    logBytes = 0
  }
  return {
    running: pid !== null,
    pid: pid || null,
    appDir: APP_DIR,
    dataDir: DATA_DIR,
    logFile: LOG_FILE,
    logBytes,
  }
}
