import { useEffect, useMemo, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { steps } from "./deploy.js";
import type { Profile } from "./config.js";
import type { ProjectState } from "./preflight.js";
import { authNames } from "./settings.js";
import { stringWidth, truncate, wrapText } from "./text.js";
import { Confirm, Dot, Elapsed, Rule, Spinner, Viewport, colors, formatDuration, useScroll } from "./ui.js";

export type ProjectInfo = { text: string; tone: "muted" | "good" | "warm" | "error" };
export type Job = {
  kind: "deploy" | "check"; title: string; step: number; stepAt: number[]; logs: string;
  status: "running" | "success" | "error" | "cancelled"; started: number; elapsed?: number; error?: string;
};
const toneColor = { muted: colors.muted, good: colors.good, warm: colors.warm, error: colors.error } as const;

// 目录只留最后两级，帮助辨认目标；多个目标时其余用数量提示。
const shortDir = (dir: string) => `…/${dir.split("/").filter(Boolean).slice(-2).join("/")}`;
export const dirList = (dirs: string[]) => dirs.map(shortDir).join(" ") + (dirs.length > 1 ? ` +${dirs.length - 1}` : "");
export const endpoint = (profile: Profile) => `${profile.user}@${profile.host}${profile.port === 22 ? "" : `:${profile.port}`}`;

function Field({ label, children, width = 10 }: { label: string; children: ReactNode; width?: number }) {
  return <Box>
    <Box width={width} flexShrink={0}><Text color={colors.muted}>{label}</Text></Box>
    <Box flexGrow={1} minWidth={0}>{children}</Box>
  </Box>;
}
const Value = ({ children, color, middle }: { children: ReactNode; color?: string; middle?: boolean }) =>
  <Text color={color} wrap={middle ? "truncate-middle" : "truncate-end"}>{children}</Text>;
const Heading = ({ mark, title }: { mark: string; title: string }) =>
  <Text><Text backgroundColor={colors.chip} color={colors.accent} bold>{` ${mark} `}</Text><Text bold> {title}</Text></Text>;

const Gap = () => <Text> </Text>;

function LockRow({ label, on, detail }: { label: string; on: boolean; detail?: string }) {
  return <Field label={label}><Text wrap="truncate-end"><Dot on={on} /> <Text color={on ? undefined : colors.muted}>{on ? `开启${detail ? ` · ${detail}` : ""}` : "关闭"}</Text></Text></Field>;
}

// 配置详情：A 源 → 流程 → B 目标 → 保护；详情页逐行展示锁，发布确认页收成一行。
export function detailRows(profile: Profile, project: ProjectInfo, here: string, chips = false, gaps = true): ReactNode[] {
  const locked = profile.lockDirectory || profile.lockMapping;
  const rows: ReactNode[] = [
    <Heading key="a" mark="A" title="本地源" />,
    <Field key="dir" label="目录">
      <Box><Box minWidth={0} flexShrink={1}><Value middle>{locked ? profile.projectDir : here}</Value></Box>
        {!locked && <Box flexShrink={0} marginLeft={1}><Text color={colors.muted}>启动目录</Text></Box>}</Box>
    </Field>,
    <Field key="git" label="Git"><Value color={toneColor[project.tone]}>{project.text}</Value></Field>,
    ...(gaps ? [<Gap key="g1" />] : []),
    <Heading key="flow" mark="→" title="构建与发布" />,
    <Field key="build" label="构建"><Value color={profile.buildCommand ? undefined : colors.muted}>{profile.buildCommand || "跳过构建，直接发布"}</Value></Field>,
    <Field key="out" label="发布内容"><Value>{profile.outputDir}</Value></Field>,
    <Field key="auth" label="登录"><Value>{authNames[profile.auth]}{profile.auth === "env" ? ` · ${profile.passwordEnv}` : ""}</Value></Field>,
    ...(gaps ? [<Gap key="g2" />] : []),
    <Heading key="b" mark="B" title="远程目标" />,
    <Field key="host" label="服务器"><Value>{profile.user}@{profile.host}:{profile.port}</Value></Field>,
    ...profile.remoteDirs.map((dir, index) => <Field key={dir} label={index ? "" : "目录"}><Value middle>{dir}</Value></Field>),
    ...(gaps ? [<Gap key="g3" />] : []),
    <Heading key="lock" mark="◆" title="保护" />
  ];
  const mapping = profile.mapping ? dirList(profile.mapping.remoteDirs) : "未绑定";
  if (chips) {
    rows.push(<Text key="chips" wrap="truncate-end">
      <Dot on={profile.lockDirectory} /> 目录锁  <Dot on={profile.lockBranch} /> 分支锁{profile.lockBranch ? ` ${profile.expectedBranch}` : ""}  <Dot on={profile.lockMapping} /> 映射锁  <Dot on={profile.checkGit} /> Git 检查
    </Text>);
  } else {
    rows.push(
      <LockRow key="l1" label="目录锁" on={profile.lockDirectory} detail={profile.projectDir} />,
      <LockRow key="l2" label="分支锁" on={profile.lockBranch} detail={profile.expectedBranch} />,
      <LockRow key="l3" label="映射锁" on={profile.lockMapping} detail={mapping} />,
      <LockRow key="l4" label="Git 检查" on={profile.checkGit} detail="异常需确认" />
    );
  }
  return rows;
}

function EnvItem({ profile, selected }: { profile: Profile; selected: boolean }) {
  const bar = <Box width={2} flexShrink={0} flexDirection="column"><Text color={colors.accent}>{selected ? "▌" : " "}</Text><Text color={colors.accent}>{selected ? "▌" : " "}</Text></Box>;
  return <Box height={2} flexShrink={0}>
    {bar}
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <Box>
        <Box flexGrow={1} minWidth={0}><Text bold color={selected ? colors.accent : undefined} wrap="truncate-end">{profile.name}</Text></Box>
        <Box flexShrink={0} marginLeft={1}><Text color={colors.muted}>{profile.id}</Text></Box>
      </Box>
      <Text color={selected ? undefined : colors.muted} wrap="truncate-end">{endpoint(profile)} · {dirList(profile.remoteDirs)}</Text>
    </Box>
  </Box>;
}

// 左侧环境列表（可滚动窗口）+ 右侧详情；窄窗口只显示列表。
export function Dashboard({ profiles, index, project, here, width, height }: {
  profiles: Profile[]; index: number; project: ProjectInfo; here: string; width: number; height: number;
}) {
  const profile = profiles[index];
  const wide = width >= 78;
  const listWidth = wide ? Math.max(34, Math.min(46, Math.floor(width * 0.38))) : width;
  const detailWidth = width - listWidth;
  const spaced = height - 1 >= profiles.length * 3;
  const itemHeight = spaced ? 3 : 2;
  const capacity = Math.max(1, Math.floor((height - 1 + (spaced ? 1 : 0)) / itemHeight));
  const start = Math.max(0, Math.min(profiles.length - capacity, index - Math.floor((capacity - 1) / 2)));
  // 高度不够时去掉分组间的空行，尽量一屏看全。
  const rows = useMemo(() => {
    if (!profile) return [];
    const spaced = detailRows(profile, project, here);
    return spaced.length > height - 3 ? detailRows(profile, project, here, false, false) : spaced;
  }, [profile, project, here, height]);
  const viewport = Math.max(1, Math.min(rows.length, height - 3));
  const scroll = useScroll(rows.length, viewport);
  const { reset } = scroll;
  useEffect(() => { reset(); }, [profile?.id]);
  useInput((input, key) => { scroll.handle(input, key, false); });

  return <Box height={height}>
    <Box flexDirection="column" width={listWidth} flexShrink={0} paddingRight={wide ? 2 : 0}>
      <Rule width={listWidth - (wide ? 2 : 0)} label="环境" right={profiles.length > capacity ? `${index + 1}/${profiles.length}` : String(profiles.length)} />
      {profiles.slice(start, start + capacity).map(item => <Box key={item.id} flexDirection="column" marginBottom={spaced ? 1 : 0}>
        <EnvItem profile={item} selected={item.id === profile?.id} />
      </Box>)}
      {!profiles.length && <Box marginTop={1}><Text color={colors.muted}>暂无环境配置</Text></Box>}
    </Box>
    {wide && <Box flexDirection="column" width={detailWidth} height={profile ? viewport + 3 : Math.min(height, 11)} borderStyle="round" borderColor={colors.line} paddingX={1}>
      {profile ? <>
        <Box>
          <Box flexGrow={1} minWidth={0}><Text bold color={colors.warm} wrap="truncate-end">{profile.name}</Text></Box>
          <Box flexShrink={0} marginLeft={1}><Text color={colors.muted}>{profile.id}</Text></Box>
        </Box>
        <Viewport rows={rows} height={viewport} offset={scroll.offset} />
      </> : <Box flexDirection="column" gap={1} marginTop={1}>
        <Text bold color={colors.accent}>◆ code-deploy</Text>
        <Text>把本地目录 A 发布到服务器目录 B。</Text>
        <Text color={colors.muted}>配置一次：源目录、服务器、远程目录和保护规则；{"\n"}之后选中环境，Enter 即可发布。</Text>
        <Text>按 <Text color={colors.accent} bold>n</Text> 新建第一个环境，或输入 <Text color={colors.accent} bold>/new</Text></Text>
      </Box>}
    </Box>}
  </Box>;
}

// 发布确认：A → B 全貌放进可滚动视口，按钮固定在底部。
export function ConfirmPanel({ profile, project, here, width, height, onConfirm, onCancel }: {
  profile: Profile; project: ProjectInfo; here: string; width: number; height: number; onConfirm: () => void; onCancel: () => void;
}) {
  const panel = Math.min(width, 90);
  const warning = wrapText("发布前会检查锁定规则和 Git 状态，再替换远程目录 B；旧版本保留为备份。", panel - 4);
  const rows = useMemo(() => {
    const spaced = detailRows(profile, project, here, true);
    return spaced.length > height - 5 - warning.length ? detailRows(profile, project, here, true, false) : spaced;
  }, [profile, project, here, height, warning.length]);
  const viewport = Math.max(1, Math.min(rows.length, height - 5 - warning.length));
  const scroll = useScroll(rows.length, viewport);
  useInput((input, key) => { scroll.handle(input, key); });
  return <Box width={panel} borderStyle="round" borderColor={colors.warm} paddingX={1} flexDirection="column">
    <Text><Text bold color={colors.warm}>确认发布</Text><Text color={colors.muted}>  {profile.name}</Text></Text>
    <Viewport rows={rows} height={viewport} offset={scroll.offset} />
    <Box flexDirection="column" marginTop={1}>
      {warning.map((line, index) => <Text key={index} color={colors.warm}>{line}</Text>)}
    </Box>
    <Confirm confirmLabel="发布" onConfirm={onConfirm} onCancel={onCancel} />
  </Box>;
}

export function DeletePanel({ profile, width, onConfirm, onCancel }: { profile: Profile; width: number; onConfirm: () => void; onCancel: () => void }) {
  return <Box width={Math.min(width, 90)} borderStyle="round" borderColor={colors.error} paddingX={1} flexDirection="column" gap={1}>
    <Text><Text bold color={colors.error}>删除配置</Text><Text color={colors.muted}>  {profile.name} / {profile.id}</Text></Text>
    <Text>将删除这条发布配置及其关联的钥匙串密码；服务器上的文件不受影响。</Text>
    <Confirm confirmLabel="删除" tone={colors.error} onConfirm={onConfirm} onCancel={onCancel} />
  </Box>;
}

// 日志行着色：步骤标记、错误、警告、成功。
function lineColor(line: string): string | undefined {
  if (line.startsWith("▸ ")) return colors.accent;
  if (/error|fatal|denied|失败|拒绝|无法|✗/i.test(line)) return colors.error;
  if (/warn|警告|提醒/i.test(line)) return colors.warm;
  if (/^(部署完成|旧版本保留)|✓/.test(line)) return colors.good;
  return undefined;
}

function Stepper({ job, width }: { job: Job; width: number }) {
  const end = job.started + (job.elapsed ?? 0);
  const state = (index: number) => job.status === "success" || index < job.step ? "done"
    : index === job.step ? (job.status === "running" ? "active" : "failed") : "todo";
  const duration = (index: number) => state(index) === "done" ? ` ${formatDuration((job.stepAt[index + 1] ?? end) - (job.stepAt[index] ?? job.started))}` : "";
  const full = steps.reduce((sum, label, index) => sum + 2 + stringWidth(label) + stringWidth(duration(index)) + (index ? 4 : 0), 0);
  const icon = (index: number) => {
    const current = state(index);
    return current === "done" ? <Text color={colors.good}>✓</Text> : current === "failed" ? <Text color={colors.error}>✗</Text>
      : current === "active" ? <Spinner /> : <Text color={colors.muted}>○</Text>;
  };
  if (full > width) {
    const current = Math.min(job.step, steps.length - 1);
    return <Text wrap="truncate-end">{icon(current)} <Text bold>{current + 1}/{steps.length}</Text> {steps[current]} <Text color={colors.good}>{"▰".repeat(job.status === "success" ? steps.length : current)}</Text><Text color={colors.line}>{"▰".repeat(job.status === "success" ? 0 : steps.length - current)}</Text></Text>;
  }
  return <Box>{steps.map((label, index) => {
    const current = state(index);
    const color = current === "done" ? colors.good : current === "failed" ? colors.error : current === "active" ? colors.accent : colors.muted;
    return <Box key={label}>
      {index > 0 && <Text color={current === "todo" ? colors.line : colors.good}>{" ── "}</Text>}
      {icon(index)}<Text color={color} bold={current === "active"}> {label}</Text><Text color={colors.muted}>{duration(index)}</Text>
    </Box>;
  })}</Box>;
}

// 执行视图：步骤条 + 可滚动输出 + 常驻结果行；失败原因固定在底部，不会被日志淹没。
export function JobView({ job, width, height }: { job: Job; width: number; height: number }) {
  const textWidth = Math.max(10, width - 2);
  const lines = useMemo(() => wrapText(job.logs || "正在检查…", textWidth), [job.logs, textWidth]);
  const failed = job.status === "error" || job.status === "cancelled";
  const status = failed ? 2 : 1;
  const viewport = Math.max(1, height - 2 - status);
  const rows = useMemo(() => lines.map(line => <Text wrap="truncate-end" color={lineColor(line)} bold={line.startsWith("▸ ")}>{line || " "}</Text>), [lines]);
  const scroll = useScroll(rows.length, viewport, true);
  useInput((input, key) => { scroll.handle(input, key); });
  const end = Math.min(rows.length, scroll.offset + viewport);
  const position = scroll.pinned ? (job.status === "running" ? "跟随最新输出" : "已到底部") : `${scroll.offset + 1}–${end} / ${rows.length} · G 回到底部`;
  // 子进程失败时首行只有退出码，末行才是真正原因，两者合并显示。
  const detail = (job.error || "").split("\n").map(line => line.trim()).filter(Boolean);
  const reason = detail.length > 1 ? `${detail[0]}：${detail.at(-1)}` : detail[0] ?? "";
  return <Box flexDirection="column" height={height}>
    {job.kind === "deploy" ? <Stepper job={job} width={width} /> : <Text wrap="truncate-end"><Text color={colors.accent} bold>{job.title}</Text></Text>}
    <Rule width={width} label="输出" right={position} />
    <Viewport rows={rows} height={viewport} offset={scroll.offset} />
    {job.status === "running"
      ? <Text><Spinner /> 执行中 · <Elapsed since={job.started} /><Text color={colors.muted}>  Ctrl+C 取消</Text></Text>
      : job.status === "success"
        ? <Text color={colors.good} bold>✓ {job.kind === "deploy" ? "发布完成" : "检查完成"}<Text color={colors.muted} bold={false}> · 用时 {formatDuration(job.elapsed ?? 0)}</Text></Text>
        : <>
          <Text color={colors.error} bold>✗ {job.status === "cancelled" ? "已取消" : job.kind === "deploy" ? "发布失败" : "检查失败"}<Text color={colors.muted} bold={false}> · 用时 {formatDuration(job.elapsed ?? 0)}</Text></Text>
          <Text color={colors.error} wrap="truncate-end">{truncate(reason, width)}</Text>
        </>}
  </Box>;
}

// Git 状态需要人工确认时显示：提醒内容可滚动，按钮固定。
export function GitPrompt({ state, width, height, onAnswer }: { state: ProjectState; width: number; height: number; onAnswer: (value: boolean) => void }) {
  const lines = useMemo(() => wrapText(state.warnings.join("\n\n"), Math.max(10, width - 6)), [state, width]);
  const viewport = Math.max(1, Math.min(lines.length, height - 6));
  const rows = useMemo(() => lines.map(line => <Text wrap="truncate-end" color={/^\s*(M|A|D|R|\?\?|!!|[ MADRC]{2})\s/.test(line) ? colors.warm : undefined}>{line || " "}</Text>), [lines]);
  const scroll = useScroll(rows.length, viewport);
  useInput((input, key) => { scroll.handle(input, key); });
  return <Box width={Math.min(width, 100)} borderStyle="round" borderColor={colors.warm} paddingX={1} flexDirection="column">
    <Text><Text bold color={colors.warm}>Git 状态需要确认</Text><Text color={colors.muted}>  尚未执行构建或上传</Text></Text>
    <Text color={colors.muted} wrap="truncate-middle">{state.directory} · {state.branch || "无分支"}</Text>
    <Viewport rows={rows} height={viewport} offset={scroll.offset} />
    <Text>仍要使用当前本地内容发布？</Text>
    <Confirm confirmLabel="仍然发布" onConfirm={() => onAnswer(true)} onCancel={() => onAnswer(false)} />
  </Box>;
}
