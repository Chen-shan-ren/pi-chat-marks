/**
 * chat-marks.ts — 对话标记点列（Chat Marks）
 *
 * 在终端右侧显示一列点，每个点代表你的一次发送。
 * 鼠标悬停看内容 · 点击跳转 · 滚动跟随 · 双向联动 · 键盘索引
 *
 * 模式路由：
 *   - fullscreen（--tui-mode fullscreen）：全部功能可用
 *   - regular（默认）：点阵 + 键盘索引（Ctrl+Alt+M），无鼠标交互
 *
 * 两种模式使用不同的 TUI 架构，overlay 定位和滚动控制方式根本不同：
 *   fullscreen → renderLayoutFrame + ScrollView → overlay 屏幕相对，始终可见
 *   regular    → render(width) 全部内容       → overlay 内容相对，随内容滚动
 * 因此 regular 模式无法实现 fullscreen 的鼠标交互效果。
 *
 * 历史：
 *   v1  modal overlay 弹窗（抢占键盘焦点）
 *   v2  nonCapturing overlay
 *   v3  编辑器上方 widget 展示
 *   v4  点击跳转
 *   v5  regular 模式尝试（受限于架构）
 *   v6  正确的路由架构：fullscreen 完整功能，regular 精简功能
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ===========================================================================
// 共用类型
// ===========================================================================

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

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

function stripAnsi(s: string): string {
  return s
    .replace(/^\x1b\]133;A(?:\x07|\x1b\\)/, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .trim();
}

// ---- TUI 类型 ----

interface TuiBaseLike {
  terminal?: { rows?: number; columns?: number; write?: (data: string) => void };
  requestRender?: () => void;
  addInputListener?: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
}

interface TuiFullscreenLike extends TuiBaseLike {
  getPrimaryScrollView(): {
    scrollTop: number;
    viewportHeight: number;
    scrollTo(row: number): void;
  };
  currentLayout: unknown;
  scrollBy(lines: number): void;
  scrollToBottom(): void;
  flash(message: string, durationMs?: number): void;
}

type TuiInstance = TuiBaseLike & Partial<TuiFullscreenLike>;

function isFullscreenTui(tui: TuiInstance): tui is TuiFullscreenLike {
  return !!(tui as TuiFullscreenLike).getPrimaryScrollView;
}

// ===========================================================================
// 共用工具
// ===========================================================================

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

function matchesPromptRow(visible: string, targetText: string): boolean {
  if (!visible) return false;
  if (targetText.length <= visible.length) return visible === targetText;
  return visible.length >= 4 && targetText.startsWith(visible);
}

function buildRowMap(lines: string[], messages: UserMsg[]): Map<number, number> {
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

// ===========================================================================
// 补丁系统（仅 fullscreen 模式需要）
// ===========================================================================

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
  "        // [chat-marks-patch] __piScrollbarGuardPatch\n" +
  "        if (this.getTopmostVisibleOverlay() || !this.currentLayout)\n" +
  "            return undefined;";
const PATCH3_MARK = "__piSelectionGuardPatch";
const PATCH3_ANCHOR =
  "        const scrollView = !this.hasOverlay() && this.currentLayout\n" +
  "            ? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]\n" +
  "            : undefined;";
const PATCH3_INSERT =
  "        // [chat-marks-patch] __piSelectionGuardPatch\n" +
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
  "        if (moved !== 0 || this.followingEnd !== wasFollowingEnd)\n            this.requestRenderCallback?.();\n        // [chat-marks-patch] __piScrollHookBy\n        globalThis.__piScrollHook?.(this);\n        return requested - moved;";

function findTuiAltScreenPath(): string | undefined {
  const candidates: string[] = [];
  try {
    const req = (globalThis as { require?: NodeRequire }).require ?? require;
    const pkgEntry = req.resolve("@earendil-works/pi-coding-agent");
    candidates.push(join(dirname(dirname(pkgEntry)), "node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js"));
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

function applyIdempotentPatch(file: string, mark: string, anchor: string, insert: string, label: string, warn: (msg: string) => void): boolean {
  const src = readFileSync(file, "utf8");
  if (src.includes(mark)) return true;
  if (!src.includes(anchor)) {
    warn(`[chat-marks] tui-alt-screen.js 版本不匹配，无法打补丁（${label}）`);
    return false;
  }
  writeFileSync(file, src.replace(anchor, insert), "utf8");
  return true;
}

function applyPatches(log: (msg: string) => void, warn: (msg: string) => void): string | undefined {
  let problem: string | undefined;
  const file = findTuiAltScreenPath();
  if (!file) {
    problem = "未找到 pi 的 TUI 组件文件，鼠标交互不可用；键盘路径 Ctrl+Alt+M 仍可用";
    warn("[chat-marks] " + problem);
  } else {
    applyIdempotentPatch(file, PATCH_MARK, PATCH_ANCHOR, PATCH_INSERT, "鼠标钩子", warn);
    applyIdempotentPatch(file, PATCH2_MARK, PATCH2_ANCHOR, PATCH2_INSERT, "滚动条守卫", warn);
    applyIdempotentPatch(file, PATCH3_MARK, PATCH3_ANCHOR, PATCH3_INSERT, "选择守卫", warn);
  }
  const scrollFile = findScrollViewPath();
  if (!scrollFile) {
    if (!problem) problem = "未找到 scroll-view.js，视口位置指示不可用；鼠标点击/悬停仍可用";
    warn("[chat-marks] 未找到 scroll-view.js");
  } else {
    applyIdempotentPatch(scrollFile, PATCH4_MARK, PATCH4_ANCHOR, PATCH4_INSERT, "滚动钩子 scrollTo", warn);
    applyIdempotentPatch(scrollFile, PATCH5_MARK, PATCH5_ANCHOR, PATCH5_INSERT, "滚动钩子 scrollBy", warn);
  }
  return problem;
}

// ===========================================================================
// Fullscreen Handler — 完整鼠标交互 + 视口联动
// ===========================================================================

function createFullscreenHandler(messages: UserMsg[], ctx: ExtensionContext) {
  let dotsTui: TuiFullscreenLike;
  let hoverIndex = -1;
  let viewportIndex = -1;
  let scrollOffset = 0;
  let selectedIndex = -1;
  let rowMap: Map<number, number> | undefined;
  let cachedSize: { rows: number; columns: number };

  const getRowMap = (lines: string[]) => {
    rowMap = buildRowMap(lines, messages);
    return rowMap;
  };

  function termSize() { return cachedSize; }

  function dotsMaxRows() { return Math.max(4, Math.min(18, termSize().rows - 8)); }
  function dotsCount() { return Math.min(messages.length, dotsMaxRows()); }

  function clampOffset() {
    const max = Math.max(0, messages.length - dotsCount());
    scrollOffset = Math.max(0, Math.min(scrollOffset, max));
  }

  function dotsTopRow() { return Math.max(0, Math.floor((termSize().rows - dotsCount()) / 2)); }

  function indexAtRow(y: number): number {
    const v = y - 1 - dotsTopRow();
    const i = scrollOffset + v;
    return i >= 0 && i < messages.length ? i : -1;
  }

  function inDotsRegion(x: number, y: number): boolean {
    const { columns, rows } = termSize();
    if (x < columns - 2 || x > columns - 1) return false;
    const count = dotsCount();
    if (count === 0) return false;
    const top = dotsTopRow();
    return y >= top + 1 && y <= top + count && y <= rows;
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
    return visit((frame as { root?: unknown })?.root as { scrollView?: unknown; children?: unknown[] });
  }

  function updateViewportIndicator() {
    try {
      const sv = dotsTui.getPrimaryScrollView();
      if (sv.viewportHeight <= 0) return;
      const box = findScrollViewBox(dotsTui.currentLayout, sv);
      const lines = box?.scrollContentLines;
      if (!lines?.length) return;
      const mid = Math.min(sv.scrollTop + Math.floor(sv.viewportHeight / 2), lines.length - 1);
      const map = getRowMap(lines);
      let markRow = -1;
      for (let row = mid; row >= 0; row--) {
        if (OSC133_PROMPT_START.test(lines[row] ?? "") && map.has(row)) {
          markRow = row; break;
        }
      }
      const next = markRow >= 0 ? (map.get(markRow) ?? -1) : -1;
      if (next !== viewportIndex) {
        viewportIndex = next;
        dotsTui.requestRender();
        syncWindowToViewport();
      }
    } catch { /* */ }
  }

  function syncWindowToViewport() {
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
    if (target !== scrollOffset) { scrollOffset = target; dotsTui.requestRender(); }
  }

  function jumpToMessage(index: number): boolean {
    const target = messages[index];
    if (!target) return false;
    try {
      const sv = dotsTui.getPrimaryScrollView();
      const box = findScrollViewBox(dotsTui.currentLayout, sv);
      const lines = box?.scrollContentLines;
      if (!lines?.length) return false;
      const map = getRowMap(lines);
      let matchRow = -1;
      for (const [row, msgIdx] of map) {
        if (msgIdx === index) { matchRow = row; break; }
      }
      if (matchRow < 0) return false;
      sv.scrollTo(matchRow);
      dotsTui.requestRender();
      dotsTui.flash(`已跳转到第 ${index + 1}/${messages.length} 次发送 · ${fmtTime(target.timestamp)}`, 1500);
      return true;
    } catch { return false; }
  }

  function updateHoverPreview() {
    if (hoverIndex >= 0 && hoverIndex < messages.length) {
      const m = messages[hoverIndex];
      ctx.ui.setWidget("chat-marks-preview", [
        `⏱ ${fmtTime(m.timestamp)} · 第 ${hoverIndex + 1} 次发送`,
        preview(m.text, 60),
      ]);
    } else {
      ctx.ui.setWidget("chat-marks-preview", undefined);
    }
  }

  let scrollbarPersisted = false;
  function ensureScrollbar() {
    if (scrollbarPersisted) return;
    const sv = dotsTui.getPrimaryScrollView();
    scrollbarPersisted = true;
    try {
      (sv as { scrollbarHideDelayMs?: number; transientScrollbarVisible?: boolean }).scrollbarHideDelayMs = 600_000;
      (sv as { scrollbarHideDelayMs?: number; transientScrollbarVisible?: boolean }).transientScrollbarVisible = true;
    } catch { /* */ }
  }

  function handleMouse(data: string, tui: unknown): { consume?: boolean } | undefined {
    dotsTui = tui as TuiFullscreenLike;
    ensureScrollbar();
    const mouse = parseSgrMouse(data);
    if (!mouse) return undefined;

    const btn = mouse.button & 3;
    const isMove = mouse.button >= 32 && mouse.button < 64;
    const isWheel = mouse.button >= 64;

    if (!inDotsRegion(mouse.x, mouse.y)) {
      if ((isMove || (btn === 0 && mouse.press)) && hoverIndex !== -1) {
        hoverIndex = -1; updateHoverPreview(); dotsTui.requestRender();
      }
      return undefined;
    }

    const target = indexAtRow(mouse.y);

    if (isMove) {
      if (target !== hoverIndex) { hoverIndex = target; updateHoverPreview(); dotsTui.requestRender(); }
      return { consume: true };
    }
    if (isWheel) {
      if (btn === 0) scrollOffset--; else scrollOffset++;
      clampOffset(); dotsTui.requestRender();
      return { consume: true };
    }
    if (btn === 0 && mouse.press) {
      if (target >= 0) {
        hoverIndex = -1; updateHoverPreview();
        jumpToMessage(target);
        dotsTui.requestRender();
      }
      return { consume: true };
    }
    if (btn === 1 || btn === 2 || !mouse.press) return { consume: true };
    return undefined;
  }

  // ---- 初始化 ----
  return {
    init(tui: TuiFullscreenLike, theme: { fg: (c: string, s: string) => string; bold: (s: string) => string; bg: (c: string, s: string) => string }) {
      dotsTui = tui;
      cachedSize = { rows: tui.terminal!.rows!, columns: tui.terminal!.columns! };

      // 注册鼠标钩子到 globalThis（tui-alt-screen.js 补丁调用）
      (globalThis as Record<string, unknown>)["__piMouseHook"] = (data: string, t: unknown) =>
        handleMouse(data, t as TuiFullscreenLike);
      // 滚动钩子
      (globalThis as Record<string, unknown>)["__piScrollHook"] = () => updateViewportIndicator();

      return {
        render: (w: number) => renderDots(w, theme),
        invalidate: () => {},
        handleInput: () => {},
      };
    },

    cleanup() {
      (globalThis as Record<string, unknown>)["__piMouseHook"] = undefined;
      (globalThis as Record<string, unknown>)["__piScrollHook"] = undefined;
    },

    scrollToBottom() {
      try { dotsTui?.scrollToBottom?.(); } catch { /* */ }
    },

    jumpToMessage,
    updateViewportIndicator,
  };
}

