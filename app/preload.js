// 预加载脚本：只给页面暴露极小的控制面。
// 同一个 preload 同时服务聊天窗（拖拽条上的按钮）和桌宠窗（双击 / 拖动 / 右键）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshPet", {
  /** 展开 / 收起会话列表（宽窗模式） */
  toggleWide: () => ipcRenderer.send("pet:toggle-wide"),
  /** 当前宽窗模式状态 */
  isWide: () => ipcRenderer.sendSync("pet:is-wide"),
  /** 刷新当前页面 */
  reload: () => ipcRenderer.send("pet:reload"),
  /** 忽略缓存强制刷新 */
  hardReload: () => ipcRenderer.send("pet:hard-reload"),

  /** 收成桌宠（聊天窗 → 左下角小桌宠） */
  toPet: () => ipcRenderer.send("pet:to-pet"),
  /** 展开成聊天窗口（桌宠 → 聊天窗） */
  openChat: () => ipcRenderer.send("pet:open-chat"),
  /** 桌宠右键菜单（换形象 / 调大小 / 退出） */
  petMenu: () => ipcRenderer.send("pet:menu"),
  /** 桌宠拖动：按下 / 移动 / 松开 */
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  dragMove: () => ipcRenderer.send("pet:drag-move"),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  /** Ctrl+滚轮调大小：dir = +1 放大，-1 缩小 */
  petResize: (dir) => ipcRenderer.send("pet:resize", dir),
  /** 接收主进程下发的形象素材：{ kind: "builtin" } 或 { kind: "image", src } */
  onAsset: (cb) => {
    ipcRenderer.on("pet:asset", (_event, asset) => cb(asset));
  },
  /** 主进程主动结束拖动（pointerup 丢事件时的兜底），页面收到就恢复待机 */
  onDragCancel: (cb) => {
    ipcRenderer.on("pet:drag-cancel", () => cb());
  },
});
