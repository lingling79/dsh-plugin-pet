// DSH 桌宠 / 常驻小窗
// 无边框置顶小窗内嵌本地 DSH Web UI，自动完成 cookie 鉴权，左下角常驻。
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session, shell, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

// 主进程未捕获异常一律只记日志，绝不让 Electron 弹 "A JavaScript error occurred
// in the main process" 模态框打断使用。
process.on("uncaughtException", (error) => {
  console.error("[dsh-pet] uncaughtException:", error && error.stack ? error.stack : error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[dsh-pet] unhandledRejection:", reason && reason.stack ? reason.stack : reason);
});

const APP_DIR = __dirname;
const CONFIG_DIR = path.join(app.getPath("appData"), "dsh-pet");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PORT = Number(process.env.DSH_PET_PORT || 3080);
const BASE_URL = `http://127.0.0.1:${PORT}/`;

const DEFAULT_CONFIG = {
  width: 480,
  height: 800,
  x: null,
  y: null,
  zoom: 0.9,
  alwaysOnTop: true,
  collapsed: false,
  opacity: 1,
  // 桌宠形态
  startAsPet: true, // 启动时先显示左下角桌宠，双击才展开聊天窗
  petImage: null, // 自定义形象图片绝对路径；null = 内置动画
  petSize: "medium", // small / medium / large / xlarge
  petX: null,
  petY: null,
};

const PET_DIR = path.join(CONFIG_DIR, "pets");
// 桌宠窗口边长（DIP）。分档而不是连续缩放，避免非整数 DPI 下窗口尺寸漂移。
const PET_SIZES = { small: 120, medium: 160, large: 210, xlarge: 270 };
const PET_SIZE_ORDER = ["small", "medium", "large", "xlarge"];
const PET_SIZE_LABELS = { small: "小", medium: "中", large: "大", xlarge: "超大" };
const DEFAULT_PET_SIZE = "medium";
const DEFAULT_PET_IMAGE = path.join(APP_DIR, "assets", "pet-default.png");

function petSide() {
  return PET_SIZES[config.petSize] || PET_SIZES[DEFAULT_PET_SIZE];
}

function petSize() {
  const side = petSide();
  return { width: side, height: side };
}

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  config = { ...config, ...patch };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("[dsh-pet] saveConfig failed", error);
  }
}

let config = loadConfig();
let win = null;
let tray = null;
let hiddenByUser = false;
let authRetried = 0;
let petWin = null;
let dragOrigin = null;
let dragTimer = null;
let dragIdleSince = 0;

// ── 鉴权 ────────────────────────────────────────────────────────────────
// 规则来自 @deepseek-ai/dsh-client-connection：
//   cookie 名 = "dsh-auth-" + b64url(sha256(authority))
//   cookie 值 = v1.<b64url({version:1,authority,issuedAt,expiresAt})>.<b64url(hmac256(secret,body))>
//   authority = HTTP 下的 "host:port"，secret 存于 $DSH_HOME/.credentials.yaml
const { createHash, createHmac } = require("node:crypto");
const os = require("node:os");

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

function readBrowserSecret() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const file = path.join(home, ".credentials.yaml");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
  let inRecord = false;
  for (const line of lines) {
    if (/^ {2}client-connection\/browser-session:\s*$/u.test(line)) {
      inRecord = true;
      continue;
    }
    if (!inRecord) continue;
    const indent = line.match(/^ */u)[0].length;
    if (line.trim() !== "" && indent <= 2) break;
    const m = line.match(/^\s*secret:\s*"?([A-Za-z0-9_-]+)"?\s*$/u);
    if (m) return m[1];
  }
  throw new Error(`browser-session secret not found in ${file}`);
}

function buildCookie(maxAgeDays = 30) {
  const authority = new URL(BASE_URL).host;
  const secretB64 = readBrowserSecret();
  const secret = Buffer.from(secretB64.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  const name = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
  return { name, value: `v1.${body}.${sig}`, expiresAt, authority };
}

async function installCookie() {
  const cookie = buildCookie();
  const target = session.defaultSession;
  await target.cookies.set({
    url: BASE_URL,
    name: cookie.name,
    value: cookie.value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    expirationDate: Math.floor(cookie.expiresAt / 1000),
  });
  return cookie;
}

// ── 服务健康检查 / 自动拉起 ───────────────────────────────────────────────
function probeServer(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 || res.statusCode === 401);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function dshCommand() {
  const npmDir = path.join(process.env.APPDATA || "", "npm");
  const cmd = path.join(npmDir, "dsh.cmd");
  return fs.existsSync(cmd) ? cmd : "dsh";
}

function startServer() {
  const cmd = dshCommand();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", cmd, "web", "--no-open"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: os.homedir(),
  });
  child.unref();
  return child;
}