// ===========================================================================
// Regular Handler — 点阵 + 键盘索引（无鼠标交互）
// ===========================================================================

function createRegularHandler(messages: UserMsg[], ctx: ExtensionContext) {
  let dotsTui: TuiBaseLike;

  function termSize() {
    return {
      rows: dotsTui?.terminal?.rows ?? process.stdout?.rows ?? 30,
      columns: dotsTui?.terminal?.columns ?? process.stdout?.columns ?? 80,
    };
  }

  function dotsMaxRows() { return Math.max(4, Math.min(18, termSize().rows - 8)); }
  function dotsCount() { return Math.min(messages.length, dotsMaxRows()); }

  function renderDots(width: number, theme: {
    fg(color: string, s: string): string;
    bold(s: string): string;
  }): string[] {
    const count = dotsCount();
    const rows: string[] = [];
    for (let i = Math.max(0, messages.length - count); i < messages.length; i++) {
      const isLast = i === messages.length - 1;
      const dot = isLast ? theme.fg("success", "●") : theme.fg("muted", "•");
      rows.push(width > 1 ? " " + dot : dot);
    }
    return rows;
  }

  return {
    init(tui: TuiBaseLike, theme: { fg: (c: string, s: string) => string; bold: (s: string) => string; bg: (c: string, s: string) => string }) {
      dotsTui = tui;
      return {
        render: (w: number) => renderDots(w, theme),
        invalidate: () => {},
        handleInput: () => {},
      };
    },

    cleanup() { /* 无鼠标追踪，无需清理 */ },

    scrollToBottom() { /* regular 模式无此能力 */ },

    updateViewportIndicator() { /* regular 模式无法检测终端滚动 */ },
  };
}

