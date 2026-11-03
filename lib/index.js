/**
 * dsh-plugin-pet-desktop —— 让「灵灵」桌宠跟着 DSH 一起起来。
 *
 * 这个插件本身不含界面：它是一个启动器 + 一个工具。真正的桌宠是包内 `app/`
 * 目录里那个完整的 Electron 小程序（无边框透明窗口 + 内嵌 DSH Web UI）。
 *
 * 为什么做成「独立进程 + 启动器」而不是纯 Cordis 插件：
 * 桌宠要的东西（透明无边框窗口、置顶、不抢焦点、不进任务栏、独立于 DSH 主窗口
 * 存在）只有 Electron 的 BrowserWindow 给得到。DSH 自己的 Web UI 跑在浏览器里，
 * 只能做到「页面内的浮层」。所以这里退一步，起一个伴生进程。
 *
 * 上架说明（插件市场）：
 *   - 代码：本插件（启动器 + 桌宠壳）为原创。
 *   - 形象与动画素材：`PC2005-cloud/dsh-pet` v0.4.1（GitHub，MIT 许可证）里的
 *     24 段 VP9-alpha webm，按 MIT 条款再分发，来源与许可证见 NOTICE.md。
 */

import { APP_DIR, DATA_DIR, launchPet, petStatus, stopPet } from './launcher.mjs'

const name = 'pet-desktop'
const inject = ['tools']

const description = [
  '启动/查询/停止「灵灵」桌面宠物：一个常驻屏幕左下角的透明悬浮小窗，里面是完整的 DSH 界面。',
  '',
  '它和网页版的区别：不占浏览器标签页、不占任务栏、不进 Alt+Tab、永远在最上层；双击宠物展开聊天窗口，',
  '聊天窗右上角 ▽ 收回成宠物；拖动换位置、Ctrl+滚轮调大小、右键换形象。',
  '',
  '首次调用若本机没有 Electron 运行时会下载约 115 MB（走 npmmirror 国内镜像），需要几十秒。',
  '桌宠是独立进程，DSH 退出也不会带走它；要它下线用 action="stop"。',
].join('\n')

const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['launch', 'status', 'stop'],
      description:
        'launch = 确保桌宠在跑（已经在跑就原样返回）；status = 查它现在的状态、数据目录和日志位置；stop = 关掉它。默认 launch。',
    },
  },
}

/**
 * 声明结果形状。DSH 会在注册时校验 execute 的返回值——形状对不上会拒绝注册，
 * 而注册失败会把整个插件树（连同每次 DSH 启动）拖下去，所以这里必须与 execute 严格一致。
 */
const outputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    running: { type: 'boolean' },
    message: { type: 'string' },
    dataDir: { type: 'string' },
    logFile: { type: 'string' },
  },
  required: ['ok', 'running', 'message'],
}

function renderResult(value) {
  return typeof value?.message === 'string' && value.message.length > 0 ? value.message : '桌宠操作完成。'
}

async function run(args) {
  const action = typeof args?.action === 'string' ? args.action.trim() : 'launch'

  if (action === 'stop') {
    const stopped = stopPet()
    const after = petStatus()
    return {
      ok: stopped.ok === true,
      running: after.running,
      message: stopped.stopped
        ? `桌宠已关闭（pid ${stopped.pid}）。`
        : `桌宠没有在跑。${stopped.detail && stopped.detail !== '桌宠没有在跑' ? `（${stopped.detail}）` : ''}`,
      dataDir: after.dataDir,
      logFile: after.logFile,
    }
  }

  if (action === 'status') {
    const status = petStatus()
    return {
      ok: true,
      running: status.running,
      message: status.running
        ? `桌宠在跑，pid ${status.pid}。\n数据目录：${status.dataDir}\n日志：${status.logFile}（${status.logBytes} 字节）\n应用目录：${status.appDir}`
        : `桌宠没有在跑。\n数据目录：${status.dataDir}\n应用目录：${status.appDir}`,
      dataDir: status.dataDir,
      logFile: status.logFile,
    }
  }

  // launch
  try {
    const launched = await launchPet((line) => console.log(line))
    const status = petStatus()
    return {
      ok: true,
      running: status.running,
      message: launched.already
        ? `桌宠已经在跑，pid ${launched.pid}，没有重复启动。`
        : `桌宠已启动，pid ${launched.pid}（Electron 运行时来源：${launched.source}）。它现在应该在屏幕左下角，双击展开聊天窗口。\n数据目录：${status.dataDir}`,
      dataDir: status.dataDir,
      logFile: status.logFile,
    }
  } catch (error) {
    return {
      ok: false,
      running: false,
      message: `桌宠启动失败：${error && error.message ? error.message : String(error)}`,
      dataDir: DATA_DIR,
      logFile: petStatus().logFile,
    }
  }
}

function apply(ctx) {
  // 注册失败绝不能把整个插件树拖下去：DSH 的 boot 是 fail-loud 的，一次注册异常
  // 会让整个 harness（含桌面端）起不来。所以这里吞掉错误、只留日志，桌宠本身
  // 该起还是会起——工具只是便利，不是命脉。
  try {
    ctx.tools.register({
      name: 'pet_desktop',
      description,
      parameters,
      output: {
        schema: outputSchema,
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      async execute(args) {
        return run(args)
      },
    })
  } catch (error) {
    console.warn(
      `[dsh-pet] pet_desktop 工具注册失败（桌宠仍然会启动）：${error && error.message ? error.message : error}`,
    )
  }

  // 跟着 DSH 一起起来。设 DSH_PET_PLUGIN_AUTOSTART=0 可以关掉，改用手动调用工具。
  if (process.env.DSH_PET_PLUGIN_AUTOSTART !== '0') {
    void launchPet((line) => console.log(line)).catch((error) => {
      console.warn(
        `[dsh-pet] 自动启动失败（可以稍后用 pet_desktop 工具重试）：${error && error.message ? error.message : error}`,
      )
    })
  }
}

export { apply, inject, name }