async function waitForServer(totalMs = 45000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probeServer()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ── 窗口 ────────────────────────────────────────────────────────────────
function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(config.width, Math.max(320, area.width - 40));
  const height = Math.min(config.height, Math.max(360, area.height - 40));
  return {
    width,
    height,
    x: area.x + 16,
    y: area.y + area.height - height - 16,
  };
}

function clampToScreen(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  };
}

function initialBounds() {
  const base = defaultBounds();
  if (Number.isFinite(config.x) && Number.isFinite(config.y)) {
    return clampToScreen({ width: config.width, height: config.height, x: config.x, y: config.y });
  }
  return base;
}

// F5 / Ctrl+R 刷新：Electron 不带默认菜单，快捷键得自己挂
function attachReloadKeys(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (key !== "f5" && !(input.control && key === "r")) return;
    console.log("[dsh-pet] reload key", input.type, input.key, "ctrl=" + !!input.control, "shift=" + !!input.shift);
    event.preventDefault();
    try {
      if (input.shift) webContents.reloadIgnoringCache();
      else webContents.reload();
      console.log("[dsh-pet] reload invoked, url=", webContents.getURL().slice(0, 60));
    } catch (error) {
      console.error("[dsh-pet] reload threw", error && error.message);
    }
  });
}

const DRAG_STRIP = `(() => {
  if (document.getElementById("__dshpet_chrome")) return;
  const wrap = document.createElement("div");
  wrap.id = "__dshpet_chrome";
  Object.assign(wrap.style, {
    position: "fixed", left: "0", top: "0", right: "0", height: "12px",
    zIndex: "2147483647", pointerEvents: "none", display: "block",
  });
  const bar = document.createElement("div");
  Object.assign(bar.style, {
    position: "absolute", left: "0", top: "0", bottom: "0", right: "90px",
    pointerEvents: "auto", cursor: "move",
    background: "linear-gradient(to bottom, rgba(124,92,255,.55), rgba(124,92,255,.10))",
  });
  bar.style.setProperty("-webkit-app-region", "drag");
  wrap.appendChild(bar);

  // 右上角两个按钮：刷新、展开 / 收起会话列表
  // 必须与 -webkit-app-region:drag 区域完全不重叠，否则点击会被窗口拖拽吞掉
  const makeBtn = (id, glyph, title, rightPx, onClick) => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = glyph;
    b.title = title;
    Object.assign(b.style, {
      position: "absolute", right: rightPx + "px", top: "0", height: "22px", width: "26px",
      pointerEvents: "auto", cursor: "pointer", border: "none", padding: "0",
      background: "rgba(124,92,255,.95)", color: "#fff", fontSize: "14px",
      lineHeight: "22px", fontFamily: "system-ui, sans-serif", borderRadius: "5px",
      boxShadow: "0 1px 3px rgba(0,0,0,.35)", zIndex: "2147483647",
    });
    b.style.setProperty("-webkit-app-region", "no-drag");
    b.addEventListener("mouseenter", () => {
      b.style.background = "rgba(140,110,255,1)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = "rgba(124,92,255,.95)";
    });
    b.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        onClick();
      } catch (error) {
        console.error("[dsh-pet] button failed", error);
      }
    });
    wrap.appendChild(b);
    return b;
  };
  makeBtn("__dshpet_reload_btn", "\\u21bb", "刷新页面  (F5)", 59, () => {
    if (window.dshPet && window.dshPet.reload) window.dshPet.reload();
  });
  makeBtn("__dshpet_wide_btn", "\\u2261", "展开 / 收起会话列表  (Ctrl+Alt+L)", 31, () => {
    if (window.dshPet && window.dshPet.toggleWide) window.dshPet.toggleWide();
  });
  makeBtn("__dshpet_pet_btn", "\\u25bd", "收成桌宠  (Ctrl+Alt+P)", 3, () => {
    if (window.dshPet && window.dshPet.toPet) window.dshPet.toPet();
  });
  document.documentElement.appendChild(wrap);
})();
`;