// ===========================================================================
// 入口：模式检测 + 路由
// ===========================================================================

export default function (pi: ExtensionAPI) {
  let messages: UserMsg[] = [];
  let handler: ReturnType<typeof createFullscreenHandler> | ReturnType<typeof createRegularHandler>;
  let sessionCtx: ExtensionContext | undefined;
  let patchProblem: string | undefined;

  const debug = process.env.CHAT_MARKS_DEBUG === "1";
  const log = debug ? (msg: string) => console.log(msg) : () => {};
  const warn = debug ? (msg: string) => console.warn(msg) : () => {};

  // 补丁放在顶层（进程启动时加载）
  patchProblem = applyPatches(log, warn);

  // ---- 键盘索引（两种模式共用） ----

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
        const idx = Number(item.value);
        // 尝试跳转（fullscreen 模式有效，regular 模式静默忽略）
        const fsHandler = handler as ReturnType<typeof createFullscreenHandler> | undefined;
        if (fsHandler && typeof fsHandler.jumpToMessage === "function") fsHandler.jumpToMessage(idx);
        }
        done(undefined);
      };
      list.onCancel = () => done(undefined);
      list.onSelectionChange = () => {
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
  }

  // ---- 事件 ----

  pi.on("session_start", async (_event, ctx) => {
    if (patchProblem && ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify("[chat-marks] ⚠️ " + patchProblem, "warning");
    }

    messages = [];
    sessionCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    // 读取历史消息
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message?.role === "user") {
          const text = extractText(entry.message.content);
          if (text) messages.push({ id: entry.id, timestamp: entry.message.timestamp ?? Date.now(), text });
        }
      }
    } catch { /* */ }

    // 路由：检测模式，创建对应 handler
    void ctx.ui.custom((tui, theme) => {
      if (isFullscreenTui(tui as TuiInstance)) {
        // ---- fullscreen 模式：完整功能 ----
        handler = createFullscreenHandler(messages, ctx);
        const overlay = handler.init(tui as TuiFullscreenLike, theme);
        log("[chat-marks] fullscreen 模式：完整功能已启用");
        return overlay;
      } else {
        // ---- regular 模式：点阵 + 键盘 ----
        handler = createRegularHandler(messages, ctx);
        const overlay = handler.init(tui as TuiInstance, theme);
        log("[chat-marks] regular 模式：点阵 + 键盘索引已启用");
        return overlay;
      }
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

    // 全屏模式：等布局完成后滚到底部 + 同步视口
    setTimeout(() => {
      handler?.scrollToBottom?.();
      handler?.updateViewportIndicator?.();
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
    handler?.scrollToBottom?.();
    handler?.updateViewportIndicator?.();
  });

  pi.on("session_shutdown", () => {
    handler?.cleanup?.();
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
}
