# 灵灵 · DSH 桌面宠物

把 DSH 变成一只待在屏幕左下角的小桌宠：不占浏览器标签页、不占任务栏、不进 Alt+Tab、
永远在最上层。双击她展开成完整的 DSH 聊天窗口，不用的时候右上角 **▽** 一按，缩回成宠物。

> **素材来源声明（重要）**
> 桌宠形象与全部 24 段动画来自开源项目 **PC2005-cloud/dsh-pet v0.4.1**（GitHub / npm，**MIT** 许可证）。
> 本插件只复用它的 webm 动画素材，代码与形态完全不同（它是 DSH 界面内的浮窗，本插件是独立 Electron 窗口）。
> 完整署名、许可证原文、取材方式见 [NOTICE.md](./NOTICE.md)。

---

## 它解决什么

DSH 的网页版要开浏览器、要切标签页、要在一堆窗口里找。这个插件给你一个常驻的小存在：
鼠标一划就到左下角，点一下就说话，说完就缩回去继续当摆件。

## 安装

包名：`dsh-plugin-pet-desktop`

### 方式 1：一行命令（推荐）

```bash
dsh plugin --profile web add dsh-plugin-pet-desktop
```

装完重启 DSH（关掉那个跑 `dsh web` 的黑窗口再开），桌宠会自己出现在左下角。

也可在 DSH 的插件市场里搜 **灵灵** 或 **pet-desktop**，点安装。

### 装完桌面上会有「灵灵」图标（v1.0.3 起）

第一次启动桌宠时，插件会在桌面放一个 **灵灵** 快捷方式，指向下好的 Electron 运行时 +
本插件的 `app/` 目录。留着它，以后不用开 DSH 也能双击直接叫出桌宠。

- 桌面上**已经有**同名 `灵灵.lnk` 时不会覆盖（避免顶掉你自己做的那份）
- 没有桌面权限（少数域控环境）就跳过这一步，只打一行日志，不影响桌宠启动
- 想手动重建：删掉桌面那个 lnk，重启一次 DSH 即可

### 方式 2：装本地包（离线可用）

拿到 `dsh-plugin-pet-desktop-1.0.3.tgz` 后：

```powershell
dsh plugin --profile web add C:\path\to\dsh-plugin-pet-desktop-1.0.3.tgz
```

或者指向解压出来的目录：

```powershell
dsh plugin --profile web add C:\path\to\dsh-plugin-pet
```

### 方式 3：不用插件，直接装独立版

包里 `app/` 目录本身就是一个完整的 Electron 应用，可以脱离 DSH 单独跑：

```powershell
# 需要先有 Electron 运行时
npx --yes electron@33 .\app
```

