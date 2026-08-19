/**
 * chat-marks.ts — 对话标记点列（Chat Marks）
 *
 * 在终端右侧显示一列点，每个点代表你的一次发送。
 * 鼠标悬停看内容 · 点击跳转 · 滚动跟随 · 双向联动 · 键盘索引
 *
 * 模式路由：
 *   - fullscreen（--tui-mode fullscreen）：全部功能可用
 *   - regular（默认）：全部功能可用
 *
 * 两种模式的实现差异：
 *   fullscreen → renderLayoutFrame + ScrollView（pi 自己控制视图滚动）
 *   regular    → 渲染进终端主屏，视图由终端控制
 *
 * regular 模式的技术方案（v7）：
 *   - 终端鼠标追踪（SGR 1000/1003/1006）+ inputListener 接收鼠标
 *   - 滚动/跳转 = 给 tui-main-screen.js 打补丁，支持"强制视口切片渲染"：
 *     清屏后只重绘 [top, top+height) 切片，previousViewportTop 记账保持一致，
 *     避免 v5 直接写 DECSCROLL 导致的失同步黑屏
 *   - 持久视口合成：滚动时点列仍固定在屏幕右侧（与 fullscreen 一致）
 *   - renderNow 钩子：每次渲染后同步视口位置指示 + 修正光标记账
 *
 * 历史：
 *   v1  modal overlay 弹窗（抢占键盘焦点）
 *   v2  nonCapturing overlay
 *   v3  编辑器上方 widget 展示
 *   v4  点击跳转
 *   v5  regular 模式尝试（DECSCROLL 方案：终端不交互 scrollback → 黑屏，弃用）
 *   v6  路由架构：fullscreen 完整功能，regular 精简功能
 *   v7  强制视口切片渲染：regular 模式功能与 fullscreen 对齐
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

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
  requestRender?: (force?: boolean) => void;
  addInputListener?: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => () => void;
  previousLines?: string[];
  previousViewportTop?: number;
  hardwareCursorRow?: number;
  mode?: string;
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

/** 去掉行尾 2 列：点列 overlay（含 TRANSPARENT_MARK + " ●"）会合成到内容行尾部，
 * 文本匹配前必须剥掉，否则标记行被点列字符污染导致匹配失败（跳转定位不到消息）。 */
function stripDotsRegion(s: string): string {
  return s.slice(0, Math.max(0, s.length - 2));
}