async function createWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: "#151517",
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    hasShadow: true,
    thickFrame: true,
    icon: path.join(APP_DIR, "assets", "icon-256.png"),
    title: "灵灵",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(APP_DIR, "preload.js"),
    },
  });

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, "floating");

  // 窗口内快捷键（不抢系统热键，避免被 QQ / 输入法占掉）
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (input.control && input.alt && key === "l") {
      event.preventDefault();
      toggleWide();
    } else if (input.control && input.alt && key === "m") {
      event.preventDefault();
      openBigWindow();
    }
  });

  win.once("ready-to-show", () => {
    try {
      win.webContents.setZoomFactor(config.zoom || 1);
    } catch (error) {
      console.error("[dsh-pet] zoom failed", error);
    }
    // 启动形态：默认先露出左下角桌宠，双击它才展开聊天窗
    if (config.startAsPet !== false) {
      // 先让聊天窗以不抢焦点的方式渲染一遍（DSH 前端在隐藏窗口里会被 rAF 节流），
      // 1.5 秒后收成桌宠。这样页面是「已渲染好再藏起来」，双击展开是瞬间的。
      win.showInactive();
      setTimeout(() => {
        if (win && !win.isDestroyed()) showPet();
      }, 1500);
    } else {
      win.show();
      win.focus();
      win.webContents.focus();
    }
  });

  // 自检：DSH_PET_SHOOT=<输出png> 时，加载完成后截图并退出
  if (process.env.DSH_PET_SHOOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await win.capturePage();
          fs.writeFileSync(process.env.DSH_PET_SHOOT, image.toPNG());
          console.log("[dsh-pet] shot saved:", process.env.DSH_PET_SHOOT);
        } catch (error) {
          console.error("[dsh-pet] shot failed", error);
        }
        app.isQuitting = true;
        app.quit();
      }, 9000);
    });
  }

  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (wideMode) return; // 宽窗只是临时看会话列表，不覆盖小窗的尺寸位置
    const b = win.getBounds();
    saveConfig({ x: b.x, y: b.y, width: b.width, height: b.height });
  };
  win.on("moved", persistBounds);
  win.on("resized", persistBounds);

  win.webContents.on("did-finish-load", async () => {
    try {
      win.webContents.insertCSS(`html,body{margin:0!important}`).catch(() => {});
      win.webContents.executeJavaScript(DRAG_STRIP).catch(() => {});
      win.webContents.setZoomFactor(config.zoom || 1);
    } catch (error) {
      console.error("[dsh-pet] paint hook failed", error);
    }

    // 401 纯文本页说明 cookie 失效 / secret 轮换：重签一次再加载，最多两次
    let body = "";
    try {
      body = await win.webContents.executeJavaScript(
        "document.body ? document.body.innerText.slice(0,160) : ''",
      );
    } catch {
      /* ignore */
    }
    if (typeof body === "string" && body.includes("authentication required")) {
      if (authRetried < 2) {
        authRetried += 1;
        await installCookie();
        win.loadURL(BASE_URL);
      }
      return;
    }
    authRetried = 0;

    // 诊断：把视口/文档尺寸写盘，便于调窗口宽高与缩放
    try {
      const metrics = await win.webContents.executeJavaScript(`(() => ({
        inner: [window.innerWidth, window.innerHeight],
        scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        dpr: window.devicePixelRatio,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        title: document.title,
      }))()`);
      metrics.zoom = win.webContents.getZoomFactor();
      metrics.window = win.getBounds();
      fs.writeFileSync(path.join(CONFIG_DIR, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
    } catch {
      /* ignore */
    }

    // 调试钩子：DSH_PET_EVAL 里的 JS 在页面里执行并把结果打到主进程 stdout
    if (process.env.DSH_PET_EVAL) {
      win.webContents
        .executeJavaScript(process.env.DSH_PET_EVAL)
        .then((result) => console.log("[dsh-pet] eval =>", JSON.stringify(result)))
        .catch((error) => console.error("[dsh-pet] eval failed", error && error.message));
    }
    if (process.env.DSH_PET_EVAL2) {
      setTimeout(() => {
        win.webContents
          .executeJavaScript(process.env.DSH_PET_EVAL2)
          .then((result) => console.log("[dsh-pet] eval2 =>", JSON.stringify(result)))
          .catch((error) => console.error("[dsh-pet] eval2 failed", error && error.message));
      }, Number(process.env.DSH_PET_EVAL2_DELAY || 15000));
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[dsh-pet] fail-load", code, desc, url);
  });

  // 页面内 Ctrl+滚轮调缩放并记住；F5 / Ctrl+R 刷新
  attachReloadKeys(win.webContents);
  win.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    // Ctrl+Alt+P：收成桌宠 / 展开聊天窗
    if (input.control && input.alt && key === "p") {
      event.preventDefault();
      togglePetChat();
      return;
    }
    // Ctrl+Alt+L：会话列表宽窗
    if (input.control && input.alt && key === "l") {
      event.preventDefault();
      toggleWide();
      return;
    }
    if (input.control && (input.key === "=" || input.key === "+" || input.key === "-")) {
      const next = Math.min(1.6, Math.max(0.6, (win.webContents.getZoomFactor() || 1) + (input.key === "-" ? -0.08 : 0.08)));
      win.webContents.setZoomFactor(next);
      saveConfig({ zoom: Number(next.toFixed(2)) });
      event.preventDefault();
    }
  });

  // 外部链接用默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url) && !url.startsWith(BASE_URL.replace(/\/$/u, ""))) shell.openExternal(url);
    return { action: "deny" };
  });

  // 先铺一层深色加载页，避免 Electron 默认白底在 DSH 前端加载期间闪白
  await win
    .loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
          html,body{height:100%;margin:0;background:#151517;color:#8b8b93;
            font:13px/1.7 "Segoe UI",system-ui;display:flex;align-items:center;
            justify-content:center;flex-direction:column;gap:10px;user-select:none}
          .dot{width:8px;height:8px;border-radius:50%;background:#7c5cff;
            box-shadow:0 0 12px #7c5cff;animation:p 1.1s ease-in-out infinite}
          @keyframes p{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
        </style><div class="dot"></div><div>灵灵正在连接本地 DSH…</div>`),
    )
    .catch(() => {});

  await installCookie();
  const online = (await probeServer()) || (startServer(), await waitForServer());
  if (!online) {
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="font:14px system-ui;background:#151517;color:#ddd;padding:24px;line-height:1.7">
             <b>本地 DSH 服务没起来</b><br>端口 ${PORT} 无响应。<br><br>
             点托盘图标 → 重启服务，或在终端执行 <code>dsh web</code> 后再点「重新加载」。</body>`,
        ),
    );
  } else {
    win.loadURL(BASE_URL);
  }

  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      // 关掉聊天窗 = 收成左下角桌宠（不是彻底消失）
      showPet();
      hiddenByUser = true;
    }
  });

  return win;
}

