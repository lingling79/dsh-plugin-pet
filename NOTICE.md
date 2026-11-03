# 素材来源与许可证（NOTICE）

本插件（`dsh-plugin-pet-desktop`）由两部分组成，来源不同，分别声明。

## 1. 代码部分 —— 原创，MIT

- `lib/index.js`、`lib/launcher.mjs`、`cordis.patch.yml`、`package.json`
- `app/main.js`、`app/preload.js`、`app/assets/pet.html`、`app/assets/icon*.png`、`app/assets/icon.ico`

以上为本插件自有代码，按仓库根目录的 `LICENSE`（MIT）发布。

## 2. 桌宠形象与动画素材 —— 来自 PC2005-cloud/dsh-pet，MIT

`app/assets/anims/` 下的 **24 段透明 VP9-alpha webm 动画**（待机呼吸休闲、东张西望、
哈欠连天、超大伸懒腰、原地漂浮踏步、点击回应-元气挥手/开心跃动/傲娇生气/害羞惊讶/
挠痒咯咯笑、被鼠标拖拽悬空反馈、被吓一跳、原地跳跃抓碎头顶物品、睡觉-开始/循环/起来、
轻快摇摆舞、可爱宅舞、凭空生花、小幅度原地360度旋转展示、鲸鱼吐泡泡特效、
原地专心玩魔方、写代码、撸猫）来自：

| 项 | 内容 |
| --- | --- |
| 项目 | **PC2005-cloud/dsh-pet** |
| 版本 | 0.4.1 |
| 仓库 | https://github.com/PC2005-cloud/dsh-pet |
| npm | https://www.npmjs.com/package/dsh-pet |
| 许可证 | **MIT**（Copyright (c) PC2005-cloud，见其仓库 LICENSE） |
| 取得方式 | `npm pack dsh-pet@0.4.1` 后从 `assets/webm/` 提取原始 webm，未做二次编码，仅重命名文件、按用途分类挑选 24 段 |

按 MIT 许可证条款，此处保留原作者署名与许可证声明，再分发合法。

### 与上游的关系

上游 `dsh-pet` 是一个 Cordis 插件，把这套动画渲染在 **DSH 网页界面内**的一个浮窗里。
本插件的做法不同：把同一套动画放进一个 **独立的 Electron 透明窗口**，窗口里嵌的是完整
DSH Web UI，因此桌宠能在 DSH 之外、在任何程序上面独立存在，并且双击能展开成聊天窗口。

两者不共享代码，只共享素材。想用上游那种「界面内浮窗」形态，直接装 `dsh-pet@0.4.1` 即可。

## 3. 上游素材的漫画/形象版权

上游项目里这些角色美术由其作者提供并声明为 MIT。本插件仅作个人桌宠使用与再分发，
未用于商业用途，未修改角色设计。

## 4. 第三方运行时

Electron（v33.4.11）不在本包内，由 `lib/launcher.mjs` 在首次启动时按需下载，
其许可证为 MIT（https://github.com/electron/electron/blob/main/LICENSE）。