function buildRowMap(lines: string[], messages: UserMsg[]): Map<number, number> {
  const map = new Map<number, number>();
  let cursor = 0;
  for (let row = 0; row < lines.length; row++) {
    if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
    let visible = stripDotsRegion(stripAnsi(lines[row] ?? "")).trim();
    if (!visible) {
      for (let r2 = row + 1; r2 < lines.length; r2++) {
        if (OSC133_PROMPT_START.test(lines[r2] ?? "")) break;
        visible = stripDotsRegion(stripAnsi(lines[r2] ?? "")).trim();
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
// 补丁系统
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

// PATCH6A/6B 打在 tui.js（TuiBase，两种模式共用）：渲染完成钩子。
// 注意：regular 模式的渲染直接调 doRender()（requestImmediateRender / scheduleRender），
// 不经过 renderNow()，所以钩子必须打在两个 doRender 调用点。
const PATCH6A_MARK = "__piDoRenderHookA";
const PATCH6A_ANCHOR =
  "            this.renderRequested = false;\n" +
  "            this.lastRenderAt = performance.now();\n" +
  "            this.doRender();\n" +
  "        });\n" +
  "    }\n" +
  "    cancelRenderTimer() {";
const PATCH6A_INSERT =
  "            this.renderRequested = false;\n" +
  "            this.lastRenderAt = performance.now();\n" +
  "            this.doRender();\n" +
  "            // [chat-marks-patch] __piDoRenderHookA\n" +
  "            globalThis.__piScrollHook?.(this);\n" +
  "        });\n" +
  "    }\n" +
  "    cancelRenderTimer() {";
const PATCH6B_MARK = "__piDoRenderHookB";
const PATCH6B_ANCHOR =
  "            this.doRender();\n" +
  "            if (this.renderRequested) {\n" +
  "                this.scheduleRender();\n" +
  "            }";
const PATCH6B_INSERT =
  "            this.doRender();\n" +
  "            // [chat-marks-patch] __piDoRenderHookB\n" +
  "            globalThis.__piScrollHook?.(this);\n" +
  "            if (this.renderRequested) {\n" +
  "                this.scheduleRender();\n" +
  "            }";
const PATCH7_MARK = "__piViewportComposite";
const PATCH7_ANCHOR = "        const viewportStart = Math.max(0, workingHeight - termHeight);";
const PATCH7_INSERT =
  "        // [chat-marks-patch] __piViewportComposite\n" +
  "        const viewportStart = globalThis.__piViewportTop !== undefined\n" +
  "            ? globalThis.__piViewportTop\n" +
  "            : Math.max(0, workingHeight - termHeight);";

// 点列行透明合成标记(APC 序列,终端忽略;PATCH10 在合成时消费)。
// 带标记的 overlay 行合成时不重置 SGR → 继承内容行背景,点列融入内容(无黑边)。
const TRANSPARENT_MARK = "\x1b_cm\x07";

// PATCH10 打在 tui.js compositeTuiLine:支持透明合成(仅点列行带标记,其它 overlay 不受影响)
const PATCH10_MARK = "__piTransparentOverlay";
const PATCH10_ANCHOR =
  "    const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);\n" +
  "    const beforePad = Math.max(0, startCol - base.beforeWidth);\n" +
  "    const overlayPad = Math.max(0, overlayWidth - overlay.width);\n" +
  "    const actualBeforeWidth = Math.max(startCol, base.beforeWidth);\n" +
  "    const actualOverlayWidth = Math.max(overlayWidth, overlay.width);\n" +
  "    const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);\n" +
  "    const afterPad = Math.max(0, afterTarget - base.afterWidth);\n" +
  "    const result = base.before +\n" +
  "        \" \".repeat(beforePad) +\n" +
  "        SEGMENT_RESET +\n" +
  "        overlay.text +\n" +
  "        \" \".repeat(overlayPad) +\n" +
  "        SEGMENT_RESET +\n" +
  "        base.after +\n" +
  "        \" \".repeat(afterPad);";
const PATCH10_INSERT =
  "    const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);\n" +
  "    // [chat-marks-patch] __piTransparentOverlay: 行首 APC \\x1b_cm\\x07 = 透明合成(继承内容背景,不重置 SGR)\n" +
  "    const __piTransparentOverlay = overlay.text.startsWith(\"\\x1b_cm\\x07\");\n" +
  "    if (__piTransparentOverlay)\n" +
  "        overlay.text = overlay.text.slice(5);\n" +
  "    const beforePad = Math.max(0, startCol - base.beforeWidth);\n" +
  "    const overlayPad = Math.max(0, overlayWidth - overlay.width);\n" +
  "    const actualBeforeWidth = Math.max(startCol, base.beforeWidth);\n" +
  "    const actualOverlayWidth = Math.max(overlayWidth, overlay.width);\n" +
  "    const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);\n" +
  "    const afterPad = Math.max(0, afterTarget - base.afterWidth);\n" +
  "    const result = base.before +\n" +
  "        \" \".repeat(beforePad) +\n" +
  "        (__piTransparentOverlay ? \"\" : SEGMENT_RESET) +\n" +
  "        overlay.text +\n" +
  "        \" \".repeat(overlayPad) +\n" +
  "        (__piTransparentOverlay ? \"\" : SEGMENT_RESET) +\n" +
  "        base.after +\n" +
  "        \" \".repeat(afterPad);";

// PATCH8/9 打在 tui-main-screen.js（regular 模式渲染器）
const PATCH8_MARK = "__piCompositeSkip";
const PATCH8_ANCHOR =
  "        if (this.hasOverlayEntries) {\n" +
  "            newLines = this.compositeOverlays(newLines, width, height);\n" +
  "        }";
const PATCH8_INSERT =
  "        if (this.hasOverlayEntries && globalThis.__piForcedViewportTop === undefined) { // [chat-marks-patch] __piCompositeSkip\n" +
  "            newLines = this.compositeOverlays(newLines, width, height);\n" +
  "        }";
const PATCH9_MARK = "__piForcedSlice";
const PATCH9_ANCHOR =
  "            let buffer = \"\\x1b[?2026h\"; // Begin synchronized output\n" +
  "            if (clear) {\n" +
  "                buffer += this.deleteKittyImages(this.previousKittyImageIds);\n" +
  "                buffer += \"\\x1b[2J\\x1b[H\\x1b[3J\"; // Clear screen, home, then clear scrollback\n" +
  "            }\n" +
  "            for (let i = 0; i < newLines.length; i++) {";
const PATCH9_INSERT =
  "            let buffer = \"\\x1b[?2026h\"; // Begin synchronized output\n" +
  "            if (clear) {\n" +
  "                buffer += this.deleteKittyImages(this.previousKittyImageIds);\n" +
  "                buffer += \"\\x1b[2J\\x1b[H\\x1b[3J\"; // Clear screen, home, then clear scrollback\n" +
  "            }\n" +
  "            // [chat-marks-patch] __piForcedSlice: forced viewport slice render (chat-marks regular mode)\n" +
  "            const __piForcedTop = globalThis.__piForcedViewportTop ?? globalThis.__piViewportTop;\n" +
  "            if (__piForcedTop !== undefined) {\n" +
  "                globalThis.__piForcedViewportTop = undefined;\n" +
  "                if (!newLines.some((l) => typeof l === \"string\" && isImageLine(l))) {\n" +
  "                    const __piTop = Math.max(0, Math.min(__piForcedTop, Math.max(0, newLines.length - height)));\n" +
  "                    const __piEnd = Math.min(newLines.length, __piTop + height);\n" +
  "                    let __piSlice = newLines.slice(__piTop, __piEnd);\n" +
  "                    const __piSaved = globalThis.__piViewportTop;\n" +
  "                    globalThis.__piViewportTop = undefined;\n" +
  "                    if (this.hasOverlayEntries) {\n" +
  "                        __piSlice = this.compositeOverlays(__piSlice, width, height);\n" +
  "                    }\n" +
  "                    globalThis.__piViewportTop = __piSaved;\n" +
  "                    let __piBuf = \"\\x1b[?2026h\";\n" +
  "                    __piBuf += this.deleteKittyImages(this.previousKittyImageIds);\n" +
  "                    __piBuf += \"\\x1b[2J\\x1b[H\\x1b[3J\";\n" +
  "                    for (let i = 0; i < __piSlice.length; i++) {\n" +
  "                        if (i > 0)\n" +
  "                            __piBuf += \"\\r\\n\";\n" +
  "                        __piBuf += __piSlice[i] ?? \"\";\n" +
  "                    }\n" +
  "                    __piBuf += \"\\x1b[?2026l\";\n" +
  "                    this.terminal.write(__piBuf);\n" +
  "                    this.cursorRow = Math.max(0, __piEnd - 1);\n" +
  "                    this.hardwareCursorRow = this.cursorRow;\n" +
  "                    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);\n" +
  "                    this.previousViewportTop = __piTop;\n" +
  "                    this.previousLines = newLines;\n" +
  "                    this.previousKittyImageIds = this.collectKittyImageIds(newLines);\n" +
  "                    this.previousWidth = width;\n" +
  "                    this.previousHeight = height;\n" +
  "                    if (cursorPos && cursorPos.row >= __piTop && cursorPos.row < __piEnd) {\n" +
  "                        this.positionHardwareCursor(cursorPos, newLines.length);\n" +
  "                    } else {\n" +
  "                        this.terminal.hideCursor();\n" +
  "                    }\n" +
  "                    return;\n" +
  "                }\n" +
  "            }\n" +
  "            for (let i = 0; i < newLines.length; i++) {";

// ===========================================================================
// interactive-mode.js 补丁(/settings 切换 TUI mode 支持;pi 更新后由 applyPatches 自动重打)
// ===========================================================================
// 背景:pi 的 switchTuiMode 检查 hasOverlayEntries,chat-marks 的常驻 overlay 会阻止切换;
// 设置选择器渲染在 editorContainer(不在 overlayStack),切换 TUI 前需先恢复编辑器;
// 切换完成后通知扩展重建常驻 overlay。锚点基于 pi 0.84.2,版本升级不匹配时仅告警。

const PATCH11_MARK = "__piTuiModeSwitch";
const PATCH11_ANCHOR =
  "    switchTuiMode(mode, restoreProgress = true, startRenderer = true) {\n" +
  "        const previousUi = this.renderer;\n" +
  "        if (mode === previousUi.mode)\n" +
  "            return true;\n" +
  "        if (previousUi.hasOverlayEntries)\n" +
  "            return false;\n" +
  "        const components = [...previousUi.children];";
const PATCH11_INSERT =
  "    switchTuiMode(mode, restoreProgress = true, startRenderer = true) {\n" +
  "        const previousUi = this.renderer;\n" +
  "        if (mode === previousUi.mode)\n" +
  "            return true;\n" +
  "        // [chat-marks-patch] __piTuiModeSwitch: 常驻 overlay(chat-marks 点列/预览/flash,带\n" +
  "        // __cmPersistent 标记)不应阻止 TUI mode 切换;捕获型 overlay(设置选择器等)自动关闭后再切换\n" +
  "        {\n" +
  "            const __cmStack = previousUi.overlayStack ?? [];\n" +
  "            while (__cmStack.length > 0 && __cmStack.some((e) => !e.options?.__cmPersistent)) {\n" +
  "                const __top = __cmStack[__cmStack.length - 1];\n" +
  "                if (__top.options?.__cmPersistent)\n" +
  "                    break;\n" +
  "                previousUi.hideOverlay();\n" +
  "                if (__cmStack.length === previousUi.overlayStack.length)\n" +
  "                    break; // hideOverlay 未生效,防死循环\n" +
  "            }\n" +
  "            if (__cmStack.some((e) => !e.options?.__cmPersistent))\n" +
  "                return false;\n" +
  "        }\n" +
  "        // [chat-marks-patch] 选择器(/settings 等)渲染在 editorContainer 而非 overlayStack:\n" +
  "        // 切换 TUI 前必须先恢复编辑器,否则选择器组件随 children 复制到新 TUI 导致崩溃/残留;\n" +
  "        // 同时把焦点还给编辑器——否则下方 getFocusedComponent() 返回已被移除的选择器,\n" +
  "        // 新 TUI setFocus(无效组件)后键盘输入无接收者(输入框打不了字)\n" +
  "        if (globalThis.__piSelectorActive) {\n" +
  "            globalThis.__piSelectorActive = false;\n" +
  "            try {\n" +
  "                this.editorContainer?.clear?.();\n" +
  "                this.editorContainer?.addChild?.(this.editor);\n" +
  "                previousUi.setFocus?.(this.editor);\n" +
  "            }\n" +
  "            catch { /* 恢复编辑器失败不阻塞切换 */ }\n" +
  "        }\n" +
  "        const components = [...previousUi.children];";

// 注意:mark 用中文注释文本做幂等检测(手动补丁与自动补丁共用同一注释)
const PATCH12A_MARK = "选择器已关闭";
const PATCH12A_ANCHOR =
  "            this.editorContainer.clear();\n" +
  "            this.editorContainer.addChild(this.editor);\n" +
  "            this.ui.setFocus(this.editor);\n" +
  "        };";
const PATCH12A_INSERT =
  "            this.editorContainer.clear();\n" +
  "            this.editorContainer.addChild(this.editor);\n" +
  "            this.ui.setFocus(this.editor);\n" +
  "            // [chat-marks-patch] 选择器已关闭\n" +
  "            globalThis.__piSelectorActive = false;\n" +
  "        };";
const PATCH12B_MARK = "选择器已打开";
const PATCH12B_ANCHOR =
  "        this.editorContainer.clear();\n" +
  "        this.editorContainer.addChild(created.component);\n" +
  "        this.ui.setFocus(created.focus);\n" +
  "        this.ui.requestRender();\n" +
  "    }";
const PATCH12B_INSERT =
  "        this.editorContainer.clear();\n" +
  "        this.editorContainer.addChild(created.component);\n" +
  "        this.ui.setFocus(created.focus);\n" +
  "        this.ui.requestRender();\n" +
  "        // [chat-marks-patch] 选择器已打开\n" +
  "        globalThis.__piSelectorActive = true;\n" +
  "    }";

const PATCH13_MARK = "__piAfterTuiSwitch";
const PATCH13_ANCHOR =
  "        nextUi.start();\n" +
  "        this.themeController.rebindTui();\n" +
  "        this.rebindExtensionTerminalInputListeners();\n" +
  "        if (restoreProgress &&";
const PATCH13_INSERT =
  "        nextUi.start();\n" +
  "        this.themeController.rebindTui();\n" +
  "        this.rebindExtensionTerminalInputListeners();\n" +
  "        // [chat-marks-patch] TUI 切换完成:通知扩展重建常驻 overlay(点列/预览/flash)\n" +
  "        globalThis.__piAfterTuiSwitch?.(nextUi);\n" +
  "        if (restoreProgress &&";

function findInteractiveModePath(): string | undefined {
  const candidates: string[] = [];
  try {
    const req = (globalThis as { require?: NodeRequire }).require ?? require;
    const pkgEntry = req.resolve("@earendil-works/pi-coding-agent");
    candidates.push(join(dirname(dirname(pkgEntry)), "dist/modes/interactive/interactive-mode.js"));
  } catch { /* */ }
  const execDir = dirname(process.execPath);
  candidates.push(join(execDir, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"));
  candidates.push(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"));
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = execSync("npm root -g", { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
    if (root) {
      candidates.push(join(root, "@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"));
    }
  } catch { /* */ }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

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

function findTuiJsPath(): string | undefined {
  const alt = findTuiAltScreenPath();
  if (!alt) return undefined;
  const p = join(dirname(alt), "tui.js");
  return existsSync(p) ? p : undefined;
}

function findTuiMainScreenPath(): string | undefined {
  const alt = findTuiAltScreenPath();
  if (!alt) return undefined;
  const p = join(dirname(alt), "tui-main-screen.js");
  return existsSync(p) ? p : undefined;
}

function applyIdempotentPatch(file: string, mark: string, anchor: string, insert: string, label: string, warn: (msg: string) => void): boolean {
  const src = readFileSync(file, "utf8");
  if (src.includes(mark)) return true;
  if (!src.includes(anchor)) {
    warn(`[chat-marks] pi 版本不匹配，无法打补丁（${label}）`);
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
  const tuiJs = findTuiJsPath();
  if (!tuiJs) {
    if (!problem) problem = "未找到 tui.js，regular 模式视口联动不可用";
    warn("[chat-marks] 未找到 tui.js");
  } else {
    applyIdempotentPatch(tuiJs, PATCH6A_MARK, PATCH6A_ANCHOR, PATCH6A_INSERT, "渲染钩子 immediate", warn);
    applyIdempotentPatch(tuiJs, PATCH6B_MARK, PATCH6B_ANCHOR, PATCH6B_INSERT, "渲染钩子 throttled", warn);
    applyIdempotentPatch(tuiJs, PATCH7_MARK, PATCH7_ANCHOR, PATCH7_INSERT, "视口合成", warn);
    applyIdempotentPatch(tuiJs, PATCH10_MARK, PATCH10_ANCHOR, PATCH10_INSERT, "透明合成", warn);
  }
  const mainScreen = findTuiMainScreenPath();
  if (!mainScreen) {
    if (!problem) problem = "未找到 tui-main-screen.js，regular 模式滚动/跳转不可用";
    warn("[chat-marks] 未找到 tui-main-screen.js");
  } else {
    applyIdempotentPatch(mainScreen, PATCH8_MARK, PATCH8_ANCHOR, PATCH8_INSERT, "合成跳过", warn);
    applyIdempotentPatch(mainScreen, PATCH9_MARK, PATCH9_ANCHOR, PATCH9_INSERT, "强制切片", warn);
  }
  // interactive-mode.js(/settings 切换 TUI mode;pi 更新后自动重打)
  const interactiveMode = findInteractiveModePath();
  if (!interactiveMode) {
    if (!problem) problem = "未找到 interactive-mode.js，/settings 切换 TUI mode 不可用";
    warn("[chat-marks] 未找到 interactive-mode.js");
  } else {
    applyIdempotentPatch(interactiveMode, PATCH11_MARK, PATCH11_ANCHOR, PATCH11_INSERT, "TUI 切换放行", warn);
    applyIdempotentPatch(interactiveMode, PATCH12A_MARK, PATCH12A_ANCHOR, PATCH12A_INSERT, "选择器状态标记(关闭)", warn);
    applyIdempotentPatch(interactiveMode, PATCH12B_MARK, PATCH12B_ANCHOR, PATCH12B_INSERT, "选择器状态标记(打开)", warn);
    applyIdempotentPatch(interactiveMode, PATCH13_MARK, PATCH13_ANCHOR, PATCH13_INSERT, "TUI 切换完成通知", warn);
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
      // TRANSPARENT_MARK：合成时不重置 SGR，点列继承内容行背景（无黑边）
      rows.push(TRANSPARENT_MARK + (width > 1 ? " " + dot : dot));
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

  function updateViewportIndicator(_t?: unknown) {
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

      // 确保终端鼠标追踪开启：TUI 切换时 regular 的 cleanup(disableMouse 写 1003l)在
      // __piAfterTuiSwitch 里执行,晚于新 TUI start(1003h)——追踪被关掉后滚轮事件不再
      // 发给 pi(变成终端原生 scrollback 滚动,表现为"滚轮变历史发送"),这里补开。
      try {
        tui.terminal?.write?.("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
      } catch { /* */ }

      return {
        render: (w: number) => renderDots(w, theme),
        invalidate: () => {},
        handleInput: () => {},
      };
    },

    cleanup() {
      (globalThis as Record<string, unknown>)["__piMouseHook"] = undefined;
    },

    scrollToBottom() {
      try { dotsTui?.scrollToBottom?.(); } catch { /* */ }
    },

    jumpToMessage,
    updateViewportIndicator,
  };
}

// ===========================================================================
// Regular Handler — 完整鼠标交互 + 视口联动（强制视口切片渲染）
// ===========================================================================

function createRegularHandler(messages: UserMsg[], ctx: ExtensionContext) {
  let dotsTui: TuiBaseLike & { previousLines?: string[]; previousViewportTop?: number; hardwareCursorRow?: number };
  let cachedSize: { rows: number; columns: number } | undefined;
  let hoverIndex = -1;
  let viewportIndex = -1;
  let scrollOffset = 0;
  let mouseEnabled = false;
  let mouseCleanup: (() => void) | undefined;
  let rowMapCache: { lines: string[]; map: Map<number, number> } | undefined;
  // 跳转钉住的指示索引：jumpToMessage 设置，渲染完成后由 updateViewportIndicator 消费一次。
  // 视口顶行被 clamp（消息太靠底无法居中）时，中线扫描会指到上一条消息，钉住保证 ◉ 指目标。
  let pinnedViewportIndex = -1;
  // 悬停预览（overlay 内容：屏幕底部显示，与 fullscreen 的 widget 同位置；底部/非底部统一）
  let previewLines: string[] | undefined;
  let previewOverlayCreated = false;
  // 跳转 flash（屏幕右上角，与 fullscreen 一致）
  let flashLines: string[] | undefined;
  let flashOverlayCreated = false;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  // 内容区文字选择（左键按下拖动；释放时提取文本 + OSC52 复制）
  let selecting = false;
  let selAnchor: { row: number; col: number } | undefined;
  let selCurrent: { row: number; col: number } | undefined;
  // 终端滚动条交互（拖动/点击）后视图位置未知：隐藏 ◉ 指示，直到下次扩展控制的滚动/跳转
  let scrollbarUnknown = false;
  // 滚动条拖动跟踪：按下点 + 按下时视图顶行（释放时按拇指位移近似对齐）
  let scrollbarDrag: { startY: number; startTop: number } | undefined;
  // 内容行数记账：检测新消息追加（追加时解除强制视口回底部，否则新内容不可见）
  let lastContentLen = 0;
  // 用户主动滚动标志：用户通过滚轮/跳转离开底部后，模型输出时不自动跟随回底部
  // （fullscreen 的 ScrollView 有类似逻辑：用户手动滚动后停止 follow-tail）
  let userScrolled = false;

  const dbg = (msg: string) => {
    if (process.env.CHAT_MARKS_DEBUG !== "1") return;
    try {
      writeFileSync(join(tmpdir(), "chat-marks-regular.log"), `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" });
    } catch { /* */ }
  };

  const g = (globalThis as Record<string, unknown>);

  // ---- 终端尺寸（缓存首次可用值，避免 v5 的"多 3 个点"问题） ----

  function termSize(): { rows: number; columns: number } {
    if (cachedSize) return cachedSize;
    const rows = dotsTui?.terminal?.rows ?? process.stdout?.rows ?? 30;
    const columns = dotsTui?.terminal?.columns ?? process.stdout?.columns ?? 80;
    if (dotsTui?.terminal?.rows && dotsTui?.terminal?.columns) cachedSize = { rows, columns };
    return { rows, columns };
  }

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
    // regular 模式没有 pi 的滚动条占位：点列实际渲染在 1-based 列 [columns-1, columns]
    // （fullscreen 有点列左侧的滚动条占位，判定区域是 [columns-2, columns-1]，两者不同）
    if (x < columns - 1 || x > columns) return false;
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
      } else if (i === messages.length - 1) {
        dot = theme.fg("success", "●");
      } else {
        dot = theme.fg("muted", "•");
      }
      // TRANSPARENT_MARK：合成时不重置 SGR，点列继承内容行背景（无黑边）
      rows.push(TRANSPARENT_MARK + (width > 1 ? " " + dot : dot));
    }
    return rows;
  }

  // ---- 行映射（标记行 → 消息索引） ----

  function getRowMap(lines: string[]): Map<number, number> {
    if (rowMapCache && rowMapCache.lines === lines) return rowMapCache.map;
    const map = buildRowMap(lines, messages);
    rowMapCache = { lines, map };
    return map;
  }

  // ---- 视口控制：强制切片渲染 ----

  /** 当前视口顶行（扩展记账；未滚动时跟随 pi 的记账） */
  function currentViewportTop(): number {
    const forced = g["__piViewportTop"];
    if (typeof forced === "number") return forced;
    return dotsTui?.previousViewportTop ?? 0;
  }

  /** 强制渲染 [top, top+height) 切片（清屏 + 重绘，记账保持一致） */
  function setViewport(top: number): void {
    const t = dotsTui;
    if (!t) return;
    const rows = termSize().rows;
    const contentLen = t.previousLines?.length ?? 0;
    const maxTop = Math.max(0, contentLen - rows);
    const target = Math.max(0, Math.min(top, maxTop));
    if (target === currentViewportTop() && target === (g["__piForcedViewportTop"] ?? -1)) return;
    dbg(`setViewport top=${target} (was ${currentViewportTop()}, content=${contentLen}, rows=${rows})`);
    g["__piForcedViewportTop"] = target;
    g["__piViewportTop"] = target;
    scrollbarUnknown = false;
    scrollbarDrag = undefined;
    // 用户主动滚动（滚轮/跳转）：标记离开底部，模型输出时不自动跟随
    if (target < maxTop) {
      userScrolled = true;
    }
    t.requestRender?.(true);
  }

  /** 滚轮滚动对话区（delta 行；正=更新内容方向） */
  function scrollTranscript(delta: number): void {
    const t = dotsTui;
    if (!t) return;
    const rows = termSize().rows;
    const contentLen = t.previousLines?.length ?? 0;
    const maxTop = Math.max(0, contentLen - rows);
    if (maxTop <= 0) return;
    const target = Math.max(0, Math.min(currentViewportTop() + delta, maxTop));
    if (target === currentViewportTop()) return;
    setViewport(target);
  }

  /** 跳转到第 index 条用户消息（视图居中） */
  function jumpToMessage(index: number): boolean {
    const t = dotsTui;
    const target = messages[index];
    if (!t || !target) return false;
    const lines = t.previousLines ?? [];
    if (lines.length === 0) return false;
    const map = getRowMap(lines);
    let matchRow = -1;
    for (const [row, msgIdx] of map) {
      if (msgIdx === index) { matchRow = row; break; }
    }
    if (matchRow < 0) {
      const markers = lines.map((l, i) => OSC133_PROMPT_START.test(l || "") ? `${i}:"${stripAnsi(l || "").slice(0, 28)}"` : "").filter(Boolean).join(" ; ");
      const l51 = stripAnsi(lines[51] || "");
      const l52 = stripAnsi(lines[52] || "");
      dbg(`jumpToMessage idx=${index} FAILED lines=${lines.length} mapSize=${map.size} map=[${[...map.entries()].map(([r, i]) => `${r}:${i}`).join(",")}] markers=[${markers}] l51len=${l51.length} l51=${JSON.stringify(l51)} l52len=${l52.length} l52=${JSON.stringify(l52)} l52trim=${JSON.stringify(stripDotsRegion(l52).trim())}`);
      return false;
    }
    const rows = termSize().rows;
    const top = Math.max(0, Math.min(matchRow - Math.floor(rows / 2), Math.max(0, lines.length - rows)));
    dbg(`jumpToMessage idx=${index} row=${matchRow} top=${top}`);
    if (top === currentViewportTop() && top === (g["__piForcedViewportTop"] ?? -1)) {
      // 视图已在此位置（setViewport 会早退）：直接同步指示器，避免 pinned 残留
      if (viewportIndex !== index) {
        viewportIndex = index;
        syncWindowToViewport();
        dotsTui?.requestRender?.();
      }
    } else {
      // 钉住指示器：渲染完成后由 updateViewportIndicator 消费，◉ 指向目标消息
      // （视口被 clamp 无法居中时，中线扫描会偏到上一条消息）
      pinnedViewportIndex = index;
      setViewport(top);
    }
    showFlash(`已跳转到第 ${index + 1}/${messages.length} 次发送 · ${fmtTime(target.timestamp)}`);
    return true;
  }

  // ---- 视口指示 ----

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
    if (target !== scrollOffset) { scrollOffset = target; dotsTui?.requestRender?.(); }
  }

  /**
   * 渲染后同步（由 __piScrollHook 调用，参数为 TUI 实例）。
   * 1) pi 自己把视图移回底部（追加内容）时，清除持久视口；
   * 2) 修正 hardwareCursorRow 记账（pi 的 positionHardwareCursor 会写入越界值）；
   * 3) 计算视口位置的黄色指示点。
   */
  function updateViewportIndicator(t?: unknown): void {
    const tui = (t ?? dotsTui) as typeof dotsTui | undefined;
    if (!tui) return;
    const lines = tui.previousLines ?? [];
    // 检测视口是否在最底部：如果在底部，清除用户滚动标志（恢复跟随模式）
    const top = currentViewportTop();
    const rows = termSize().rows;
    const maxTop = Math.max(0, lines.length - rows);
    if (lines.length > 0 && (g["__piViewportTop"] === undefined || top >= maxTop)) {
      userScrolled = false;
    }
    // 新消息追加（内容变长）时：如果用户没有主动离开底部，解除强制视口回到底部显示新内容。
    // 如果用户已手动滚动（userScrolled=true），保持当前视口不跟随。
    // 非底部时所有渲染都走切片（见 PATCH9），不检测的话追加的消息永远不可见（用户在底部时）。
    if (lines.length > lastContentLen) {
      lastContentLen = lines.length;
      if (!userScrolled && (g["__piViewportTop"] !== undefined || g["__piForcedViewportTop"] !== undefined)) {
        g["__piViewportTop"] = undefined;
        g["__piForcedViewportTop"] = undefined;
        pinnedViewportIndex = -1;
        cancelSelection();
        dbg(`content appended (${lines.length}): releasing forced viewport (following tail)`);
        tui.requestRender?.();
      }
    } else if (lines.length < lastContentLen) {
      lastContentLen = lines.length;
    }
    const forced = g["__piViewportTop"];
    const pvt = tui.previousViewportTop ?? 0;
    if (typeof forced === "number" && pvt !== forced) {
      g["__piViewportTop"] = undefined;
      pinnedViewportIndex = -1;
      cancelSelection();
      dbg(`viewport reconciled to pi bookkeeping: ${pvt} (was forced ${forced})`);
      // 视图已回到底部：立即重渲染一次，让点列在底部重新合成
      tui.requestRender?.();
      // 视图回到底部后恢复悬停预览 widget
      if (hoverIndex >= 0) updateHoverPreview();
    }
    if ((tui.hardwareCursorRow ?? 0) > top + rows - 1) tui.hardwareCursorRow = top + rows - 1;
    if (lines.length === 0) return;
    let next = -1;
    if (pinnedViewportIndex >= 0) {
      // 跳转钉住的指示：直接指向目标消息（视口被 clamp 时中线扫描会偏到上一条）
      next = pinnedViewportIndex;
      pinnedViewportIndex = -1;
      dbg(`viewport indicator: pinned -> ${next}`);
    } else {
      const mid = Math.min(top + Math.floor(rows / 2), lines.length - 1);
      const map = getRowMap(lines);
      let markRow = -1;
      for (let row = mid; row >= 0; row--) {
        if (OSC133_PROMPT_START.test(lines[row] ?? "") && map.has(row)) {
          markRow = row; break;
        }
      }
      next = markRow >= 0 ? (map.get(markRow) ?? -1) : -1;
      dbg(`viewport indicator: scan mid=${mid} markRow=${markRow} -> ${next} l51marker=${OSC133_PROMPT_START.test(lines[51] || "")} mapHas51=${map.has(51)} l52=${JSON.stringify(stripDotsRegion(stripAnsi(lines[52] || "")).trim().slice(0, 20))}`);
    }
    if (next !== viewportIndex) {
      viewportIndex = next;
      tui.requestRender?.();
      syncWindowToViewport();
    }
    // 选择高亮：渲染完成后重写（渲染会擦掉上次的反色）
    renderSelection();
  }

  // ---- 鼠标追踪 ----

  function enableMouse(tui: TuiBaseLike): void {
    if (mouseEnabled) return;
    // 逃生舱：CHAT_MARKS_NO_REGULAR_MOUSE=1 关闭鼠标追踪（恢复终端原生滚动/选择，点列仅键盘）
    if (process.env.CHAT_MARKS_NO_REGULAR_MOUSE === "1") {
      dbg("mouse tracking disabled by CHAT_MARKS_NO_REGULAR_MOUSE");
      return;
    }
    mouseEnabled = true;
    // SGR 鼠标追踪：1000 按钮 + 1003 全移动 + 1006 SGR 格式
    tui.terminal?.write?.("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
    if (tui.addInputListener) {
      mouseCleanup = tui.addInputListener((data: string) => {
        if (typeof data !== "string" || !data.startsWith("\x1b[<")) return undefined;
        return handleMouse(data);
      });
    }
    dbg("mouse tracking enabled");
  }

  function disableMouse(tui: TuiBaseLike): void {
    if (!mouseEnabled) return;
    mouseEnabled = false;
    mouseCleanup?.();
    mouseCleanup = undefined;
    tui.terminal?.write?.("\x1b[?1003l\x1b[?1000l\x1b[?1006l");
    dbg("mouse tracking disabled");
  }

  /** 视图是否在底部（跟随状态）：仅此时允许更新悬停预览 widget */
  function isViewportAtBottom(): boolean {
    const t = dotsTui;
    if (!t) return true;
    const rows = termSize().rows;
    const contentLen = t.previousLines?.length ?? 0;
    const maxTop = Math.max(0, contentLen - rows);
    return currentViewportTop() >= maxTop;
  }

  /** 右上角 flash（regular 无内置 flash，用 overlay 模拟；与 fullscreen 的 flash 视觉一致） */
  function showFlash(msg: string, ms = 1500): void {
    flashLines = [msg];
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashLines = undefined;
      dotsTui?.requestRender?.();
    }, ms);
    dotsTui?.requestRender?.();
  }

  function updateHoverPreview() {
    const hasHover = hoverIndex >= 0 && hoverIndex < messages.length;
    dbg(`updateHoverPreview hover=${hoverIndex} bottom=${isViewportAtBottom()} previewLines=${previewLines?.length ?? 0}->${hasHover ? 2 : 0}`);
    // 统一用屏幕底部 overlay 预览（与 fullscreen 的 widget 同位置）：
    // widget 在 regular 模式下渲染于内容末尾，更新/清除都会触发差分渲染滚动视口（snap）
    // 且 2 行↔1 行重排会残留黑行 —— overlay 屏幕定位、行数固定，两者都不存在。
    if (hasHover) {
      const m = messages[hoverIndex];
      previewLines = [
        `⏱ ${fmtTime(m.timestamp)} · 第 ${hoverIndex + 1} 次发送`,
        preview(m.text, 60),
      ];
    } else {
      previewLines = undefined;
    }
    dotsTui?.requestRender?.();
  }

  // ---- 内容区文字选择（左键按下拖动；释放时提取文本 + OSC52 复制） ----

  /** 是否有捕获型 overlay 打开（openMarks 列表等）或选择器打开（/settings 等）：
   * 有则放行鼠标事件，不拦截选择 */
  function hasCapturingOverlay(): boolean {
    const t = dotsTui as (TuiBaseLike & {
      overlayStack?: Array<{ options?: { nonCapturing?: boolean } }>;
      isOverlayVisible?: (e: unknown) => boolean;
    }) | undefined;
    return (globalThis as Record<string, unknown>)["__piSelectorActive"] === true
      || !!t?.overlayStack?.some((e) => e.options?.nonCapturing !== true && (t.isOverlayVisible?.(e) ?? true));
  }

  function isWideChar(ch: string): boolean {
    const c = ch.codePointAt(0) ?? 0;
    return (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x2fffd) || (c >= 0x30000 && c <= 0x3fffd);
  }

  function visibleWidthOf(s: string): number {
    let w = 0;
    for (const ch of s) w += isWideChar(ch) ? 2 : 1;
    return w;
  }

  /** 可见列 → 字符索引（宽字符占 2 列，列落在宽字符中间时取该字符起点） */
  function colToCharIndex(s: string, col: number): number {
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      const cw = isWideChar(s[i]) ? 2 : 1;
      if (w + cw > col) return i;
      w += cw;
    }
    return s.length;
  }

  /** 提取 [col1, col2] 可见列区间的文本（按字符边界） */
  function sliceByVisibleCols(s: string, col1: number, col2: number): string {
    const i1 = colToCharIndex(s, Math.max(0, col1));
    const i2 = colToCharIndex(s, Math.max(0, col2 + 1));
    return s.slice(i1, Math.max(i1, i2));
  }

  function beginSelection(x: number, y: number): void {
    const t = dotsTui;
    if (!t) return;
    const top = currentViewportTop();
    const row = y - 1 + top;
    const col = x - 1;
    const lines = t.previousLines ?? [];
    if (row < 0 || row >= lines.length) return;
    selecting = true;
    selAnchor = { row, col };
    selCurrent = { row, col };
    dbg(`selection begin row=${row} col=${col}`);
  }

  function updateSelection(x: number, y: number): void {
    if (!selecting || !selAnchor) return;
    const t = dotsTui;
    if (!t) return;
    const top = currentViewportTop();
    const row = y - 1 + top;
    const col = x - 1;
    const lines = t.previousLines ?? [];
    if (row < 0 || row >= lines.length) return;
    selCurrent = { row, col };
    renderSelection();
  }

  function cancelSelection(): void {
    if (!selecting) return;
    selecting = false;
    selAnchor = undefined;
    selCurrent = undefined;
    dotsTui?.requestRender?.(true);
  }

  function extractSelection(a: { row: number; col: number }, c: { row: number; col: number }): string {
    const t = dotsTui;
    if (!t) return "";
    const lines = t.previousLines ?? [];
    const r1 = Math.min(a.row, c.row);
    const r2 = Math.max(a.row, c.row);
    const c1 = a.row <= c.row ? a.col : c.col;
    const c2 = a.row <= c.row ? c.col : a.col;
    const parts: string[] = [];
    for (let r = r1; r <= r2; r++) {
      const line = stripAnsi(lines[r] ?? "").trimEnd();
      if (r === r1 && r === r2) {
        parts.push(sliceByVisibleCols(line, c1, c2));
      } else if (r === r1) {
        parts.push(sliceByVisibleCols(line, c1, visibleWidthOf(line)));
      } else if (r === r2) {
        parts.push(sliceByVisibleCols(line, 0, c2));
      } else {
        parts.push(line);
      }
    }
    return parts.join("\n").trim();
  }

  function copyToClipboard(text: string): void {
    try {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      dotsTui?.terminal?.write?.(`\x1b]52;c;${b64}\x07`);
      dbg(`selection copied ${text.length} chars via OSC52`);
      showFlash(`已复制 ${text.length} 字符`);
    } catch { /* */ }
  }

  function endSelection(): void {
    if (!selecting) return;
    selecting = false;
    const a = selAnchor;
    const c = selCurrent;
    selAnchor = undefined;
    selCurrent = undefined;
    if (a && c && (a.row !== c.row || a.col !== c.col)) {
      const text = extractSelection(a, c);
      if (text) copyToClipboard(text);
    }
    // 强制重绘一次，清除屏幕上的反色高亮
    dotsTui?.requestRender?.(true);
  }

  /** 渲染选择高亮（反色）：渲染完成后调用，直接写终端覆盖选中区域 */
  function renderSelection(): void {
    if (!selecting || !selAnchor || !selCurrent) return;
    const t = dotsTui;
    if (!t) return;
    const top = currentViewportTop();
    const rows = termSize().rows;
    const lines = t.previousLines ?? [];
    const a = selAnchor;
    const c = selCurrent;
    const r1 = Math.min(a.row, c.row);
    const r2 = Math.max(a.row, c.row);
    const c1 = a.row <= c.row ? a.col : c.col;
    const c2 = a.row <= c.row ? c.col : a.col;
    let buf = "";
    for (let r = r1; r <= r2; r++) {
      if (r < top || r >= top + rows) continue;
      const screenRow = r - top + 1;
      const line = stripAnsi(lines[r] ?? "").trimEnd();
      const seg = sliceByVisibleCols(line, c1, c2);
      if (!seg) continue;
      const startCol = visibleWidthOf(sliceByVisibleCols(line, 0, c1)) + 1;
      buf += `\x1b[${screenRow};${startCol}H\x1b[7m${seg}\x1b[27m`;
    }
    if (buf) t.terminal?.write?.(buf);
  }

  function handleMouse(data: string): { consume?: boolean } | undefined {
    const mouse = parseSgrMouse(data);
    if (!mouse) return undefined;

    const btn = mouse.button & 3;
    const isMove = mouse.button >= 32 && mouse.button < 64;
    const isWheel = mouse.button >= 64;
    dbg(`mouse btn=${mouse.button} x=${mouse.x} y=${mouse.y} ${mouse.press ? "press" : "release"}`);

    // 终端滚动条交互：按下（最右列、点列区域外）= 拖动开始。拖动期间视图由终端滚动，
    // 扩展无法实时感知，且任何渲染都会把视图 snap 回记账位置 —— 因此拖动期间不渲染、
    // 只消费事件；释放时按拇指位移近似公式一次对齐视图（并更新 ◉）。
    if (btn === 0 && mouse.press && mouse.x === termSize().columns && !inDotsRegion(mouse.x, mouse.y)) {
      scrollbarUnknown = true;
      scrollbarDrag = { startY: mouse.y, startTop: currentViewportTop() };
      viewportIndex = -1;
      dotsTui?.requestRender?.();
      dbg(`scrollbar drag start y=${mouse.y} startTop=${scrollbarDrag.startTop}`);
      return { consume: true };
    }
    if (scrollbarDrag) {
      // 拖动中：只消费，不渲染
      if (btn === 0 && !mouse.press) {
        // 释放：拇指位移 × (内容行数/可视行数) ≈ 滚动量，一次对齐（Δy≈0 = 纯点击，保持隐藏）
        const t = dotsTui;
        if (t) {
          const rows = termSize().rows;
          const contentLen = t.previousLines?.length ?? 0;
          const dy = mouse.y - scrollbarDrag.startY;
          if (Math.abs(dy) >= 1 && rows > 0 && contentLen > rows) {
            const ratio = contentLen / rows;
            // 鼠标上移(dy<0)= 看更旧内容 = 顶行减小;下移反之
            const finalTop = Math.max(0, Math.min(scrollbarDrag.startTop + dy * ratio, contentLen - rows));
            dbg(`scrollbar drag end dy=${dy} ratio=${ratio.toFixed(2)} top=${finalTop.toFixed(0)}`);
            setViewport(Math.round(finalTop));
          } else {
            dbg("scrollbar click (no drag), viewport stays unknown");
          }
        }
        scrollbarDrag = undefined;
      }
      return { consume: true };
    }

    // ---- 内容区文字选择（左键按下拖动；捕获型 overlay（设置选择器等）打开时不拦截） ----
    if (selecting) {
      if (isMove) { updateSelection(mouse.x, mouse.y); return { consume: true }; }
      if (btn === 0 && !mouse.press) { endSelection(); return { consume: true }; }
      if (isWheel || btn === 1 || btn === 2) cancelSelection(); // 取消选择后继续处理
    } else if (btn === 0 && !isWheel && mouse.press && !inDotsRegion(mouse.x, mouse.y) && mouse.x !== termSize().columns && !hasCapturingOverlay()) {
      // 滚轮按钮 64/65 的 btn(=button&3)也是 0,必须排除 isWheel,否则上滑被误判为选择开始
      beginSelection(mouse.x, mouse.y);
      return { consume: true };
    }

    if (!inDotsRegion(mouse.x, mouse.y)) {
      // 点列区域外：清除悬停；滚轮滚动对话区；其余事件放行
      // （/settings 等 UI 需要鼠标事件，全部 consume 会导致它们无法点击）
      if ((isMove || (btn === 0 && mouse.press)) && hoverIndex !== -1) {
        hoverIndex = -1; updateHoverPreview(); dotsTui?.requestRender?.();
      }
      if (isWheel) {
        // 滚轮滚动对话区（视图由扩展控制；不再用 DECSCROLL，避免与 pi 记账失同步）
        scrollTranscript(btn === 0 ? -3 : 3);
        return { consume: true };
      }
      return undefined;
    }

    // ---- 点列区域内 ----
    const target = indexAtRow(mouse.y);

    if (isMove) {
      if (target !== hoverIndex) { hoverIndex = target; updateHoverPreview(); dotsTui?.requestRender?.(); }
      return { consume: true };
    }
    if (isWheel) {
      if (btn === 0) scrollOffset--; else scrollOffset++;
      clampOffset(); dotsTui?.requestRender?.();
      return { consume: true };
    }
    if (btn === 0 && mouse.press) {
      if (target >= 0) {
        hoverIndex = -1; updateHoverPreview();
        const ok = jumpToMessage(target);
        if (!ok) ctx.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
        dotsTui?.requestRender?.();
      }
      return { consume: true };
    }
    if (btn === 1 || btn === 2 || !mouse.press) return { consume: true };
    return { consume: true };
  }

  // ---- 初始化 ----
  return {
    init(tui: TuiBaseLike, theme: { fg: (c: string, s: string) => string; bold: (s: string) => string; bg: (c: string, s: string) => string }) {
      dotsTui = tui;
      const rows = tui.terminal?.rows ?? process.stdout?.rows ?? 30;
      const columns = tui.terminal?.columns ?? process.stdout?.columns ?? 80;
      cachedSize = { rows, columns };
      enableMouse(tui);
      // 悬停预览 overlay（屏幕底部，与 fullscreen 的 widget 同位置；更新不触发视口 snap）。
      // 延迟创建：init 本身在 ui.custom factory 里执行，嵌套创建 overlay 不安全。
      if (!previewOverlayCreated) {
        previewOverlayCreated = true;
        setTimeout(() => {
          try {
            ctx.ui.custom((_t, theme2) => ({
              render: (w: number) => {
                const lines = previewLines;
                if (!lines || lines.length === 0) return [];
                return lines.map((l) => theme2.fg("muted", l));
              },
              invalidate: () => {},
              handleInput: () => {},
            }), {
              overlay: true,
              overlayOptions: {
                anchor: "bottom-left",
                width: "100%",
                maxHeight: 2,
                offsetY: -2,
                nonCapturing: true,
                __cmPersistent: true,
              },
            });
          } catch { /* 预览 overlay 创建失败不影响核心功能 */ }
        }, 300);
      }
      // 跳转 flash overlay（屏幕右上角，与 fullscreen 的 flash 一致）
      if (!flashOverlayCreated) {
        flashOverlayCreated = true;
        setTimeout(() => {
          try {
            ctx.ui.custom((_t, theme2) => ({
              render: (w: number) => {
                const lines = flashLines;
                if (!lines || lines.length === 0) return [];
                return lines.map((l) => theme2.fg("accent", theme2.bold(l)));
              },
              invalidate: () => {},
              handleInput: () => {},
            }), {
              overlay: true,
              overlayOptions: {
                anchor: "top-center",
                width: "80%",
                maxHeight: 1,
                offsetY: 0,
                nonCapturing: true,
                __cmPersistent: true,
              },
            });
          } catch { /* flash overlay 创建失败不影响核心功能 */ }
        }, 350);
      }
      return {
        render: (w: number) => renderDots(w, theme),
        invalidate: () => {},
        handleInput: () => {},
      };
    },

    cleanup() {
      if (dotsTui) disableMouse(dotsTui);
      g["__piViewportTop"] = undefined;
      g["__piForcedViewportTop"] = undefined;
    },

    scrollToBottom() { /* regular 模式：pi 原生渲染即回底部，无需处理 */ },

    jumpToMessage,
    updateViewportIndicator,
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

  // [chat-marks-debug] 临时:捕获未处理异常到日志文件(定位切换崩溃)
  try {
    const { writeFileSync: cmWfs } = require("node:fs") as typeof import("node:fs");
    const { tmpdir: cmTmp } = require("node:os") as typeof import("node:os");
    const { join: cmJoin } = require("node:path") as typeof import("node:path");
    process.on("uncaughtException", (e) => {
      try { cmWfs(cmJoin(cmTmp(), "chat-marks-crash.log"), `[${new Date().toISOString()}] ${e?.stack ?? e}\n`, { flag: "a" }); } catch { /* */ }
    });
    process.on("unhandledRejection", (e) => {
      try { cmWfs(cmJoin(cmTmp(), "chat-marks-crash.log"), `[${new Date().toISOString()}] REJECTION ${e}\n`, { flag: "a" }); } catch { /* */ }
    });
  } catch { /* */ }

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
        const ok = handler?.jumpToMessage?.(idx) ?? false;
        if (!ok) {
          ctx.ui.notify("未能在对话区定位到该消息（可能已被折叠或不在当前会话）", "warning");
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

  /** 创建点列 overlay + 对应模式 handler（session_start 与 TUI 切换后重建共用） */
  function setupOverlays(ctx: ExtensionContext) {
    void ctx.ui.custom((tui, theme) => {
      if (isFullscreenTui(tui as TuiInstance)) {
        // ---- fullscreen 模式：完整功能 ----
        handler = createFullscreenHandler(messages, ctx);
        const overlay = handler.init(tui as TuiFullscreenLike, theme);
        log("[chat-marks] fullscreen 模式：完整功能已启用");
        return overlay;
      } else {
        // ---- regular 模式：完整功能（强制视口切片渲染） ----
        handler = createRegularHandler(messages, ctx);
        const overlay = handler.init(tui as TuiInstance, theme);
        log("[chat-marks] regular 模式：完整功能已启用（鼠标追踪 + 视口切片）");
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
        // 常驻标记：pi 的 switchTuiMode 检查会忽略带此标记的 overlay
        __cmPersistent: true,
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (patchProblem && ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.notify("[chat-marks] ⚠️ " + patchProblem, "warning");
    }

    messages = [];
    sessionCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    // 渲染钩子（PATCH6 renderNow + PATCH4/5 scroll-view 共用；regular 由扩展控制视图）
    (globalThis as Record<string, unknown>)["__piScrollHook"] = (t?: unknown) => {
      handler?.updateViewportIndicator?.(t);
    };

    // TUI mode 切换完成（interactive-mode.js 补丁 __piAfterTuiSwitch 调用）：
    // 旧 TUI 已销毁、新 TUI 已 start —— 清理旧 handler，延迟重建常驻 overlay。
    (globalThis as Record<string, unknown>)["__piAfterTuiSwitch"] = () => {
      handler?.cleanup?.();
      handler = undefined;
      const c = sessionCtx;
      if (c) setTimeout(() => setupOverlays(c), 150);
    };

    // 读取历史消息
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message?.role === "user") {
          const text = extractText(entry.message.content);
          if (text) messages.push({ id: entry.id, timestamp: entry.message.timestamp ?? Date.now(), text });
        }
      }
    } catch { /* */ }

    // 创建点列 overlay + handler（TUI 切换后也会调用重建；__cmPersistent 标记让
    // /settings 切 TUI mode 时不被 pi 的 hasOverlayEntries 检查阻止）
    setupOverlays(ctx);

    // 等布局完成后滚到底部 + 同步视口
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
    (globalThis as Record<string, unknown>)["__piScrollHook"] = undefined;
    (globalThis as Record<string, unknown>)["__piAfterTuiSwitch"] = undefined;
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