// ── 托盘 ────────────────────────────────────────────────────────────────
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(APP_DIR, "assets", "icon-32.png"));
  tray = new Tray(icon);
  tray.setToolTip("灵灵 · DSH 桌宠");
  refreshTrayMenu();
  tray.on("click", () => toggleWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const chatVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
  const menu = Menu.buildFromTemplate([
    {
      label: chatVisible ? "收成桌宠  (Ctrl+Alt+P)" : "展开聊天窗口  (Ctrl+Alt+P)",
      click: () => togglePetChat(),
    },
    {
      label: "显示 / 隐藏聊天窗  (Ctrl+Alt+D)",
      click: () => toggleWindow(),
    },
    {
      label: wideMode ? "收起会话列表  (Ctrl+Alt+L)" : "展开会话列表  (Ctrl+Alt+L)",
      enabled: chatVisible,
      click: () => toggleWide(),
    },
    {
      label: "置顶显示",
      type: "checkbox",
      checked: Boolean(config.alwaysOnTop),
      click: (item) => {
        config.alwaysOnTop = item.checked;
        win?.setAlwaysOnTop(item.checked, "floating");
        petWin?.setAlwaysOnTop(item.checked, "floating");
        saveConfig({ alwaysOnTop: item.checked });
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    { label: "更换桌宠形象 / 打开形象文件夹", click: () => petMenu() },
    { label: "把桌宠放回左下角", click: () => { const c = petCorner(); config.petX = c.x; config.petY = c.y; saveConfig({ petX: c.x, petY: c.y }); if (petWin && !petWin.isDestroyed()) pinPetBounds(c.x, c.y); } },
    { type: "separator" },
    { label: "刷新页面  (F5)", click: () => win?.webContents.reload() },
    { label: "强制刷新（忽略缓存）  (Ctrl+Shift+R)", click: () => win?.webContents.reloadIgnoringCache() },
    { label: "重新加载页面", click: () => win?.loadURL(BASE_URL) },
    { label: "重新鉴权 (重签 cookie)", click: async () => { await installCookie(); win?.loadURL(BASE_URL); } },
    { label: "重启本地服务", click: async () => { startServer(); await waitForServer(); win?.loadURL(BASE_URL); } },
    { label: "回到屏幕左下角", click: () => { const b = defaultBounds(); win?.setBounds(b); saveConfig({ x: b.x, y: b.y, width: b.width, height: b.height }); } },
    { label: "打开大窗口（网页版）", click: () => openBigWindow() },
    { type: "separator" },
    { label: "退出", click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
    hiddenByUser = true;
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    hiddenByUser = false;
  }
  refreshTrayMenu();
}

// ── 会话列表（宽窗）模式 ────────────────────────────────────────────────
// DSH 前端的侧栏断点写死在 dsh-client-ui-layout/lib/client.js:13 的
//   const SIDEBAR_AUTO_COLLAPSE = 1024;
// 也就是说页面 CSS 宽 < 1024 时左侧栏被折叠成 56px 图标条，会话列表看不见。
// 小窗永远满足不了这个条件，所以这里做一键临时撑宽：撑开后侧栏自动展开，
// 再按一次恢复原来贴左下角的小窗。
// CSS 宽 = 窗口 DIP 宽 / zoom，所以撑宽时要按 zoom 折算。
const WIDE_CSS_WIDTH = 1160;
let wideMode = false;
let smallBounds = null;

function toggleWide(force) {
  if (!win || win.isDestroyed()) return;
  const want = typeof force === "boolean" ? force : !wideMode;
  if (want === wideMode) return;
  if (want) {
    smallBounds = win.getBounds();
    const zoom = (() => {
      try {
        return win.webContents.getZoomFactor() || 1;
      } catch {
        return config.zoom || 1;
      }
    })();
    const area = screen.getDisplayMatching(smallBounds).workArea;
    const width = Math.min(Math.round(WIDE_CSS_WIDTH * zoom), area.width - 24);
    const height = Math.min(
      Math.max(smallBounds.height, Math.round(780 * zoom)),
      area.height - 24,
    );
    wideMode = true;
    win.setBounds(
      clampToScreen({ width, height, x: smallBounds.x, y: smallBounds.y }),
      true,
    );
  } else {
    wideMode = false;
    if (smallBounds) win.setBounds(clampToScreen(smallBounds), true);
  }
  refreshTrayMenu();
}

// ── 大窗口（等效网页版布局） ────────────────────────────────────────────
// 浏览器那个标签可以关掉，服务（dsh web 进程）一直由小窗自己看着。
// 需要完整网页版版面时用这个窗口：同一个 session，cookie 已经种好了。
let bigWin = null;

function openBigWindow() {
  console.log("[dsh-pet] openBigWindow called");
  if (bigWin && !bigWin.isDestroyed()) {
    bigWin.show();
    bigWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  bigWin = new BrowserWindow({
    width: Math.min(1500, area.width - 80),
    height: Math.min(960, area.height - 80),
    minWidth: 900,
    minHeight: 640,
    show: false,
    frame: true,
    backgroundColor: "#151517",
    title: "灵灵 · 网页版",
    icon: path.join(APP_DIR, "assets", "icon-256.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  bigWin.once("ready-to-show", () => {
    console.log("[dsh-pet] big window ready-to-show");
    bigWin.show();
    bigWin.focus();
  });
  attachReloadKeys(bigWin.webContents);
  bigWin.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[dsh-pet] big window load failed", code, desc);
  });
  bigWin.on("closed", () => {
    bigWin = null;
    // 大窗口关掉后把置顶还回去
    if (win && !win.isDestroyed() && config.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
  });
  // 大窗口在前台时别让小窗压在上面
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
  bigWin.loadURL(BASE_URL).catch((error) => {
    console.error("[dsh-pet] big window loadURL threw", error);
  });
}

// ── 桌宠形态（左下角小形象 ↔ 聊天窗口） ────────────────────────────────
// 双窗口方案：聊天窗用 hide/show 保状态（不销毁、不重新 loadURL，切回来是原样），
// 宠物窗是独立的透明无边框窗口，只画一张可替换的形象图。
function ensurePetDir() {
  try {
    fs.mkdirSync(PET_DIR, { recursive: true });
  } catch (error) {
    console.error("[dsh-pet] ensurePetDir failed", error);
  }
}

const isImageFile = (name) => /\.(png|jpe?g|gif|webp|bmp)$/iu.test(name);

function listPetImages() {
  ensurePetDir();
  const out = [];
  try {
    for (const entry of fs.readdirSync(PET_DIR)) {
      const full = path.join(PET_DIR, entry);
      try {
        if (isImageFile(entry) && fs.statSync(full).isFile()) out.push(full);
      } catch {
        /* 跳过读不到的文件 */
      }
    }
  } catch (error) {
    console.error("[dsh-pet] listPetImages failed", error);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function currentPetImage() {
  const custom = config.petImage;
  if (custom && fs.existsSync(custom)) return custom;
  return DEFAULT_PET_IMAGE;
}

function petCorner() {
  const area = screen.getPrimaryDisplay().workArea;
  const side = petSide();
  return {
    x: area.x + 20,
    y: area.y + area.height - side - 12,
  };
}

function petBounds() {
  const corner = petCorner();
  return clampToScreen({
    ...petSize(),
    x: Number.isFinite(config.petX) ? config.petX : corner.x,
    y: Number.isFinite(config.petY) ? config.petY : corner.y,
  });
}

// 钉死桌宠窗口尺寸：非整数 DPI（本机 1.25）下，透明无边框窗口连续 setPosition/setBounds
// 时 Windows 会重算 frame 并吃掉舍入误差，宽度一点点涨上去——拖一次变大一圈、缩不回来。
// 所以每次动窗口都显式带上 width/height。
function pinPetBounds(x, y) {
  if (!petWin || petWin.isDestroyed()) return;
  const side = petSide();
  petWin.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: side,
    height: side,
  });
}

function sendPetAsset() {
  if (!petWin || petWin.isDestroyed()) return;
  try {
    const custom = config.petImage;
    if (custom && fs.existsSync(custom)) {
      const src = require("node:url").pathToFileURL(custom).href;
      petWin.webContents.send("pet:asset", { kind: "image", src });
    } else {
      petWin.webContents.send("pet:asset", { kind: "builtin" });
    }
  } catch (error) {
    console.error("[dsh-pet] sendPetAsset failed", error);
  }
}

function setPetSize(sizeName) {
  if (!Object.prototype.hasOwnProperty.call(PET_SIZES, sizeName)) return;
  config.petSize = sizeName;
  saveConfig({ petSize: sizeName });
  if (petWin && !petWin.isDestroyed()) {
    const b = petWin.getBounds();
    const side = petSide();
    petWin.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y + b.height - side),
      width: side,
      height: side,
    });
  }
  refreshTrayMenu();
}

function cyclePetSize(dir) {
  const cur = PET_SIZE_ORDER.indexOf(config.petSize || DEFAULT_PET_SIZE);
  const idx = Math.min(PET_SIZE_ORDER.length - 1, Math.max(0, cur + (dir > 0 ? 1 : -1)));
  setPetSize(PET_SIZE_ORDER[idx]);
}

function createPetWindow() {
  if (petWin && !petWin.isDestroyed()) return petWin;
  petWin = new BrowserWindow({
    ...petBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false, // 拖动自己实现（pointer capture 才能拿到窗口外的坐标）
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // 关键：focusable:false（Windows 的 WS_EX_NOACTIVATE）让桌宠收到点击，
    // 而不会先把窗口「激活」一遍把这次点击吃掉。否则用户每次双击的第一下
    // 都被系统拿去激活窗口，页面根本收不到，表现就是「双击没反应」。
    focusable: false,
    title: "灵灵",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(APP_DIR, "preload.js"),
    },
  });
  petWin.setAlwaysOnTop(true, "floating");
  petWin.loadFile(path.join(APP_DIR, "assets", "pet.html"));
  petWin.webContents.on("did-finish-load", () => {
    sendPetAsset();
    // 调试钩子：DSH_PET_EVAL_PET 里的 JS 在桌宠页面里执行，结果打到主进程 stdout
    if (process.env.DSH_PET_EVAL_PET) {
      setTimeout(() => {
        petWin?.webContents
          .executeJavaScript(process.env.DSH_PET_EVAL_PET)
          .then((r) => console.log("[dsh-pet] pet eval:", JSON.stringify(r)))
          .catch((error) => console.error("[dsh-pet] pet eval failed", error));
      }, Number(process.env.DSH_PET_EVAL_PET_DELAY || 3500));
    }
  });
  petWin.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[dsh-pet] pet window load failed", code, desc);
  });
  petWin.on("closed", () => {
    petWin = null;
  });
  return petWin;
}