独立版和插件版共用同一个数据目录 `%APPDATA%\dsh-pet\`，配置、形象、位置通用。

### 首次启动会下载 Electron

包内**不含** Electron 运行时（一个 win32-x64 运行时解开是 198 MB，npm 单包有大小上限）。
首次启动时插件会自动下载（约 115 MB，走 npmmirror 国内镜像，几十秒），解压到：

```
%APPDATA%\dsh-pet\runtime\
```

之后就不再下载。如果本机已经装过独立版（`%LOCALAPPDATA%\Programs\dsh-pet\electron.exe`），
直接复用，不下载。

## 怎么用

| 操作 | 效果 |
| --- | --- |
| **双击**桌宠 | 展开聊天窗口 |
| **单击**桌宠 | 她做个反应（挥手 / 跳起来 / 害羞 / 生气 / 咯咯笑 / 吓一跳，随机） |
| **按住拖动** | 换位置（贴边自动吸附），拖动时会变成被拎起来的姿势 |
| **Ctrl + 滚轮** | 大小四档：小 120 / 中 160 / 大 210 / 超大 270 |
| **右键**桌宠 | 打开聊天窗口 / 大小 / 更换形象 / 打开形象文件夹 / 回到左下角 / 退出 |
| 聊天窗右上角 **▽** | 收成桌宠 |
| **Ctrl+Alt+P** | 桌宠 ↔ 聊天窗口 切换 |
| **Ctrl+Alt+L** | 展开 / 收起会话列表（窗口太窄时侧栏会折叠成图标条） |
| **Ctrl+Alt+M** | 打开一个正常大小的「网页版」大窗口 |
| **F5** / **Ctrl+Shift+R** | 刷新 / 硬刷新（忽略缓存） |
| 关掉聊天窗（×） | 也是收成桌宠，不是退出 |

闲着的时候她会自己玩：22 秒换个待机花样（东张西望 / 打哈欠 / 伸懒腰 / 原地踏步），
95 秒没人理就睡觉，3 分半会表演一段才艺（跳舞 / 凭空生花 / 转圈 / 吐泡泡 / 玩魔方 / 写代码 / 撸猫）。

### 换形象

1. 右键桌宠 →「打开形象文件夹」（`%APPDATA%\dsh-pet\pets\`）
2. 丢任意透明背景 PNG / JPG / WebP 进去（建议正方形 512px 以上）
3. 右键桌宠 →「更换形象」→ 选你的图
4. 改回内置动画：右键 →「更换形象」→「内置动画（蓝鲸娘）」

想换默认动画，覆盖 `app/assets/anims/` 里的同名 webm 即可（要求 VP9 + alpha、640×360 横版、角色居中）。

## 为什么是独立进程

DSH 的 Web UI 跑在浏览器里，网页能做的浮层只活在那个标签页内。要做到「在 DSH 之外、
在任何程序上面、不占任务栏」，只有原生窗口给得到。所以插件起一个很小的 Electron 伴生进程，
窗口里嵌的还是同一个 `http://127.0.0.1:3080`——你在桌宠里说的话、看到的会话，和浏览器里是同一份。

它自己会做鉴权：从 `%USERPROFILE%\.dsh\.credentials.yaml` 读 `client-connection/browser-session`
密钥，自己签一个 `dsh-auth-*` cookie 塞进窗口，等价于 `dsh web` 打印的那种带 token 的地址。
所以不需要你在桌宠里重登、也不需要去翻浏览器的 cookie。

## 工具接口

装好后模型多一个工具：

```
pet_desktop(action: "launch" | "status" | "stop")
```

- `launch` — 确保桌宠在跑（已在跑就原样返回，不会重复启动）
- `status` — 返回 pid、数据目录、日志路径
- `stop` — 只关掉本插件起的那个进程

不想要开机自动出现，设环境变量 `DSH_PET_PLUGIN_AUTOSTART=0`，之后用工具手动 `launch`。

## 数据与日志

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\dsh-pet\config.json` | 窗口尺寸位置、缩放、桌宠大小、位置、形象 |
| `%APPDATA%\dsh-pet\pets\` | 你自己的形象图 |
| `%APPDATA%\dsh-pet\runtime\` | 按需下载的 Electron |
| `%APPDATA%\dsh-pet\pet.log` | 桌宠主进程日志 |
| `%APPDATA%\dsh-pet\pet.pid` | 当前实例 pid（插件用它查状态） |

删掉整个 `%APPDATA%\dsh-pet\` 就恢复出厂。

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-pet-desktop
```

再删 `%APPDATA%\dsh-pet\`（记得先右键桌宠退出）。

## 已知限制

- **Windows 优先**。窗口透明、置顶、`focusable:false`、DPI 处理都按 Windows 调过；
  macOS / Linux 的运行时下载和窗口行为代码路径写了但没实测。
- 会话列表在窗口宽度 < 1024 CSS px 时会折叠成图标条，这是 DSH 自己的响应式断点，
  用 **Ctrl+Alt+L** 撑宽或用 **Ctrl+Alt+M** 开大窗口。
- 桌宠不抢焦点（`focusable:false`），所以它永远不是当前窗口——这正是桌宠想要的，
  但也意味着键盘快捷键只在聊天窗口里有效。

## 许可证

MIT，见 [LICENSE](./LICENSE)。素材署名见 [NOTICE.md](./NOTICE.md)。
