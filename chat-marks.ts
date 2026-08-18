/**
 * chat-marks.ts — 对话标记点列（Chat Marks）
 *
 * 在终端右侧（滚动条左边）显示一列点，每个点代表你的一次发送（用户消息），
 * 最新的在最底部。支持鼠标交互：
 *
 *   - 鼠标悬停点：该点变大高亮，同时在编辑器上方显示该次发送的内容预览
 *     （hover 需要终端支持鼠标移动追踪：Windows Terminal / WezTerm 等支持；
 *      经典 cmd/conhost 不支持移动追踪，hover 不可用，但点击/滚轮可用）
 *   - 鼠标左键点击点：对话区直接滚动跳转到你发送的那条消息所在位置
 *     （省去手动滚轮；定位依据是渲染行中的 OSC133 提示标记 + 消息文本匹配）
 *   - 鼠标滚轮在点列上滚动：对话多时上下翻看点（不滚动 transcript）
 *   - Ctrl+Alt+M 或 /marks：打开"对话索引"选择器（键盘路径，两种模式通用）
 *        ↑↓ 选择（点列同步高亮）· Enter 跳转到该消息 · Esc 关闭
 *
 * 说明：
 *   - fullscreen 模式：鼠标交互全部可用（点击/滚轮/hover 取决于终端）
 *   - regular 模式：终端未启用鼠标追踪，点列为纯视觉，用 Ctrl+Alt+M 键盘交互
 *   - 点击点列区域被本扩展消费，不会再触发 alt-screen 的拖选复制
 *
 * 历史（修复记录）：
 *   - v1 用 modal overlay 弹窗展示详情，会抢占键盘焦点（未传 nonCapturing），
 *     导致重启后输入框无法打字；弹窗打开期间打字也被模态拦截。
 *   - v2 给常驻点列 overlay 加 nonCapturing: true，修掉启动即抢焦点的问题。
 *   - v3 点击点改为编辑器上方非模态 widget 展示内容。
 *   - v4（本版）按用户需求：点击点直接滚动对话区跳转到该消息，不做内容展示。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

interface UserMsg {
  id: string;
  timestamp: number;
  text: string;
}

interface SgrMouse {
  button: number;
  x: number;
  y: number;
  press: boolean;
}

// 与 pi-tui 内部一致的 OSC133 提示开始标记（用户消息首行以此开头）
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

/** 去掉 OSC133 标记与所有 ANSI 转义，取纯可见文本 */
function stripAnsi(s: string): string {
  return s
    .replace(/^\x1b\]133;A(?:\x07|\x1b\\)/, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let messages: UserMsg[] = [];
  let selectedIndex = -1; // 键盘索引当前选中（点列高亮）
  let hoverIndex = -1; // 鼠标悬停的点
  let viewportIndex = -1; // 当前视口位置对应的消息（随 transcript 滚动联动）
  let scrollOffset = 0; // 点列滚动偏移（消息多时）
  let sessionCtx: ExtensionContext | undefined;
  let dotsTui: { requestRender(): void } | undefined;
  let rowMapCache: { lines: string[]; map: Map<number, number> } | undefined; // 标记行→消息索引映射缓存

  // ---- 工具函数 ----

  function extractText(content: unknown[] | undefined): string {
    return (content ?? [])
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("")
      .trim();
  }

  function preview(text: string, n = 40): string {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n) + "…" : one;
  }

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** 解析 SGR 鼠标序列：ESC[<b;x;yM（按下）/ m（释放）。返回 null 表示非鼠标事件。 */
  function parseSgrMouse(data: string): SgrMouse | null {
    const m = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!m) return null;
    return {
      button: parseInt(m[1], 10),
      x: parseInt(m[2], 10),
      y: parseInt(m[3], 10),
      press: m[4] === "M",
    };
  }

  // ---- 点列几何与渲染 ----

  /** 终端当前尺寸（来自钩子传入的 tui） */
  function termSize(): { rows: number; columns: number } {
    const t = dotsTui as unknown as { terminal?: { rows?: number; columns?: number } } | undefined;
    return { rows: t?.terminal?.rows ?? 30, columns: t?.terminal?.columns ?? 80 };
  }

  /** 点列显示的最大行数：固定上限 18 个点；终端过矮时按可用高度缩小（不少于 4） */
  function dotsMaxRows(): number {
    return Math.max(4, Math.min(18, termSize().rows - 8));
  }

  function dotsCount(): number {
    return Math.min(messages.length, dotsMaxRows());
  }

  function clampOffset(): void {
    const max = Math.max(0, messages.length - dotsCount());
    if (scrollOffset > max) scrollOffset = max;
    if (scrollOffset < 0) scrollOffset = 0;
  }

  /** 点列区域的顶部行（0-based） */
  function dotsTopRow(): number {
    return Math.max(0, Math.floor((termSize().rows - dotsCount()) / 2));
  }

  /** 屏幕行号 y（1-based）对应的消息索引，不在点列内返回 -1 */
  function indexAtRow(y: number): number {
    const v = y - 1 - dotsTopRow();
    const i = scrollOffset + v;
    return i >= 0 && i < messages.length ? i : -1;
  }

  function renderDots(width: number, theme: {
    fg(color: string, s: string): string;
    bold(s: string): string;
    bg(color: string, s: string): string;
  }): string[] {
    clampOffset();
    const count = dotsCount();
    const rows: string[] = [];
    for (let v = 0; v < count; v++) {
      const i = scrollOffset + v;
      let dot: string;
      if (i === hoverIndex) {
        // 悬停：最大点 + 反色背景 + 高亮色，与普通点对比强烈
        dot = theme.bold(theme.fg("accent", theme.bg("selectedBg", "⬤")));
      } else if (i === viewportIndex) {
        // 视口位置：黄色中号点（随 transcript 滚动联动）
        dot = theme.fg("warning", "◉");
      } else if (i === selectedIndex) {
        dot = theme.fg("accent", "◉");
      } else if (i === messages.length - 1) {
        // 最新（end）消息：绿色
        dot = theme.fg("success", "●");
      } else {
        // 普通：小点，避免视觉噪点
        dot = theme.fg("muted", "•");
      }
      rows.push(width > 1 ? " " + dot : dot);
    }
    return rows;
  }

  /**
   * 视口位置指示：读取 transcript 滚动位置，通过映射表找到视口中线对应的消息，
   * 更新 viewportIndex（点列中的黄色 ◉），并让点列窗口跟随视口。所有滚动（鼠标
   * 滚轮/键盘/滚动条/搜索）都会经过 ScrollView.scrollTo/scrollBy（补丁注入 __piScrollHook）。
   */
  function updateViewportIndicator(): void {
    const t = dotsTui as unknown as {
      currentLayout?: unknown;
      getPrimaryScrollView?(): {
        scrollTop: number;
        viewportHeight: number;
      };
      requestRender(): void;
    } | undefined;
    if (!t?.getPrimaryScrollView || !t.currentLayout) return;
    const sv = t.getPrimaryScrollView();
    const box = findScrollViewBox(t.currentLayout, sv);
    const lines = box?.scrollContentLines;
    if (!lines || lines.length === 0) return;
    const mid = Math.min(sv.scrollTop + Math.floor(sv.viewportHeight / 2), lines.length - 1);
    // 从视口中线向上找最近的、能映射到消息的标记行（跳过图片消息等无文本标记）
    const map = getRowMap(lines);
    let markRow = -1;
    for (let row = mid; row >= 0; row--) {
      if (OSC133_PROMPT_START.test(lines[row] ?? "") && map.has(row)) {
        markRow = row;
        break;
      }
    }
    const next = markRow >= 0 ? (map.get(markRow) ?? -1) : -1;
    if (next !== viewportIndex) {
      viewportIndex = next;
      t.requestRender();
    }
    syncWindowToViewport();
  }

  // ---- 跳转到指定用户消息 ----

  /** 与 pi-tui 内部 getScrollViewBox 等价：在布局树中找滚动视图对应的盒子 */
  function findScrollViewBox(frame: unknown, scrollView: unknown): { scrollContentLines?: string[] } | undefined {
    const visit = (box: { scrollView?: unknown; children?: unknown[] } | undefined): { scrollContentLines?: string[] } | undefined => {
      if (!box) return undefined;
      if (box.scrollView === scrollView) return box as { scrollContentLines?: string[] };
      for (const child of box.children ?? []) {
        const m = visit(child as { scrollView?: unknown; children?: unknown[] });
        if (m) return m;
      }
      return undefined;
    };
    const root = (frame as { root?: unknown } | undefined)?.root;
    return visit(root as { scrollView?: unknown; children?: unknown[] });
  }

  /**
   * 判断一个渲染行是否为某条消息的首行：
   * - 短消息（首行能容纳全文）：要求整行文本与消息文本完全一致
   * - 长消息（首行只是开头）：要求首行（≥4 字符）是消息文本的前缀
   */
  function matchesPromptRow(visible: string, targetText: string): boolean {
    if (!visible) return false;
    if (targetText.length <= visible.length) return visible === targetText;
    return visible.length >= 4 && targetText.startsWith(visible);
  }

  /**
   * 构建“渲染标记行 → messages 索引”的精确映射。
   * 不能用标记行序号直接当消息索引：messages 只收集有文本的用户消息，
   * 图片消息/空文本消息在渲染中有标记行但没有对应条目；文本也可能重复。
   * 算法：游标贪心匹配——每个标记行取首段可见文本，从上次匹配位置之后找第一条
   * 文本匹配的消息（文本匹配失败说明该标记行对应图片/空消息，跳过）。
   */
  function buildRowMap(lines: string[]): Map<number, number> {
    const map = new Map<number, number>();
    let cursor = 0;
    for (let row = 0; row < lines.length; row++) {
      if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
      let visible = stripAnsi(lines[row] ?? "");
      if (!visible) {
        for (let r2 = row + 1; r2 < lines.length; r2++) {
          if (OSC133_PROMPT_START.test(lines[r2] ?? "")) break;
          visible = stripAnsi(lines[r2] ?? "");
          if (visible) break;
        }
      }
      if (!visible) continue;
      for (let j = cursor; j < messages.length; j++) {
        if (matchesPromptRow(visible, messages[j].text.trim())) {
          map.set(row, j);
          cursor = j + 1;
          break;
        }
      }
    }
    return map;
  }

  function getRowMap(lines: string[]): Map<number, number> {
    if (rowMapCache && rowMapCache.lines === lines) return rowMapCache.map;
    const map = buildRowMap(lines);
    rowMapCache = { lines, map };
    return map;
  }

  /** 点列窗口跟随视口：目标消息不在可见窗口时滑动窗口，让黄色指示点始终可见；
   *  视口位于最近 count 条内时窗口回到最新（保持绿色最新点可见）。 */
  function syncWindowToViewport(): void {
    const count = dotsCount();
    if (count <= 0 || viewportIndex < 0) return;
    const maxOffset = Math.max(0, messages.length - count);
    if (viewportIndex >= scrollOffset && viewportIndex < scrollOffset + count) return;
    let target: number;
    if (viewportIndex >= messages.length - count) {
      target = maxOffset; // 视口在最近 count 条内 → 显示最新窗口
    } else {
      target = Math.max(0, Math.min(maxOffset, viewportIndex - Math.floor(count / 2)));
    }
    if (target !== scrollOffset) {
      scrollOffset = target;
      dotsTui?.requestRender();
    }
  }

  /** 在渲染行中定位第 index 条用户消息并滚动过去。返回是否成功。 */
  function jumpToMessage(index: number): boolean {
    const t = dotsTui as unknown as {
      currentLayout?: unknown;
      getPrimaryScrollView(): { scrollTo(row: number): void };
      requestRender(): void;
      flash?(message: string, durationMs?: number): void;
    } | undefined;
    if (!t || !t.currentLayout) return false;
    const sv = t.getPrimaryScrollView();
    const box = findScrollViewBox(t.currentLayout, sv);
    const lines = box?.scrollContentLines;
    if (!lines || lines.length === 0) return false;
    const target = messages[index];
    if (!target) return false;

    // 精确映射表定位（不依赖文本计数，杜绝重复消息错位）
    const map = getRowMap(lines);
    let matchRow = -1;
    for (const [row, msgIndex] of map) {
      if (msgIndex === index) {
        matchRow = row;
        break;
      }
    }
    if (matchRow < 0) return false;

    sv.scrollTo(matchRow);
    t.requestRender();
    t.flash?.(`已跳转到第 ${index + 1}/${messages.length} 次发送 · ${fmtTime(target.timestamp)}`, 1500);
    return true;
  }

  // ---- 鼠标钩子补丁 ----

  const PATCH_MARK = "__piMouseHook";
  const PATCH_ANCHOR =
    '        if (data === FOCUS_IN)\n            return { consume: true };\n        const wheelEvent = this.parseWheelEvent(data);';
  const PATCH_INSERT =
    '        if (data === FOCUS_IN)\n            return { consume: true };\n' +
    '        // [chat-marks-patch] mouse hook\n' +
    '        const __cmHook = globalThis.__piMouseHook;\n' +
    '        if (__cmHook && typeof data === "string" && data.startsWith("\\x1b[<")) {\n' +
    '            const __cmResult = __cmHook(data, this);\n' +
    '            if (__cmResult && __cmResult.consume)\n' +
    '                return { consume: true };\n' +
    '        }\n' +
    '        const wheelEvent = this.parseWheelEvent(data);';

  // 常驻点列是 nonCapturing overlay，但 pi 的滚动条/选择逻辑用 hasOverlay() 判定，
  // 导致只要有任何 overlay 存在（含非捕获的常驻点列），滚动条点击/拖拽和文本选择全部失效。
  // 补丁：改用 getTopmostVisibleOverlay()（只统计捕获型 overlay），非捕获 overlay 不再禁用滚动条。
  const PATCH2_MARK = "__piScrollbarGuardPatch";
  const PATCH2_ANCHOR =
    "    getScrollbarTargetAt(x, y) {\n" +
    "        if (this.hasOverlay() || !this.currentLayout)\n" +
    "            return undefined;";
  const PATCH2_INSERT =
    "    getScrollbarTargetAt(x, y) {\n" +
    "        // [chat-marks-patch] __piScrollbarGuardPatch: non-capturing overlays must not disable the scrollbar\n" +
    "        if (this.getTopmostVisibleOverlay() || !this.currentLayout)\n" +
    "            return undefined;";
  const PATCH3_MARK = "__piSelectionGuardPatch";
  const PATCH3_ANCHOR =
    "        const scrollView = !this.hasOverlay() && this.currentLayout\n" +
    "            ? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]\n" +
    "            : undefined;";
  const PATCH3_INSERT =
    "        // [chat-marks-patch] __piSelectionGuardPatch: non-capturing overlays must not disable selection\n" +
    "        const scrollView = !this.getTopmostVisibleOverlay() && this.currentLayout\n" +
    "            ? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]\n" +
    "            : undefined;";
  // 滚动钩子补丁（scroll-view.js）：所有滚动（鼠标滚轮/键盘/滚动条/搜索/自动跟随）
  // 都汇聚到 ScrollView.scrollTo/scrollBy，在其末尾通知扩展（视口位置指示联动）。
  const PATCH4_MARK = "__piScrollHook";
  const PATCH4_ANCHOR =
    "        if (moved)\n            this.markScrollbarActivity();\n        this.requestRenderCallback?.();\n    }\n    scrollBy(lines) {";
  const PATCH4_INSERT =
    "        if (moved)\n            this.markScrollbarActivity();\n        this.requestRenderCallback?.();\n        globalThis.__piScrollHook?.(this);\n    }\n    scrollBy(lines) {";
  const PATCH5_MARK = "__piScrollHookBy";
  const PATCH5_ANCHOR =
    "        if (moved !== 0 || this.followingEnd !== wasFollowingEnd)\n            this.requestRenderCallback?.();\n        return requested - moved;";
  const PATCH5_INSERT =
    "        if (moved !== 0 || this.followingEnd !== wasFollowingEnd)\n            this.requestRenderCallback?.();\n        // [chat-marks-patch] __piScrollHookBy: scrollBy hook\n        globalThis.__piScrollHook?.(this);\n        return requested - moved;";

  function findTuiAltScreenPath(): string | undefined {
    const candidates: string[] = [];
    try {
      const req = (globalThis as { require?: NodeRequire }).require ?? require;
      const pkgEntry = req.resolve("@earendil-works/pi-coding-agent");
      // pi-tui 嵌套在 pi-coding-agent 包的 node_modules 下
      candidates.push(
        join(dirname(dirname(pkgEntry)), "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"),
      );
    } catch {
      // 忽略，继续尝试其他候选
    }
    const execDir = dirname(process.execPath);
    candidates.push(join(execDir, "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
    candidates.push(join(process.cwd(), "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
    // 全局 npm 安装位置（npm root -g 的常见路径）
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
      if (root) {
        candidates.push(join(root, "@earendil-works/pi-tui/dist/tui-alt-screen.js"));
        candidates.push(join(root, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
      }
    } catch {
      // 无 npm 或执行失败，忽略
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  }

  /** scroll-view.js 与 tui-alt-screen.js 同目录（../components/scroll-view.js） */
  function findScrollViewPath(): string | undefined {
    const alt = findTuiAltScreenPath();
    if (!alt) return undefined;
    const p = join(dirname(alt), "components", "scroll-view.js");
    return existsSync(p) ? p : undefined;
  }

  /** 对 tui-alt-screen.js 应用幂等补丁：patch 未生效（含标记）时替换 anchor。 */
  // 注意：TUI 模式下 console.* 会直接污染终端屏幕（扩展重载时重新打印），
  // 因此补丁日志全部静默，仅在显式调试（CHAT_MARKS_DEBUG=1）时输出。
  const debug = process.env.CHAT_MARKS_DEBUG === "1";
  const log = debug ? (msg: string) => console.log(msg) : () => {};
  const warn = debug ? (msg: string) => console.warn(msg) : () => {};

  function applyIdempotentPatch(file: string, mark: string, anchor: string, insert: string, label: string): void {
    const src = readFileSync(file, "utf8");
    if (src.includes(mark)) return; // 已打过补丁
    if (!src.includes(anchor)) {
      if (!patchProblem) {
        patchProblem = `pi 版本与扩展不兼容（补丁点 ${label} 未找到）。请更新 pi-chat-marks 扩展，或提 Issue 适配新版本；键盘路径 Ctrl+Alt+M 仍可用`;
      }
      warn(`[chat-marks] tui-alt-screen.js 版本不匹配，无法打补丁（${label}）`);
      return;
    }
    writeFileSync(file, src.replace(anchor, insert), "utf8");
    log(`[chat-marks] 已打补丁（${label}）:`, file);
  }

  /** 幂等补丁：插入鼠标钩子调用点、滚动钩子调用点，并放开非捕获 overlay 对滚动条/选择的禁用。 */
  let patchProblem: string | undefined; // 补丁问题描述（用于启动时提示用户）

  function ensureAltScreenPatches(): void {
    try {
      const file = findTuiAltScreenPath();
      if (!file) {
        patchProblem = "未找到 pi 的 TUI 组件文件（tui-alt-screen.js），鼠标交互不可用；键盘路径 Ctrl+Alt+M 仍可用";
        warn("[chat-marks] " + patchProblem);
      } else {
        applyIdempotentPatch(file, PATCH_MARK, PATCH_ANCHOR, PATCH_INSERT, "鼠标钩子");
        applyIdempotentPatch(file, PATCH2_MARK, PATCH2_ANCHOR, PATCH2_INSERT, "滚动条守卫");
        applyIdempotentPatch(file, PATCH3_MARK, PATCH3_ANCHOR, PATCH3_INSERT, "选择守卫");
      }
      const scrollFile = findScrollViewPath();
      if (!scrollFile) {
        if (!patchProblem) {
          patchProblem = "未找到 pi 的滚动组件（scroll-view.js），视口位置指示不可用；鼠标点击/悬停仍可用";
        }
        warn("[chat-marks] 未找到 scroll-view.js，视口位置指示不可用");
      } else {
        applyIdempotentPatch(scrollFile, PATCH4_MARK, PATCH4_ANCHOR, PATCH4_INSERT, "滚动钩子 scrollTo");
        applyIdempotentPatch(scrollFile, PATCH5_MARK, PATCH5_ANCHOR, PATCH5_INSERT, "滚动钩子 scrollBy");
      }
    } catch (err) {
      patchProblem = "打补丁失败：" + (err instanceof Error ? err.message : String(err));
      warn("[chat-marks] " + patchProblem);
    }
  }

  // ---- 交互 ----

  /**
   * 让聊天区滚动条常驻可见可点。
   * pi 的滚动条默认是瞬态的（滚动动作后约 1 秒隐藏，隐藏期间点击无效，且悬停无法重新唤起），
   * 这在有常驻点列时很容易让用户以为滚动条被点列挡住。这里在首次鼠标事件时把
   * 聊天主滚动条的隐藏延迟调大并强制可见（只影响聊天区滚动条，不影响其他 UI）。
   */
  let scrollbarPersisted = false;
  function ensureTranscriptScrollbarPersistent(): void {
    if (scrollbarPersisted) return;
    const t = dotsTui as unknown as {
      getPrimaryScrollView?(): {
        scrollbarHideDelayMs?: number;
        transientScrollbarVisible?: boolean;
      };
    } | undefined;
    const sv = t?.getPrimaryScrollView?.();
    if (!sv) return;
    scrollbarPersisted = true;
    try {
      sv.scrollbarHideDelayMs = 600_000; // 10 分钟后再隐藏（实际相当于常驻）
      sv.transientScrollbarVisible = true; // 立即显示
    } catch {
      /* 忽略 */
    }
  }

  /** 鼠标事件是否落在点列区域 */
  function inDotsRegion(x: number, y: number): boolean {
    const { columns, rows } = termSize();
    if (x < columns - 2 || x > columns - 1) return false; // 点列占右数第 2、3 列（scrollbar 在最右列）
    const count = dotsCount();
    if (count === 0) return false;
    const top = dotsTopRow();
    return y >= top + 1 && y <= top + count && y <= rows;
  }

  function handleMouse(data: string, tui: unknown): { consume?: boolean } | undefined {
    dotsTui = tui as { requestRender(): void } | undefined;
    ensureTranscriptScrollbarPersistent();
    const mouse = parseSgrMouse(data);
    if (!mouse) return undefined;

    // SGR 按钮编码：<32=点击/释放，32-63=移动，>=64=滚轮；低位 2 位=按钮号(0左1中2右3释放)
    const btn = mouse.button & 3;
    const isMove = mouse.button >= 32 && mouse.button < 64;
    const isWheel = mouse.button >= 64;

    if (!inDotsRegion(mouse.x, mouse.y)) {
      // 点列区域外：放行（保留 alt-screen 的拖选复制/滚动条/滚轮滚动）
      if ((isMove || (btn === 0 && mouse.press)) && hoverIndex !== -1) {
        hoverIndex = -1;
        updateHoverPreview();
        dotsTui?.requestRender();
      }
      return undefined;
    }

    const target = indexAtRow(mouse.y);

    // 移动事件：悬停
    if (isMove) {
      if (target !== hoverIndex) {
        hoverIndex = target;
        updateHoverPreview();
        dotsTui?.requestRender();
      }
      return { consume: true };
    }

    // 滚轮：滚动点列（64=上 65=下，忽略修饰键）
    if (isWheel) {
      if (btn === 0) scrollOffset--;
      else scrollOffset++;
      clampOffset();
      dotsTui?.requestRender();
      return { consume: true };
    }

    // 左键点击：跳转到该消息在对话区的位置
    if (btn === 0 && mouse.press) {
      if (target >= 0) {
        hoverIndex = -1;
        updateHoverPreview();
        const ok = jumpToMessage(target);
        if (!ok) {
          sessionCtx?.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        }
        dotsTui?.requestRender();
      }
      return { consume: true };
    }

    // 中键/右键在点列区域：一律消费，避免触发粘贴/选择；释放事件也消费（防复制）
    if (btn === 1 || btn === 2 || !mouse.press) {
      return { consume: true };
    }

    return undefined;
  }

  function updateHoverPreview(): void {
    if (!sessionCtx) return;
    if (hoverIndex >= 0 && hoverIndex < messages.length) {
      const m = messages[hoverIndex];
      sessionCtx.ui.setWidget("chat-marks-preview", [
        `${m.text.length > 0 ? `⏱ ${fmtTime(m.timestamp)} · 第 ${hoverIndex + 1} 次发送` : ""}`,
        `${preview(m.text, 60)}`,
      ]);
    } else {
      sessionCtx.ui.setWidget("chat-marks-preview", undefined);
    }
  }

  // ---- 键盘路径：对话索引选择器 ----

  async function openMarks(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("对话索引仅交互模式可用", "info");
      return;
    }
    if (messages.length === 0) {
      ctx.ui.notify("还没有用户消息", "warning");
      return;
    }
    const items = messages.map((m, i) => ({
      value: String(i),
      label: `${fmtTime(m.timestamp)}  ${preview(m.text, 30)}`,
    }));

    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("对话索引（Enter 跳转 · Esc 关闭）")), 1, 0),
      );
      const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
      list.onSelect = (item) => {
        // 跳转到该消息，然后立即关闭选择器，焦点回到输入框
        selectedIndex = Number(item.value);
        const ok = jumpToMessage(selectedIndex);
        if (!ok) {
          ctx.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        }
        done(undefined);
      };
      list.onCancel = () => {
        done(undefined);
      };
      list.onSelectionChange = (item) => {
        selectedIndex = Number(item.value);
        tui.requestRender();
      };
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        width: "60%",
        maxHeight: "80%",
        anchor: "center",
      },
    });
    selectedIndex = -1;
    dotsTui?.requestRender();
  }

  // ---- 事件 ----

  pi.on("session_start", async (_event, ctx) => {
    if (patchProblem && ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify("[chat-marks] ⚠️ " + patchProblem, "warning");
    }
    messages = [];
    selectedIndex = -1;
    hoverIndex = -1;
    scrollOffset = 0;
    sessionCtx = ctx;
    dotsTui = undefined;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    // 安装鼠标钩子（alt-screen 的 handleViewportInput 会先调用它）
    (globalThis as unknown as Record<string, unknown>)["__piMouseHook"] = (data: string, tui: unknown) =>
      handleMouse(data, tui as never);
    // 安装滚动钩子（ScrollView.scrollTo/scrollBy 末尾调用，视口指示联动）
    (globalThis as unknown as Record<string, unknown>)["__piScrollHook"] = () => {
      updateViewportIndicator();
    };

    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message?.role === "user") {
          const text = extractText(entry.message.content);
          if (text) {
            messages.push({
              id: entry.id,
              timestamp: entry.message.timestamp ?? Date.now(),
              text,
            });
          }
        }
      }
    } catch {
      // 历史读取失败不影响使用
    }

    // 常驻点列 overlay（贴右边缘，滚动条左侧）
    // 必须 nonCapturing：常驻 overlay 一旦捕获焦点，输入框将永远无法打字
    void ctx.ui.custom((tui, theme) => {
      dotsTui = tui;
      return {
        render: (w: number) => renderDots(w, theme),
        invalidate: () => {},
        handleInput: () => {},
      };
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        offsetX: -1,
        width: 2,
        maxHeight: "90%",
        nonCapturing: true,
      },
    });

    // 等 transcript 布局渲染完成后：强制滚到底部并同步视口指示。
    // 修复：点击跳转（或手动滚动）后 followingEnd 被破坏，/resume 切换会话时
    // pi 复用 ScrollView 且不重置滚动位置，导致新会话停在中间而非底部。
    setTimeout(() => {
      try {
        (dotsTui as unknown as { scrollToBottom?(): void } | undefined)?.scrollToBottom?.();
      } catch {
        // 忽略
      }
      updateViewportIndicator();
    }, 200);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "user") return;
    const text = extractText(event.message.content);
    if (!text) return;
    messages.push({
      id: String(Date.now()),
      timestamp: event.message.timestamp ?? Date.now(),
      text,
    });
    rowMapCache = undefined; // 内容变化，标记行映射失效
    clampOffset();
    // 用户发送消息时强制回到底部跟随输出（pi 原生行为是：用户滚动后发送消息
    // 不自动恢复跟随，这里补上“发送即回底”的预期；输出过程中用户主动滑动
    // 仍会解除跟随，不影响浏览）
    try {
      (dotsTui as unknown as { scrollToBottom?(): void } | undefined)?.scrollToBottom?.();
    } catch {
      // 忽略
    }
    dotsTui?.requestRender();
    // 新消息加入后内容变化，重新同步视口指示
    setTimeout(() => updateViewportIndicator(), 100);
  });

  pi.on("session_shutdown", () => {
    (globalThis as unknown as Record<string, unknown>)["__piMouseHook"] = undefined;
    (globalThis as unknown as Record<string, unknown>)["__piScrollHook"] = undefined;
    sessionCtx = undefined;
  });

  // ---- 入口 ----

  pi.registerShortcut("ctrl+alt+m", {
    description: "打开对话索引（跳转到指定消息）",
    handler: (ctx) => void openMarks(ctx),
  });

  pi.registerCommand("marks", {
    description: "打开对话索引：跳转到指定消息（Enter 跳转，Esc 关闭）",
    handler: (_args, ctx) => openMarks(ctx),
  });

  // 补丁放在最后（所有常量已初始化）
  ensureAltScreenPatches();
}