function showPet() {
  console.log("[dsh-pet] showPet, chatVisible=", Boolean(win && !win.isDestroyed() && win.isVisible()));
  const p = createPetWindow();
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  if (!p.isVisible()) p.showInactive(); // 不抢焦点
  sendPetAsset();
  refreshTrayMenu();
}

function showChat() {
  console.log("[dsh-pet] showChat, petVisible=", Boolean(petWin && !petWin.isDestroyed() && petWin.isVisible()));
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  hiddenByUser = false;
  refreshTrayMenu();
}

function togglePetChat() {
  const chatVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
  if (chatVisible) showPet();
  else showChat();
}

function setPetImage(filePath) {
  config.petImage = filePath;
  saveConfig({ petImage: filePath });
  const p = createPetWindow();
  sendPetAsset();
  if (!p.isVisible()) p.showInactive();
}

function snapPetWindow() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const snap = 16;
  let x = b.x;
  let y = b.y;
  if (x - area.x < snap) x = area.x;
  else if (area.x + area.width - (x + b.width) < snap) x = area.x + area.width - b.width;
  if (y - area.y < snap) y = area.y;
  else if (area.y + area.height - (y + b.height) < snap) y = area.y + area.height - b.height;
  if (x !== b.x || y !== b.y) pinPetBounds(x, y);
  config.petX = x;
  config.petY = y;
  saveConfig({ petX: x, petY: y });
}

