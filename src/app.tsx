import { useEffect, useRef, useState } from "react";
import type { WriteStream } from "node:tty";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ConfirmInput, Spinner, TextInput, ThemeProvider, defaultTheme, extendTheme } from "@inkjs/ui";
import { configFile, saveConfig, type Config, type Profile } from "./config.js";
import { deletePassword } from "./credentials.js";
import { checkServer, deploy, steps } from "./deploy.js";
import { inspectProject, type ProjectState } from "./preflight.js";
import { Settings, colors, authNames } from "./settings.js";

const theme = extendTheme(defaultTheme, { components: {
  Spinner: { styles: { frame: () => ({ color: colors.accent }) } }
} });
type Screen = "dashboard" | "settings" | "confirm" | "delete" | "job";
type Job = { title: string; step: number; logs: string; status: "running" | "success" | "error"; started: number; elapsed?: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatDuration = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
// 目录只留最后两级，帮助辨认目标。
const shortDir = (dir: string) => `…/${dir.split("/").filter(Boolean).slice(-2).join("/")}`;
// 多个目标时只显示第一个，其余用数量提示。
const dirList = (dirs: string[]) => dirs.map(shortDir).join(" ") + (dirs.length > 1 ? ` +${dirs.length - 1}` : "");

// 源目录和实际分支放在配置旁边，发布前能直接核对 A → B。
function Summary({ profile, project }: { profile: Profile; project: string }) {
  const rows = [
    ["源目录 A", profile.lockDirectory || profile.lockMapping ? profile.projectDir : `${process.cwd()}（启动目录）`],
    ["Git 状态", project], ["远程目录 B", `${profile.user}@${profile.host}:${profile.port} ${dirList(profile.remoteDirs)}`],
    ["构建命令", profile.buildCommand || "跳过构建，直接发布"], ["发布内容", profile.outputDir],
    ["登录方式", `${authNames[profile.auth]}${profile.auth === "env" ? ` · ${profile.passwordEnv}` : ""}`],
    ["目录锁", profile.lockDirectory ? `开启 · ${profile.projectDir}` : "关闭"],
    ["分支锁", profile.lockBranch ? `开启 · ${profile.expectedBranch}` : "关闭"],
    ["映射锁", profile.lockMapping ? `开启 · ${profile.mapping ? dirList(profile.mapping.remoteDirs) : "未绑定"}` : "关闭"],
    ["Git 检查", profile.checkGit ? "开启 · 异常需确认" : "关闭"]
  ];
  return <Box flexDirection="column">
    <Text bold color={colors.warm}>{profile.name} <Text color={colors.muted}>/ {profile.id}</Text></Text>
    {rows.map(([label, value]) => <Box key={label}>
      <Box width={11} flexShrink={0}><Text color={colors.muted}>{label}</Text></Box>
      <Box flexGrow={1} minWidth={0}><Text wrap="truncate">{value}</Text></Box>
    </Box>)}
  </Box>;
}

// 纵向环境列表 + 下方摘要；每行带服务器和目录简写，↑↓ 选择。
export function App({ initialConfig, initialId }: { initialConfig: Config; initialId?: string }) {
  const { exit } = useApp();
  const { stdout: output } = useStdout();
  const stdout = output as WriteStream;
  const [size, setSize] = useState({ columns: stdout.columns || 110, rows: stdout.rows || 32 });
  const [config, setConfig] = useState(initialConfig);
  const [index, setIndex] = useState(Math.max(0, initialConfig.profiles.findIndex(profile => profile.id === initialId)));
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [project, setProject] = useState("读取中…");
  const [command, setCommand] = useState(false);
  const [job, setJob] = useState<Job>();
  const [gitPrompt, setGitPrompt] = useState<ProjectState>();
  const [warningOffset, setWarningOffset] = useState(0);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [seed, setSeed] = useState<Profile>();
  const controller = useRef<AbortController | undefined>(undefined);
  const confirmGit = useRef<((value: boolean) => void) | undefined>(undefined);
  const profile = config.profiles[index];

  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 110, rows: stdout.rows || 32 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); controller.current?.abort(); confirmGit.current?.(false); };
  }, [stdout]);
  useEffect(() => {
    if (!profile || screen === "settings") return;
    const abort = new AbortController();
    setProject("读取中…");
    inspectProject(profile, abort.signal).then(state => {
      if (!abort.signal.aborted) setProject(`${state.branch || "无分支"} · ${state.commit.slice(0, 8) || "无提交"}${state.changes ? " · 有未提交修改" : ""}`);
    }).catch(error => { if (!abort.signal.aborted) setProject(message(error)); });
    return () => abort.abort();
  }, [profile, screen]);

  // 复制配置时解除映射锁：新环境通常要改目标，映射锁会挡住编辑。
  function openSettings(isNew: boolean, source?: Profile) {
    setSeed(source ? { ...source, id: "", name: `${source.name} 副本`, lockMapping: false, mapping: undefined } : undefined);
    setCreating(isNew); setScreen("settings"); setNotice("");
  }
  async function persist(next: Config) { await saveConfig(next); setConfig(next); }
  function answerGit(value: boolean) { confirmGit.current?.(value); confirmGit.current = undefined; setGitPrompt(undefined); }

  function startJob(connectionOnly: boolean) {
    if (!profile) return;
    const abort = new AbortController();
    controller.current = abort;
    setJob({ title: connectionOnly ? "检查服务器" : "发布目录", step: 0, logs: "", status: "running", started: Date.now() });
    setNotice(""); setScreen("job");
    const append = (text: string) => setJob(current => current && ({ ...current, logs: (current.logs + text).slice(-60_000) }));
    const task = connectionOnly ? checkServer(profile, abort.signal).then(text => append(`${text}\n`))
      : deploy(profile, event => {
        if (event.type === "step") setJob(current => current && ({ ...current, step: event.index! }));
        else append(event.text);
      }, abort.signal, state => new Promise<boolean>(resolve => {
        setGitPrompt(state);
        setWarningOffset(0);
        const cancel = () => answerGit(false);
        confirmGit.current = value => { abort.signal.removeEventListener("abort", cancel); resolve(value); };
        abort.signal.addEventListener("abort", cancel, { once: true });
        if (abort.signal.aborted) cancel();
      }));
    void task.then(() => setJob(current => current && ({ ...current, status: "success", elapsed: Date.now() - current.started })))
      .catch(error => { append(`\n${message(error)}\n`); setJob(current => current && ({ ...current, status: "error", elapsed: Date.now() - current.started })); });
  }

  function execute(value: string) {
    setCommand(false); setNotice("");
    const action = value.trim().replace(/^\//, "");
    if (action === "new") openSettings(true);
    else if (action === "quit") exit();
    else if (action === "environments") setScreen("dashboard");
    else if (!profile) setNotice("请先新建或选择发布配置");
    else if (action === "config") openSettings(false);
    else if (action === "copy") openSettings(true, profile);
    else if (action === "deploy") setScreen("confirm");
    else if (action === "check") startJob(true);
    else setNotice("可用命令：/new /config /deploy /check /environments /quit");
  }
  const summaryLines = 11; // Summary 标题 + 10 行
  const previewHeight = Math.max(4, size.rows - (screen === "dashboard" ? 7 : 12));
  const previewMaxOffset = Math.max(0, summaryLines - previewHeight);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (screen === "job" && job?.status === "running") controller.current?.abort();
      else exit();
      return;
    }
    if (screen === "settings") return;
    if (gitPrompt && (key.pageDown || key.pageUp)) {
      const maximum = Math.max(0, gitPrompt.warnings.join("\n\n").split("\n").length - Math.max(3, size.rows - 15));
      setWarningOffset(current => Math.max(0, Math.min(maximum, current + (key.pageDown ? 5 : -5))));
    }
    if ((key.pageDown || key.pageUp) && (screen === "dashboard" || screen === "confirm" || screen === "delete")) {
      setPreviewOffset(current => Math.max(0, Math.min(previewMaxOffset, current + (key.pageDown ? 4 : -4))));
    }
    if (command) { if (key.escape) setCommand(false); return; }
    if (key.escape) {
      if (gitPrompt) answerGit(false);
      else if (screen === "job" && job?.status === "running") controller.current?.abort();
      else { setScreen("dashboard"); setNotice(""); }
      return;
    }
    if (screen !== "dashboard") return;
    if (input === "/") { setCommand(true); return; }
    if (input === "n") { openSettings(true); return; }
    if (key.upArrow) { setIndex(Math.max(0, index - 1)); setPreviewOffset(0); }
    if (key.downArrow) { setIndex(Math.min(config.profiles.length - 1, index + 1)); setPreviewOffset(0); }
    if (!profile) return;
    if (input === "e") openSettings(false);
    else if (input === "c") startJob(true);
    else if (input === "x") setScreen("delete");
    else if (input === "d") openSettings(true, profile);
    else if (key.return) setScreen("confirm");
  });

  return <ThemeProvider theme={theme}><Box flexDirection="column" paddingX={1} width={size.columns}>
    <Box justifyContent="space-between">
      <Text bold color={colors.accent}>{(screen === "confirm" || screen === "delete" || screen === "job") && profile ? profile.name : "code-deploy"}</Text>
      <Text color={colors.muted}>v0.2</Text>
    </Box>
    {screen !== "settings" && screen !== "job" && <Box marginTop={1}>
      {screen === "dashboard" && <Box flexDirection="column" width={48} flexShrink={0} paddingRight={1}>
        {config.profiles.map((item, offset) => <Box key={item.id}>
          <Box width={2} flexShrink={0}><Text color={offset === index ? colors.accent : undefined}>{offset === index ? "›" : ""}</Text></Box>
          <Box width={14} flexShrink={0}><Text bold={offset === index} color={offset === index ? colors.accent : undefined} wrap="truncate">{item.name}</Text></Box>
          <Box flexGrow={1} minWidth={0}><Text color={colors.muted} wrap="truncate">{item.user}@{item.host} {dirList(item.remoteDirs)}</Text></Box>
        </Box>)}
        {!config.profiles.length && <Text color={colors.muted}>暂无配置 · 按 n 新建</Text>}
      </Box>}
      <Box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={2} borderStyle={screen === "dashboard" ? "single" : undefined} borderTop={false} borderBottom={false} borderRight={false} borderColor={colors.muted}>
        {profile && <>
          <Box height={previewHeight} overflow="hidden" flexDirection="column">
            <Box marginTop={-previewOffset} flexDirection="column"><Summary profile={profile} project={project} /></Box>
          </Box>
          {previewMaxOffset > 0 && <Text color={colors.muted}>PgUp / PgDn 滚动预览 {previewOffset > 0 ? "↑" : ""}{previewOffset < previewMaxOffset ? "↓" : ""}</Text>}
        </>}
        {screen === "dashboard" && !profile && <Box flexDirection="column" gap={1}>
          <Text bold>配置一次，选择发布</Text>
          <Text>填写本地源目录、服务器和远程目录，按需开启锁定规则。</Text>
          <Text color={colors.accent}>按 n 新建，或输入 /new。</Text>
        </Box>}
        {screen === "confirm" && <>
          <Text color={colors.warm}>发布前将检查锁定规则和 Git 状态，再替换远程目录 B。</Text>
          {profile.remoteDirs.map(dir => <Text key={dir} wrap="truncate">B: {profile.user}@{profile.host}:{profile.port}{dir}</Text>)}
          <Text>确认发布？ [y/N]</Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={() => startJob(false)} onCancel={() => setScreen("dashboard")} />
        </>}
        {screen === "delete" && profile && <>
          <Text color={colors.warm}>删除配置及关联密码？服务器文件不变。[y/N]</Text>
          <ConfirmInput defaultChoice="cancel" onCancel={() => setScreen("dashboard")} onConfirm={() => {
            void (async () => {
              await deletePassword(profile); await persist({ version: 1, profiles: config.profiles.filter(item => item.id !== profile.id) });
              setIndex(Math.max(0, index - 1)); setScreen("dashboard");
            })().catch(error => setNotice(message(error)));
          }} />
        </>}
      </Box>
    </Box>}
    {screen === "settings" && <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Settings key={creating ? `new-${seed?.name || "blank"}` : profile?.id} config={config} profile={creating ? undefined : profile} initial={creating ? seed : undefined} onCancel={() => { setSeed(undefined); setScreen("dashboard"); }} onSave={async next => {
        const profiles = creating ? [...config.profiles, next] : config.profiles.map(item => item.id === next.id ? next : item);
        await persist({ version: 1, profiles });
        setIndex(profiles.findIndex(item => item.id === next.id)); setSeed(undefined); setScreen("dashboard"); setNotice("配置已保存");
      }} />
    </Box>}
    {screen === "job" && job && <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Text bold color={colors.warm}>{job.title}</Text>
      {gitPrompt ? <Box flexDirection="column" gap={1}>
        <Text color={colors.warm}>Git 状态需要确认，尚未执行构建或上传</Text>
        <Text>{gitPrompt.directory} · {gitPrompt.branch || "无分支"}</Text>
        <Box height={Math.max(3, size.rows - 15)} overflow="hidden"><Text>{gitPrompt.warnings.join("\n\n").split("\n").slice(warningOffset, warningOffset + Math.max(3, size.rows - 15)).join("\n")}</Text></Box>
        <Text color={colors.muted}>PgUp / PgDn 滚动查看 Git 提醒</Text>
        <Text>仍要使用当前本地内容发布？ [y/N]</Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={() => answerGit(true)} onCancel={() => answerGit(false)} />
      </Box> : <>
        <Box gap={2} flexWrap="wrap">{steps.map((label, step) => {
          const done = job.status === "success" || step < job.step;
          const failed = job.status === "error" && step === job.step;
          const active = job.status === "running" && step === job.step;
          return <Box key={label} gap={1}>
            {done ? <Text color={colors.good}>✓</Text> : failed ? <Text color={colors.error}>✗</Text> : active ? <Spinner /> : <Text color={colors.muted}>·</Text>}
            <Text color={done ? colors.good : failed ? colors.error : active ? colors.accent : colors.muted}>{label}</Text>
          </Box>;
        })}</Box>
        <Box flexDirection="column" height={Math.max(5, size.rows - 12)} overflow="hidden" marginY={1}>
          <Text wrap="truncate">{job.logs.split("\n").slice(-Math.max(3, size.rows - 14)).join("\n") || "正在检查…"}</Text>
        </Box>
        {job.status === "running" ? <Spinner label="执行中 · Ctrl+C 取消" /> : <>
          <Text color={job.status === "success" ? colors.good : colors.error}>{job.status === "success" ? `✓ 执行完成 · 用时 ${formatDuration(job.elapsed ?? 0)}` : `执行失败 / 已取消 · 用时 ${formatDuration(job.elapsed ?? 0)}`}</Text>
          <Text color={colors.accent}>按 Esc 返回</Text>
        </>}
      </>}
    </Box>}
    {notice && <Text color={colors.warm}>{notice}</Text>}
    <Box flexDirection="column" marginTop={1}>
      {command && <Box><Text color={colors.accent}>/ </Text><TextInput placeholder="new · config · deploy · check · environments · quit" onSubmit={execute} /></Box>}
      {(screen === "dashboard" || screen === "confirm" || screen === "delete") && <Text color={colors.muted} wrap="truncate">↑↓ 选择 · Enter 发布 · e 编辑 · c 检查 · x 删除 · d 复制 · n 新建 · / 命令</Text>}
      <Text color={colors.muted} wrap="truncate">{configFile}</Text>
    </Box>
  </Box></ThemeProvider>;
}
