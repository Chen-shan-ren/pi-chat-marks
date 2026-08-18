<div align="center">

# pi-chat-marks

**pi 对话标记点列扩展** — 让每一条对话在右侧一目了然

鼠标悬停看内容 · 点击跳转 · 滚动跟随 · 双向联动 · **Regular & Fullscreen 双模式**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-4B32C3)](https://github.com/earendil-works/pi)

</div>

---

## 📖 简介

在 pi 终端的右侧（滚动条左边）显示一列点，**每个点代表你的一次发送**。配合鼠标/键盘实现对话导航的"可视化"：悬停看内容、点击跳转、滚动联动——长对话不再靠滚轮大海捞针。

```
  对话区内容                         右侧点列
  ┌──────────────────────────────┐  │
  │ 用户：上次的提问...           │  │  •        ← 历史消息（小灰点）
  │ 助手：回复内容...             │  │  •        ← 历史消息
  │                              │  │  ◉        ← 黄色：当前视口位置（随滚动实时移动）
  │ 用户：新的提问...             │  │  ●        ← 绿色：最后一次发送
  │ 助手：正在思考...             │  │
  └──────────────────────────────┘  └────────
                                     ↑ 滚动条
```

---

## ✨ 功能

| 功能 | 说明 |
|------|------|
| **右侧点列** | 每个点 = 一次发送，最新在底部；最多显示 **18 个点** |
| **双高亮指示** | 绿色 `●` = 最后一次发送；黄色 `◉` = 当前视口位置，**随滚动实时跟随**（点列与内容双向联动） |
| **鼠标悬停** | 悬停的点**变大高亮**（`⬤` + 反色），编辑器上方实时显示内容预览（时间 + 前 60 字），移开即消失 |
| **点击跳转** | 左键点击点 → 对话区**直接滚动跳转**到那条消息（基于渲染标记精确定位，重复消息也不会错位） |
| **滚轮翻点** | 对话超过 18 次时，在点列上滚轮即可**上下滑动翻看**所有点（不影响对话区滚动） |
| **键盘索引** | `Ctrl+Alt+M` / `/marks`：可搜索的对话索引，`↑↓` 选择（点列同步高亮）、`Enter` 跳转 |
| **发送即回底** | 发送消息后自动回到底部跟随输出（输出中主动滑动才解除跟随） |
| **会话切换定位** | `/resume`/`/new` 切换会话后直接定位到最新消息 |
| **双模式兼容** | 同时在 **regular** 和 **fullscreen** TUI 模式下完整可用 |

---

## 🚀 快速开始

### 1. 安装

```bash
# 复制到 pi 的全局扩展目录
cp chat-marks.ts ~/.pi/agent/extensions/

# 重启 pi（不是 /reload）
```

**⚠️ 首次启动需要重启（不是 /reload）**：扩展会自动给 pi 的 TUI 组件打补丁（见下文"工作原理"），补丁在进程启动时加载，必须重启生效。

**🔔 首次启动若看到 ⚠️ 提示**：说明补丁未生效（非标准安装/版本不兼容），按提示处理；键盘路径 `Ctrl+Alt+M` 始终可用。

### 2. 验证

```
- 右侧出现点列（有历史消息时）
- 鼠标悬停点 → 变大 + 预览
- Ctrl+Alt+M → 打开对话索引
```

---

## 🖱️ 使用指南

```
鼠标悬停点    → 点变大 + 内容预览（编辑器上方）
左键点击点    → 跳转到该次发送
点列上滚轮    → 上下翻看点（对话超过 18 次时）
Ctrl+Alt+M   → 打开对话索引（键盘路径，可搜索）
/marks        → 同上
```

**点列颜色含义**：

| 颜色/形状 | 含义 |
|-----------|------|
| `•` 灰色小点 | 历史消息 |
| `●` 绿色 | 最后一次发送 |
| `◉` 黄色 | 当前视口位置（滚动联动） |
| `◉` 高亮色 | 键盘索引当前选中 |
| `⬤` 大点+反色 | 鼠标悬停 |

**渲染优先级**：悬停 > 视口位置 > 键盘选中 > 最新消息 > 普通。

---

## 🔄 双模式兼容

扩展同时兼容 pi 的 **regular**（默认）和 **fullscreen**（实验性）两种 TUI 模式，所有功能在两种模式下行为一致：

| 功能 | fullscreen | regular |
|------|-----------|--------|
| 点列渲染 | ✅ | ✅ |
| 鼠标悬停预览 | ✅ 通过补丁钩子拦截 | ✅ 通过终端鼠标追踪 + inputListener |
| 左键点击跳转 | ✅ 通过 ScrollView.scrollTo 精确跳转 | ✅ 通过 OSC133 标记定位 + DECScroll 滚动 |
| 点列滚轮翻看 | ✅ | ✅ |
| 视口联动（黄色 ◉） | ✅ 通过滚动钩子精确同步 | ✅ 通过 previousViewportTop 近似同步 |
| 键盘索引 Ctrl+Alt+M | ✅ | ✅ |
| 发送自动回底 | ✅ | ✅ |

两种模式的核心机制不同：

- **fullscreen 模式**：通过幂等补丁注入 `tui-alt-screen.js` 的鼠标钩子，在 pi 处理鼠标前拦截点列区域的点击/悬停/滚轮；通过 `scroll-view.js` 的滚动钩子实现视口联动
- **regular 模式**：启用终端 SGR 鼠标追踪（协议 1003），通过 `addInputListener` 在 focused component 之前拦截鼠标事件；视口定位读取 TUI 内部 `previousViewportTop`/`previousLines`

---

## 🔧 工作原理

### 鼠标交互：两种模式，两种路径

| | fullscreen | regular |
|---|-----------|---------|
| 鼠标钩子 | 补丁注入 `tui-alt-screen.js` 的 `handleViewportInput` | 终端启用 SGR 鼠标追踪，`addInputListener` 拦截 |
| 滚动条守卫 | 补丁将 `hasOverlay()` 改为 `getTopmostVisibleOverlay()` | 不需要（overlay 不拦截） |
| 选择守卫 | 同上 | 同上 |
| 滚动钩子 | 补丁注入 `scroll-view.js` 的 `scrollTo`/`scrollBy` | 同上（共用 scroll-view.js） |

所有补丁**幂等**（检测到已打则跳过）；pi 升级覆盖文件后，扩展下次加载时**自动重新打补丁**。

### 精确定位：OSC133 标记 + 映射表

- 渲染层每条用户消息带有 OSC133 标记行
- 扩展构建"**标记行 ↔ 消息索引**"精确映射表（游标贪心匹配）
- 跳转和视口指示都查表——重复文本消息、图片消息（无文本）都不会错位

### 视口联动

- **fullscreen**：`ScrollView.scrollTo/scrollBy` 补丁末尾通知扩展 → 读取 `getPrimaryScrollView().scrollTop + viewportHeight/2` → 更新黄色指示点
- **regular**：滚动钩子通知扩展 → 读取 `previousViewportTop + terminalHeight/2` → 近似定位视口中线对应的消息

### 点击跳转

- **fullscreen**：通过 `ScrollView.scrollTo(matchRow)` 精确跳转
- **regular**：通过 OSC133 标记定位目标渲染行，用 DECScroll 命令（`ESC [ n S`/`ESC [ n T`）滚动终端到对应位置

---

## ⚙️ 配置

### 自定义快捷键

编辑 `~/.pi/agent/keybindings.json`，然后 `/reload`：

```json
{
  "tui.altScreen.previousPrompt": "ctrl+alt+up",
  "tui.altScreen.nextPrompt": "ctrl+alt+down"
}
```

### 点列行为

点列上限（18）、悬停预览等行为在 `chat-marks.ts` 中常量定义，可按需修改。

---

## ❓ 常见问题（FAQ）

**Q：为什么鼠标悬停没反应？**
悬停需要终端支持**鼠标移动追踪**（协议 1003）：Windows Terminal / WezTerm / Ghostty 等支持；经典 cmd（conhost）不支持，悬停不可用——但**点击和滚轮可用**（conhost 支持点击/滚轮上报）。建议使用 Windows Terminal。

**Q：为什么装了之后滚动条/拖选复制失效了？**
旧版本的一个 bug（overlay 误禁用滚动条/选择），已通过"滚动条守卫/选择守卫"补丁修复。请确认使用的是最新版本并已重启。

**Q：装了没效果（鼠标没反应）怎么办？**
启动时会提示原因（⚠️ 通知）：找不到 pi 的 TUI 组件文件（非标准安装方式）、pi 版本不兼容（补丁点未找到）、或未重启。按提示处理；键盘路径 `Ctrl+Alt+M` 始终可用。

**Q：为什么必须重启而不是 /reload？**
鼠标钩子补丁修改的是 pi 的 TUI 组件文件，组件类在进程启动时就加载进内存了——`/reload` 只重载扩展，不会重新加载 pi 的 TUI。**重启一次即可**，之后更新扩展代码（不涉及新补丁）用 `/reload` 就行。

**Q：点列为什么最多 18 个点？**
避免右侧视觉噪点。超过 18 次对话后，在点列上滚动滚轮即可翻看所有点。

**Q：会不会影响打字/选择/滚动？**
不会。点列是 `nonCapturing` overlay（不抢键盘焦点）；点列区域外的鼠标事件原样放行（拖选复制、滚动条拖动、滚轮滚动对话区都正常）。

**Q：regular 模式下鼠标会干扰其他操作吗？**
不会。鼠标追踪仅在点列区域激活时消费事件；区域外的滚轮转为终端滚动（DECScroll），点击被消费但不影响编辑器正常交互。切换会话或关闭时自动禁用追踪。

**Q：regular 模式下的视口指示和跳转不够精确吗？**
approximate 级别。regular 模式下 pi 不使用 ScrollView 而是直接写入终端主屏幕，无法通过 API 精确控制滚动位置；视口指示使用 TUI 内部 `previousViewportTop` 近似定位，点击跳转使用 DECScroll 近似滚动。绝大多数场景下体验与 fullscreen 一致。

**Q：扩展修改了 pi 的安装文件，安全吗？**
补丁是**幂等、可恢复**的：只插入几行钩子调用（见上文表格），pi 升级覆盖文件后扩展会自动重新打补丁。不想要了：删除扩展文件即可（补丁代码保留但不再被调用，不影响功能）。

---

## 🗂️ 项目结构

```
chat-marks.ts   # 扩展主体（单文件，直接可用）
README.md       # 本文档
```

---

## 📝 更新日志

| 版本 | 内容 |
|------|------|
| v5 | **双模式兼容**：regular + fullscreen 双模式鼠标交互、视口指示、点击跳转全部可用 |
| v4 | 点击点改为滚动对话区跳转（不再弹窗展示） |
| v3 | 悬停改为编辑器上方非模态 widget 展示内容 |
| v2 | 点列 overlay 加 nonCapturing，修掉启动抢焦点 |
| v1 | 初始版本：右侧点列、鼠标悬停预览、点击跳转、滚动联动、键盘索引 |

---

## 🤝 贡献

欢迎提交 Issue 和 PR：

- 交互改进（悬停预览位置、点列样式）
- 新终端兼容性适配
- 文档改进

调试日志：设置环境变量 `CHAT_MARKS_DEBUG=1` 后重启 pi，可在启动时看到补丁日志。

---

## 📄 License

本项目采用 **MIT License**，全文本见 [LICENSE](LICENSE)。

```
MIT License

Copyright (c) 2026 Chen-shan-ren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