function petMenu() {
  ensurePetDir();
  const files = listPetImages();
  const current = currentPetImage();
  const items = [
    { label: "打开聊天窗口", click: () => showChat() },
    { type: "separator" },
  ];
  // 大小（分档，避免窗口尺寸漂移）
  items.push({
    label: `大小（当前：${PET_SIZE_LABELS[config.petSize] || PET_SIZE_LABELS[DEFAULT_PET_SIZE]}）`,
    submenu: PET_SIZE_ORDER.map((name) => ({
      label: `${PET_SIZE_LABELS[name]}　${PET_SIZES[name]}px`,
      type: "radio",
      checked: (config.petSize || DEFAULT_PET_SIZE) === name,
      click: () => setPetSize(name),
    })),
  });
  // 形象
  const submenu = [
    {
      label: "内置动画（蓝鲸娘）",
      type: "radio",
      checked: !config.petImage,
      click: () => setPetImage(null),
    },
  ];
  if (files.length) {
    submenu.push({ type: "separator" });
    for (const file of files) {
      submenu.push({
        label: path.basename(file),
        type: "radio",
        checked: file === config.petImage,
        click: () => setPetImage(file),
      });
    }
  }
  items.push({ label: "更换形象", submenu });
  items.push({ label: "打开形象文件夹（放自己的图）", click: () => shell.openPath(PET_DIR) });
  items.push({ type: "separator" });
  items.push({
    label: "回到左下角",
    click: () => {
      const corner = petCorner();
      config.petX = corner.x;
      config.petY = corner.y;
      saveConfig({ petX: corner.x, petY: corner.y });
      if (petWin && !petWin.isDestroyed()) pinPetBounds(corner.x, corner.y);
    },
  });
  items.push({ type: "separator" });
  items.push({ label: "退出", click: () => quitApp() });
  Menu.buildFromTemplate(items).popup({ window: petWin && !petWin.isDestroyed() ? petWin : win });
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

// ── 生命周期 ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
      hiddenByUser = false;
      refreshTrayMenu();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("local.dsh.pet");
    Menu.setApplicationMenu(null);
    await createWindow();
    buildTray();
    const ok = globalShortcut.register("Control+Alt+D", () => toggleWindow());
    if (!ok) console.error("[dsh-pet] global shortcut Ctrl+Alt+D unavailable");
    const okWide = globalShortcut.register("Control+Alt+L", () => toggleWide());
    if (!okWide) console.error("[dsh-pet] global shortcut Ctrl+Alt+L unavailable");
    const okBig = globalShortcut.register("Control+Alt+M", () => openBigWindow());
    if (!okBig) console.error("[dsh-pet] global shortcut Ctrl+Alt+M unavailable");
    const okPet = globalShortcut.register("Control+Alt+P", () => togglePetChat());
    if (!okPet) console.error("[dsh-pet] global shortcut Ctrl+Alt+P unavailable");
    if (process.env.DSH_PET_OPEN_BIG) setTimeout(() => openBigWindow(), 4000);
    globalShortcut.register("Control+Alt+Q", () => {
      if (win?.isVisible()) win.hide();
    });
  });

  app.on("window-all-closed", () => {
    /* 常驻托盘，不退出 */
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (tray) tray.destroy();
  });
}

