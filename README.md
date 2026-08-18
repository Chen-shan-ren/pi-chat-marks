<div align="center">

# pi-chat-marks

**pi 对话标记点列扩展** — 让每一条对话在右侧一目了然

鼠标悬停看内容 · 点击跳转 · 滚动跟随 · 双向联动

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

---

## 🚀 快速开始

### 1. 安装

```bash
# 复制到 pi 的全局扩展目录
cp chat-marks.ts ~/.pi/agent/extensions/

# 重启 pi
```

**⚠️ 首次启动需要重启（不是 /reload）**：扩展会自动给 pi 的 TUI 组件打补丁（见下文"工作原理"），补丁在进程启动时加载，必须重启生效。

### 2. 验证

```
/mm-status 不适用本扩展 —— 直接看：
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

## 🔧 工作原理

### 鼠标交互：钩子补丁

pi 的 TUI 会先于扩展消费鼠标事件（点击会被当成拖选复制）。本扩展在加载时**自动幂等**地对 pi 安装目录打补丁：

| 补丁 | 文件 | 作用 |
|------|------|------|
| 鼠标钩子 | `tui-alt-screen.js` | 在 pi 处理鼠标前拦截点列区域的点击/悬停/滚轮 |
| 滚动条守卫 | `tui-alt-screen.js` | 非捕获 overlay 不再禁用滚动条点击/拖动 |
| 选择守卫 | `tui-alt-screen.js` | 非捕获 overlay 不再禁用文本拖选复制 |
| 滚动钩子 | `scroll-view.js`（×2） | 所有滚动（滚轮/键盘/滚动条/搜索）通知扩展，驱动视口指示点 |

补丁全部**幂等**（检测到已打则跳过）；pi 升级覆盖文件后，扩展下次加载时**自动重新打补丁**。

### 精确定位：OSC133 标记 + 映射表

- 渲染层每条用户消息带有 OSC133 标记行
- 扩展构建"**标记行 ↔ 消息索引**"精确映射表（游标贪心匹配）
- 跳转和视口指示都查表——重复文本消息、图片消息（无文本）都不会错位

### 视口联动：滚动钩子

`ScrollView.scrollTo/scrollBy` 是所有滚动的汇聚点，补丁在其末尾通知扩展 → 扩展读取视口中线对应的消息 → 更新黄色指示点，并让点列窗口跟随视口（目标点始终可见）。

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

**Q：点击点为什么之前会出现 "Copied!"？**
那是 pi 把点击当成了"拖选复制"（闪出 Copied 提示）。本扩展的鼠标钩子补丁会拦截点列区域的点击，这个问题已消除。

**Q：为什么装了之后滚动条/拖选复制失效了？**
那是旧版本的 bug（overlay 误禁用滚动条/选择），已通过"滚动条守卫/选择守卫"补丁修复。请确认使用的是最新版本并已重启。

**Q：装完没效果（鼠标没反应）怎么办？**
启动时会提示原因（⚠️ 通知）：找不到 pi 的 TUI 组件文件（非标准安装方式）、pi 版本不兼容（补丁点未找到）、或未重启。按提示处理；键盘路径 `Ctrl+Alt+M` 始终可用。

**Q：为什么必须重启而不是 /reload？**
鼠标钩子补丁修改的是 pi 的 TUI 组件文件，组件类在进程启动时就加载进内存了——`/reload` 只重载扩展，不会重新加载 pi 的 TUI。**重启一次即可**，之后更新扩展代码（不涉及新补丁）用 `/reload` 就行。

**Q：点列为什么最多 18 个点？**
避免右侧视觉噪点。超过 18 次对话后，在点列上滚动滚轮即可翻看所有点。

**Q：会不会影响打字/选择/滚动？**
不会。点列是 `nonCapturing` overlay（不抢键盘焦点）；点列区域外的鼠标事件原样放行（拖选复制、滚动条拖动、滚轮滚动对话区都正常）。

**Q：扩展修改了 pi 的安装文件，安全吗？**
补丁是**幂等、可恢复**的：只插入几行钩子调用（见上文表格），pi 升级覆盖文件后扩展会自动重新打补丁。不想要了：删除扩展文件即可（补丁代码保留但不再被调用，不影响功能）。

---

## 🗂️ 项目结构

```
chat-marks.ts   # 扩展主体（单文件，直接可用）
```

---

## 📝 更新日志

| 版本 | 内容 |
|------|------|
| 2026-08 | 初始版本：右侧点列、鼠标悬停预览、点击跳转、滚动联动、键盘索引、发送自动跟随输出（持续迭代） |

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
