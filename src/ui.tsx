import { useState, type ReactNode } from "react";
import { Box, Text, useAnimation, useInput, type Key } from "ink";
import { stringWidth } from "./text.js";

export const colors = { accent: "#A78BFA", warm: "#E8BC73", muted: "#7C8499", good: "#8DC7A5", error: "#E88E8E", line: "#444B5E", ink: "#16161E", chip: "#2B3040" };

export const formatDuration = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 全部动画共用 Ink 的同一个定时器，不会各自触发重绘。
export function Spinner({ color = colors.accent }: { color?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={color}>{frames[frame % frames.length]}</Text>;
}

// 实时计时；任务结束后传入 fixed 即定格。
export function Elapsed({ since, fixed }: { since: number; fixed?: number }) {
  useAnimation({ interval: 200, isActive: fixed === undefined });
  return <Text>{formatDuration(fixed ?? Date.now() - since)}</Text>;
}

// ── 标题 ──────────────── 右侧信息 ─
export function Rule({ width, label, right, color = colors.line, labelColor = colors.muted }: {
  width: number; label?: string; right?: string; color?: string; labelColor?: string;
}) {
  const head = label ? ` ${label} ` : "";
  let tail = right ? ` ${right} ` : "";
  let fill = width - 1 - stringWidth(head) - stringWidth(tail) - 1;
  if (fill < 0) { tail = ""; fill = Math.max(0, width - 1 - stringWidth(head)); }
  return <Text wrap="truncate-end">
    <Text color={color}>─</Text>
    {head && <Text color={labelColor} bold>{head}</Text>}
    <Text color={color}>{"─".repeat(fill)}</Text>
    {tail && <Text color={colors.muted}>{tail}</Text>}
    {tail && <Text color={color}>─</Text>}
  </Text>;
}

// 开关状态：● 开 / ○ 关。
export function Dot({ on, onColor = colors.good }: { on: boolean; onColor?: string }) {
  return <Text color={on ? onColor : colors.muted}>{on ? "●" : "○"}</Text>;
}

// 底部快捷键栏：按优先级排列，放不下的从末尾丢弃。
export function KeyHints({ items, width }: { items: [key: string, label: string][]; width: number }) {
  const shown: typeof items = [];
  let used = 0;
  for (const item of items) {
    const size = stringWidth(item[0]) + 1 + stringWidth(item[1]) + (shown.length ? 2 : 0);
    if (used + size > width) break;
    shown.push(item); used += size;
  }
  return <Text wrap="truncate-end">{shown.map(([key, label], index) => <Text key={key}>
    {index > 0 && "  "}<Text color={colors.accent} bold>{key}</Text><Text color={colors.muted}> {label}</Text>
  </Text>)}</Text>;
}

// 滚动状态。follow 为真时停在底部，新内容进来自动跟随；向上滚动后取消跟随，滚回底部恢复。
export function useScroll(total: number, height: number, follow = false) {
  const [raw, setRaw] = useState(0);
  const [pinned, setPinned] = useState(follow);
  const max = Math.max(0, total - height);
  const offset = pinned ? max : Math.min(raw, max);
  const scrollTo = (next: number) => {
    const value = Math.max(0, Math.min(max, next));
    setRaw(value); setPinned(follow && value >= max);
  };
  const page = Math.max(1, height - 1);
  // arrows=false 时方向键留给列表选择，只响应翻页键。
  function handle(input: string, key: Key, arrows = true): boolean {
    // Ctrl+U / Ctrl+D 供没有 PgUp/PgDn 的 Mac 键盘使用，且不占用方向键。
    if (key.pageUp || (key.ctrl && input === "u") || (arrows && input === "b")) scrollTo(offset - page);
    else if (key.pageDown || (key.ctrl && input === "d") || (arrows && input === " ")) scrollTo(offset + page);
    else if (key.home || (arrows && input === "g")) scrollTo(0);
    else if (key.end || (arrows && input === "G")) scrollTo(max);
    else if (arrows && (key.upArrow || input === "k")) scrollTo(offset - 1);
    else if (arrows && (key.downArrow || input === "j")) scrollTo(offset + 1);
    else return false;
    return true;
  }
  return { offset, max, pinned, handle, reset: () => { setRaw(0); setPinned(follow); } };
}

// 固定高度的滚动视口，右侧始终预留一列滚动条，避免出现时挤压内容宽度。
export function Viewport({ rows, height, offset }: { rows: ReactNode[]; height: number; offset: number }) {
  const total = rows.length;
  const max = Math.max(0, total - height);
  const visible = rows.slice(offset, offset + height);
  const scrollable = max > 0;
  const thumb = Math.max(1, Math.round(height * height / Math.max(total, 1)));
  const top = max ? Math.round(offset / max * (height - thumb)) : 0;
  return <Box height={height} flexShrink={0}>
    <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
      {visible.map((row, index) => <Box key={offset + index} height={1} flexShrink={0}>{row}</Box>)}
    </Box>
    <Box flexDirection="column" width={1} marginLeft={1} flexShrink={0}>
      {Array.from({ length: height }, (_, index) => scrollable
        ? <Text key={index} color={index >= top && index < top + thumb ? colors.accent : colors.line}>{index >= top && index < top + thumb ? "┃" : "│"}</Text>
        : <Text key={index}> </Text>)}
    </Box>
  </Box>;
}

// 双按钮确认：默认停在取消；y / n 直达，←→ 切换，Enter 执行当前按钮。
export function Confirm({ confirmLabel, cancelLabel = "取消", tone = colors.warm, onConfirm, onCancel }: {
  confirmLabel: string; cancelLabel?: string; tone?: string; onConfirm: () => void; onCancel: () => void;
}) {
  const [focus, setFocus] = useState<"cancel" | "confirm">("cancel");
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.leftArrow || key.rightArrow || key.tab || input === "h" || input === "l") setFocus(current => current === "cancel" ? "confirm" : "cancel");
    else if (input.toLowerCase() === "y") onConfirm();
    else if (input.toLowerCase() === "n") onCancel();
    else if (key.return) (focus === "confirm" ? onConfirm : onCancel)();
  });
  const button = (label: string, active: boolean, color: string) => active
    ? <Text backgroundColor={color} color={colors.ink} bold>{`  ${label}  `}</Text>
    : <Text backgroundColor={colors.chip} color={colors.muted}>{`  ${label}  `}</Text>;
  return <Box gap={2}>
    {button(cancelLabel, focus === "cancel", colors.accent)}
    {button(confirmLabel, focus === "confirm", tone)}
  </Box>;
}