ipcMain.on("pet:toggle-wide", () => {
  toggleWide();
});

ipcMain.on("pet:is-wide", (event) => {
  event.returnValue = wideMode;
});

ipcMain.on("pet:reload", () => {
  console.log("[dsh-pet] ipc pet:reload");
  win?.webContents.reload();
});

ipcMain.on("pet:hard-reload", () => {
  console.log("[dsh-pet] ipc pet:hard-reload");
  win?.webContents.reloadIgnoringCache();
});

ipcMain.on("pet:toggle-top", (_e, value) => {
  config.alwaysOnTop = Boolean(value);
  win?.setAlwaysOnTop(config.alwaysOnTop, "floating");
  saveConfig({ alwaysOnTop: config.alwaysOnTop });
  refreshTrayMenu();
});

ipcMain.on("pet:hide", () => {
  win?.hide();
  hiddenByUser = true;
  refreshTrayMenu();
});

// ── 桌宠形态的 IPC ──────────────────────────────────────────────────────
ipcMain.on("pet:to-pet", (event) => {
  console.log("[dsh-pet] ipc pet:to-pet from webContents", event.sender.id, "url=", event.senderFrame?.url || "?");
  showPet();
});

ipcMain.on("pet:open-chat", (event) => {
  console.log("[dsh-pet] ipc pet:open-chat from webContents", event.sender.id, "url=", event.senderFrame?.url || "?");
  showChat();
});

