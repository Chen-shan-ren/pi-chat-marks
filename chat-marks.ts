/**
 * chat-marks.ts — 对话标记点列（Chat Marks）
 *
 * 在终端右侧（滚动条左边）显示一列点，每个点代表你的一次发送（用户消息），
 * 最新的在最底部。支持鼠标交互：
 *
 *   - 鼠标悬停点：该点变大高亮，同时在编辑器上方显示该次发送的内容预览
 *   - 鼠标左键点击点：对话区直接滚动跳转到你发送的那条消息所在位置
 *   - 鼠标滚轮在点列上滚动：对话多时上下翻看点（不滚动 transcript）
 *   - Ctrl+Alt+M 或 /marks：打开"对话索引"选择器（键盘路径，两种模式通用）
 *
 * 模式兼容：
 *   - fullscreen 模式：鼠标交互全部可用（点击/滚轮/hover/视口联动/跳转）
 *   - regular 模式：鼠标悬停 + 点列滚轮 + 键盘索引可用；点击跳转仅当目标消息
 *     在当前屏幕可见时可用（scrollback 内容无法通过终端命令精确跳转）
 *
 * 历史（修复记录）：
 *   - v1 用 modal overlay 弹窗展示详情，会抢占键盘焦点（未传 nonCapturing），
 *     导致重启后输入框无法打字；弹窗打开期间打字也被模态拦截。
 *   - v2 给常驻点列 overlay 加 nonCapturing: true，修掉启动即抢焦点的问题。
 *   - v3 点击点改为编辑器上方非模态 widget 展示内容。
 *   - v4 按用户需求：点击点直接滚动对话区跳转到该消息，不做内容展示。
 *   - v5 双模式兼容：regular 模式下启用鼠标追踪 + inputListener。
 *   - v6 修复 regular 模式 4 个 bug：
 *     (a) 3 个多出来的点（termSize 未缓存，首帧尺寸与 overlay 位置不一致）
 *     (b) 滑动中键全黑（handleRegularMouse 消费了区域外所有事件，拦截终端滚动）
 *     (c) 鼠标移入点列区域才恢复（同 b，终端内容未被重绘）
 *     (d) 点击不跳转（DECScroll 只能滚当前屏幕，无法到达 scrollback）
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

// ---- TUI 类型定义（两种模式共用 + 各自特有） ----

interface TuiBaseLike {
  terminal?: {
    rows?: number;
    columns?: number;
    write?: (data: string) => void;
  };
  requestRender?: () => void;
  addInputListener?: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
  previousLines?: string[];
  previousViewportTop?: number;
}

interface TuiFullscreenLike extends TuiBaseLike {
  getPrimaryScrollView?: () => {
    scrollTop: number;
    viewportHeight: number;
    scrollTo?: (row: number) => void;
    scrollBy?: (lines: number) => void;
    isFollowingEnd?: boolean;
  };
  currentLayout?: unknown;
  scrollBy?: (lines: number) => void;
  scrollToBottom?: () => void;
  scrollToTop?: () => void;
  flash?: (message: string, durationMs?: number) => void;
}

type TuiInstance = TuiBaseLike & Partial<TuiFullscreenLike>;

// ---- 模式检测 ----

function isFullscreenTui(tui: TuiInstance): boolean {
  return !!(tui as TuiFullscreenLike).getPrimaryScrollView;
}

export default function (pi: ExtensionAPI) {
  let messages: UserMsg[] = [];
  let selectedIndex = -1;
  let hoverIndex = -1;
  let viewportIndex = -1;
  let scrollOffset = 0;
  let sessionCtx: ExtensionContext | undefined;
  let dotsTui: TuiInstance | undefined;
  let rowMapCache: { lines: string[]; map: Map<number, number> } | undefined;

  // 缓存终端尺寸：overlay 回调时 tui.terminal.rows 可能未就绪，
  // 需要缓存首次可用值，确保 renderDots / inDotsRegion / compositeOverlays 一致
  let cachedTermSize: { rows: number; columns: number } | undefined;

  // regular 模式鼠标追踪状态
  let regularMouseEnabled = false;
  let regularMouseCleanup: (() => void) | undefined;

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

  /** 终端当前尺寸：优先使用缓存值（overlay 回调时设置），回退 tui.terminal / process.stdout */
  function termSize(): { rows: number; columns: number } {
    if (cachedTermSize) return cachedTermSize;
    const t = dotsTui;
    if (t?.terminal?.rows && t?.terminal?.columns) {
      return { rows: t.terminal.rows, columns: t.terminal.columns };
    }
    return {
      rows: process.stdout?.rows ?? 30,
      columns: process.stdout?.columns ?? 80,
    };
  }

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

  function dotsTopRow(): number {
    return Math.max(0, Math.floor((termSize().rows - dotsCount()) / 2));
  }

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
        dot = theme.bold(theme.fg("accent", theme.bg("selectedBg", "⬤")));
      } else if (i === viewportIndex) {
        dot = theme.fg("warning", "◉");
      } else if (i === selectedIndex) {
        dot = theme.fg("accent", "◉");
      } else if (i === messages.length - 1) {
        dot = theme.fg("success", "●");
      } else {
        dot = theme.fg("muted", "•");
      }
      rows.push(width > 1 ? " " + dot : dot);
    }
    return rows;
  }

  // ---- 视口位置指示（双模式） ----

  function updateViewportIndicator(): void {
    const t = dotsTui;
    if (!t) return;

    const fs = t as TuiFullscreenLike;
    if (fs.getPrimaryScrollView && fs.currentLayout) {
      try {
        const sv = fs.getPrimaryScrollView();
        if (!sv || sv.viewportHeight <= 0) return;
        const box = findScrollViewBox(fs.currentLayout, sv);
        const lines = box?.scrollContentLines;
        if (!lines || lines.length === 0) return;
        const mid = Math.min(sv.scrollTop + Math.floor(sv.viewportHeight / 2), lines.length - 1);
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
          t.requestRender?.();
          syncWindowToViewport();
        }
      } catch { /* */ }
      return;
    }

    // regular 模式：使用 previousViewportTop + previousLines 近似
    try {
      const prevLines = t.previousLines ?? [];
      if (prevLines.length === 0) return;
      const viewportTop = t.previousViewportTop ?? 0;
      const terminalHeight = termSize().rows;
      const mid = Math.min(viewportTop + Math.floor(terminalHeight / 2), prevLines.length - 1);
      const map = getRowMap(prevLines);
      let markRow = -1;
      for (let row = mid; row >= 0; row--) {
        if (OSC133_PROMPT_START.test(prevLines[row] ?? "") && map.has(row)) {
          markRow = row;
          break;
        }
      }
      const next = markRow >= 0 ? (map.get(markRow) ?? -1) : -1;
      if (next !== viewportIndex) {
        viewportIndex = next;
        t.requestRender?.();
        syncWindowToViewport();
      }
    } catch { /* */ }
  }

  // ---- 跳转到指定用户消息（双模式） ----

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

  function matchesPromptRow(visible: string, targetText: string): boolean {
    if (!visible) return false;
    if (targetText.length <= visible.length) return visible === targetText;
    return visible.length >= 4 && targetText.startsWith(visible);
  }

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

  function syncWindowToViewport(): void {
    const count = dotsCount();
    if (count <= 0 || viewportIndex < 0) return;
    const maxOffset = Math.max(0, messages.length - count);
    if (viewportIndex >= scrollOffset && viewportIndex < scrollOffset + count) return;
    let target: number;
    if (viewportIndex >= messages.length - count) {
      target = maxOffset;
    } else {
      target = Math.max(0, Math.min(maxOffset, viewportIndex - Math.floor(count / 2)));
    }
    if (target !== scrollOffset) {
      scrollOffset = target;
      dotsTui?.requestRender?.();
    }
  }

  /** 在渲染行中定位第 index 条用户消息并滚动过去。返回是否成功。 */
  function jumpToMessage(index: number): boolean {
    const t = dotsTui;
    if (!t) return false;
    const target = messages[index];
    if (!target) return false;

    const fs = t as TuiFullscreenLike;
    // 全屏模式：通过 ScrollView.scrollTo 精确跳转
    if (fs.getPrimaryScrollView && fs.currentLayout) {
      try {
        const sv = fs.getPrimaryScrollView();
        if (!sv || !sv.scrollTo) return false;
        const box = findScrollViewBox(fs.currentLayout, sv);
        const lines = box?.scrollContentLines;
        if (!lines || lines.length === 0) return false;
        const map = getRowMap(lines);
        let matchRow = -1;
        for (const [row, msgIndex] of map) {
          if (msgIndex === index) { matchRow = row; break; }
        }
        if (matchRow < 0) return false;
        sv.scrollTo(matchRow);
        t.requestRender?.();
        t.flash?.(`已跳转到第 ${index + 1}/${messages.length} 次发送 · ${fmtTime(target.timestamp)}`, 1500);
        return true;
      } catch {
        return false;
      }
    }

    // regular 模式：DECScroll 操作的是可见屏幕缓冲区而非 scrollback，
    // 无法到达历史消息，且执行后黑屏。因此 regular 模式不做终端滚动，
    // 目标在屏幕上就提示，不在 scrollback 中就告知用户用 Ctrl+Alt+M 键盘索引。
    try {
      const prevLines = t.previousLines ?? [];
      if (prevLines.length === 0) return false;
      const map = getRowMap(prevLines);
      let matchRow = -1;
      for (const [row, msgIndex] of map) {
        if (msgIndex === index) { matchRow = row; break; }
      }
      if (matchRow < 0) return false;

      const viewportTop = t.previousViewportTop ?? 0;
      const terminalHeight = termSize().rows;
      const screenRow = matchRow - viewportTop;

      if (screenRow < 0 || screenRow >= terminalHeight) {
        sessionCtx?.ui.notify(
          `目标消息在滚动历史中，无法自动跳转（regular 模式限制）。请手动滚动，或使用 Ctrl+Alt+M 键盘索引`,
          "warning",
        );
        return true;
      }

      t.requestRender?.();
      sessionCtx?.ui.notify(
        `已在屏幕上 · 第 ${index + 1}/${messages.length} 次发送 · ${fmtTime(target.timestamp)}`,
        "info",
      );
      return true;
    } catch {
      return false;
    }
  }

  // ---- 鼠标钩子补丁（仅 fullscreen 需要） ----

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
      candidates.push(
        join(dirname(dirname(pkgEntry)), "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"),
      );
    } catch { /* */ }
    const execDir = dirname(process.execPath);
    candidates.push(join(execDir, "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
    candidates.push(join(process.cwd(), "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
      if (root) {
        candidates.push(join(root, "@earendil-works/pi-tui/dist/tui-alt-screen.js"));
        candidates.push(join(root, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
      }
    } catch { /* */ }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  }

  function findScrollViewPath(): string | undefined {
    const alt = findTuiAltScreenPath();
    if (!alt) return undefined;
    const p = join(dirname(alt), "components", "scroll-view.js");
    return existsSync(p) ? p : undefined;
  }

  const debug = process.env.CHAT_MARKS_DEBUG === "1";
  const log = debug ? (msg: string) => console.log(msg) : () => {};
  const warn = debug ? (msg: string) => console.warn(msg) : () => {};

  function applyIdempotentPatch(file: string, mark: string, anchor: string, insert: string, label: string): void {
    const src = readFileSync(file, "utf8");
    if (src.includes(mark)) return;
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

  let patchProblem: string | undefined;

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

  // ---- regular 模式鼠标追踪 ----

  /** 在 regular 模式下启用终端 SGR 鼠标追踪 + inputListener
   *  关键：只消费点列区域内的鼠标事件，区域外全部放行给终端，
   *  保证终端原生滚动（scrollback 导航）不被拦截。 */
  function enableRegularMouse(tui: TuiInstance): void {
    if (regularMouseEnabled) return;
    regularMouseEnabled = true;

    // 缓存终端尺寸（此时 tui.terminal 已就绪）
    if (tui.terminal?.rows && tui.terminal?.columns) {
      cachedTermSize = { rows: tui.terminal.rows, columns: tui.terminal.columns };
    }

    // 启用 SGR 鼠标追踪（button + drag + all-motion + SGR format）
    tui.terminal?.write?.("\x1b[?1000h\x1b[?1003h\x1b[?1004h\x1b[?1006h");
    // 注册 inputListener（在 focused component 之前接收输入）
    if (tui.addInputListener) {
      regularMouseCleanup = tui.addInputListener((data: string) => {
        if (typeof data !== "string") return undefined;
        if (!data.startsWith("\x1b[<")) return undefined;
        return handleRegularMouse(data);
      });
      log("[chat-marks] regular 模式：已启用鼠标追踪 + inputListener");
    }
  }

  /** 在 regular 模式下禁用终端鼠标追踪 */
  function disableRegularMouse(tui: TuiInstance): void {
    if (!regularMouseEnabled) return;
    regularMouseEnabled = false;
    regularMouseCleanup?.();
    regularMouseCleanup = undefined;
    cachedTermSize = undefined;
    tui.terminal?.write?.("\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1000l");
  }

  /** regular 模式鼠标事件处理
   *  只消费点列区域内的事件；区域外全部放行（返回 undefined），
   *  保证终端原生滚轮/拖拽/点击不受干扰。 */
  function handleRegularMouse(data: string): { consume?: boolean } | undefined {
    const mouse = parseSgrMouse(data);
    if (!mouse) return undefined;

    const btn = mouse.button & 3;
    const isMove = mouse.button >= 32 && mouse.button < 64;
    const isWheel = mouse.button >= 64;

    // ---- 点列区域外：不消费事件，全部放行给终端 ----
    if (!inDotsRegion(mouse.x, mouse.y)) {
      // 仅在离开点列区域时清除悬停状态（不消费事件，终端正常处理）
      if ((isMove || (btn === 0 && mouse.press)) && hoverIndex !== -1) {
        hoverIndex = -1;
        updateHoverPreview();
        dotsTui?.requestRender?.();
      }
      // 返回 undefined = 不消费，终端继续处理滚轮/拖拽/点击
      return undefined;
    }

    // ---- 点列区域内 ----
    const target = indexAtRow(mouse.y);

    if (isMove) {
      if (target !== hoverIndex) {
        hoverIndex = target;
        updateHoverPreview();
        dotsTui?.requestRender?.();
      }
      return { consume: true };
    }

    if (isWheel) {
      if (btn === 0) scrollOffset--;
      else scrollOffset++;
      clampOffset();
      dotsTui?.requestRender?.();
      return { consume: true };
    }

    if (btn === 0 && mouse.press) {
      if (target >= 0) {
        hoverIndex = -1;
        updateHoverPreview();
        const ok = jumpToMessage(target);
        if (!ok) {
          sessionCtx?.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        }
        dotsTui?.requestRender?.();
      }
      return { consume: true };
    }

    if (btn === 1 || btn === 2 || !mouse.press) {
      return { consume: true };
    }

    return { consume: true };
  }

  // ---- fullscreen 模式鼠标钩子（通过 tui-alt-screen.js 补丁注入） ----

  function inDotsRegion(x: number, y: number): boolean {
    const { columns, rows } = termSize();
    if (x < columns - 2 || x > columns - 1) return false;
    const count = dotsCount();
    if (count === 0) return false;
    const top = dotsTopRow();
    return y >= top + 1 && y <= top + count && y <= rows;
  }

  /** 让聊天区滚动条常驻可见可点（仅 fullscreen 模式） */
  let scrollbarPersisted = false;
  function ensureTranscriptScrollbarPersistent(): void {
    if (scrollbarPersisted) return;
    const fs = dotsTui as TuiFullscreenLike;
    const sv = fs?.getPrimaryScrollView?.();
    if (!sv) return;
    scrollbarPersisted = true;
    try {
      (sv as { scrollbarHideDelayMs?: number; transientScrollbarVisible?: boolean }).scrollbarHideDelayMs = 600_000;
      (sv as { scrollbarHideDelayMs?: number; transientScrollbarVisible?: boolean }).transientScrollbarVisible = true;
    } catch { /* */ }
  }

  function handleMouse(data: string, tui: unknown): { consume?: boolean } | undefined {
    dotsTui = tui as TuiInstance;
    ensureTranscriptScrollbarPersistent();
    const mouse = parseSgrMouse(data);
    if (!mouse) return undefined;

    const btn = mouse.button & 3;
    const isMove = mouse.button >= 32 && mouse.button < 64;
    const isWheel = mouse.button >= 64;

    if (!inDotsRegion(mouse.x, mouse.y)) {
      if ((isMove || (btn === 0 && mouse.press)) && hoverIndex !== -1) {
        hoverIndex = -1;
        updateHoverPreview();
        dotsTui?.requestRender?.();
      }
      return undefined;
    }

    const target = indexAtRow(mouse.y);

    if (isMove) {
      if (target !== hoverIndex) {
        hoverIndex = target;
        updateHoverPreview();
        dotsTui?.requestRender?.();
      }
      return { consume: true };
    }

    if (isWheel) {
      if (btn === 0) scrollOffset--;
      else scrollOffset++;
      clampOffset();
      dotsTui?.requestRender?.();
      return { consume: true };
    }

    if (btn === 0 && mouse.press) {
      if (target >= 0) {
        hoverIndex = -1;
        updateHoverPreview();
        const ok = jumpToMessage(target);
        if (!ok) {
          sessionCtx?.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        }
        dotsTui?.requestRender?.();
      }
      return { consume: true };
    }

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
        selectedIndex = Number(item.value);
        const ok = jumpToMessage(selectedIndex);
        if (!ok) {
          ctx.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        }
        done(undefined);
      };
      list.onCancel = () => done(undefined);
      list.onSelectionChange = (item) => {
        selectedIndex = Number(item.value);
        tui.requestRender?.();
      };
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender?.();
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
    dotsTui?.requestRender?.();
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
    viewportIndex = -1;
    sessionCtx = ctx;
    dotsTui = undefined;
    cachedTermSize = undefined;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

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
    } catch { /* */ }

    void ctx.ui.custom((tui, theme) => {
      dotsTui = tui as TuiInstance;

      const fullscreen = isFullscreenTui(tui as TuiInstance);
      if (fullscreen) {
        (globalThis as unknown as Record<string, unknown>)["__piMouseHook"] = (data: string, t: unknown) =>
          handleMouse(data, t as never);
        log("[chat-marks] fullscreen 模式：已注册 __piMouseHook");
      } else {
        enableRegularMouse(tui as TuiInstance);
      }

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

    setTimeout(() => {
      try {
        const fs = dotsTui as TuiFullscreenLike;
        if (fs?.scrollToBottom) {
          fs.scrollToBottom();
        }
      } catch { /* */ }
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
    rowMapCache = undefined;
    clampOffset();
    try {
      const fs = dotsTui as TuiFullscreenLike;
      if (fs?.scrollToBottom) {
        fs.scrollToBottom();
      }
    } catch { /* */ }
    dotsTui?.requestRender?.();
    setTimeout(() => updateViewportIndicator(), 100);
  });

  pi.on("session_shutdown", () => {
    (globalThis as unknown as Record<string, unknown>)["__piMouseHook"] = undefined;
    (globalThis as unknown as Record<string, unknown>)["__piScrollHook"] = undefined;
    if (dotsTui) {
      disableRegularMouse(dotsTui);
    }
    sessionCtx = undefined;
  });

  pi.registerShortcut("ctrl+alt+m", {
    description: "打开对话索引（跳转到指定消息）",
    handler: (ctx) => void openMarks(ctx),
  });

  pi.registerCommand("marks", {
    description: "打开对话索引：跳转到指定消息（Enter 跳转，Esc 关闭）",
    handler: (_args, ctx) => openMarks(ctx),
  });

  ensureAltScreenPatches();
}