ipcMain.on("pet:menu", () => {
  petMenu();
});

ipcMain.on("pet:drag-start", () => {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const p = screen.getCursorScreenPoint();
  const side = petSide();
  dragOrigin = { mx: p.x, my: p.y, wx: b.x, wy: b.y, ww: side, wh: side };
  dragIdleSince = Date.now();
  // 开拖前先钉一次：把之前可能被撑大的窗口拉回标准边长
  petWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: side, height: side });
  // 主进程轮询跟随鼠标：不依赖页面 pointermove。
  // 页面靠 pointer capture 收 move，但甩得快时鼠标会瞬间跑到窗口外，
  // capture 没兜住就断流，窗口就停在原地（用户报的"拖不动"就是这个）。
  stopDragLoop();
  dragTimer = setInterval(dragTick, 16);
});

function dragTick() {
  if (!dragOrigin || !petWin || petWin.isDestroyed()) {
    stopDragLoop();
    dragOrigin = null;
    return;
  }
  const p = screen.getCursorScreenPoint();
  const dx = p.x - dragOrigin.mx;
  const dy = p.y - dragOrigin.my;
  if (dx === 0 && dy === 0) {
    // 鼠标一动不动：如果持续太久，说明 pointerup 丢了（甩出窗口后松手），兜底收尾
    if (Date.now() - dragIdleSince > 2500) endDrag();
    return;
  }
  dragIdleSince = Date.now();
  // 带 width/height 移动：透明窗口在 1.25 缩放下只 setPosition 会逐帧把宽度撑大
  petWin.setBounds({
    x: dragOrigin.wx + dx,
    y: dragOrigin.wy + dy,
    width: dragOrigin.ww,
    height: dragOrigin.wh,
  });
}

function stopDragLoop() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

function endDrag() {
  const had = Boolean(dragOrigin);
  stopDragLoop();
  dragOrigin = null;
  if (had && petWin && !petWin.isDestroyed()) {
    try {
      petWin.webContents.send("pet:drag-cancel");
    } catch {}
  }
  snapPetWindow();
}

// 页面还在按需上报，只用来刷新"鼠标最近动过"的时间戳
ipcMain.on("pet:drag-move", () => {
  if (dragOrigin) dragIdleSince = Date.now();
});

ipcMain.on("pet:drag-end", () => {
  endDrag();
});

ipcMain.on("pet:resize", (_event, dir) => {
  cyclePetSize(Number(dir) || 1);
});
