import { useEffect, useRef, useState } from "react";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { TextInput } from "@inkjs/ui";
import { configFile, saveConfig, type Config, type Profile } from "./config.js";
import { deletePassword } from "./credentials.js";
import { checkServer, deploy } from "./deploy.js";
import { inspectProject, type ProjectState } from "./preflight.js";
import { Settings } from "./settings.js";
import { truncate } from "./text.js";
import { KeyHints, Rule, colors } from "./ui.js";
import { ConfirmPanel, Dashboard, DeletePanel, GitPrompt, JobView, type Job, type ProjectInfo } from "./views.js";

// 发布后 package.json 与 dist 同级，开发时与 src 同级，两处相对路径一致。
const version: string = createRequire(import.meta.url)("../package.json").version;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const configPath = configFile.startsWith(homedir()) ? `~${configFile.slice(homedir().length)}` : configFile;
type Screen = "dashboard" | "settings" | "confirm" | "delete" | "job";
type Notice = { text: string; tone: "good" | "warm" | "error" };

// 全屏布局：顶栏 / 主体 / 底栏。主体高度由此精确分配给各视图，窗口再小也不会把内容挤出屏幕。
export function App({ initialConfig, initialId }: { initialConfig: Config; initialId?: string }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [config, setConfig] = useState(initialConfig);
  const [index, setIndex] = useState(Math.max(0, initialConfig.profiles.findIndex(profile => profile.id === initialId)));
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [project, setProject] = useState<ProjectInfo>({ text: "读取中…", tone: "muted" });
  const [command, setCommand] = useState(false);
  const [job, setJob] = useState<Job>();
  const [gitPrompt, setGitPrompt] = useState<ProjectState>();
  const [seed, setSeed] = useState<Profile>();
  const controller = useRef<AbortController | undefined>(undefined);
  const inspected = useRef("");
  const confirmGit = useRef<((value: boolean) => void) | undefined>(undefined);
  const profile = config.profiles[index];
  const width = columns - 2;
  const bodyHeight = Math.max(1, rows - 3 - (command ? 1 : 0));

  useEffect(() => () => { controller.current?.abort(); confirmGit.current?.(false); }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!profile || screen === "settings") return;
    const abort = new AbortController();
    // 同一环境重新读取时保留旧结果，避免界面闪回“读取中”。
    if (inspected.current !== profile.id) setProject({ text: "读取中…", tone: "muted" });
    inspected.current = profile.id;
    inspectProject(profile, abort.signal).then(state => {
      if (abort.signal.aborted) return;
      setProject({ text: `${state.branch || "无分支"} · ${state.commit.slice(0, 8) || "无提交"}${state.changes ? " · 有未提交修改" : ""}`, tone: state.changes ? "warm" : "good" });
    }).catch(error => { if (!abort.signal.aborted) setProject({ text: message(error), tone: "error" }); });
    return () => abort.abort();
  }, [profile, screen]);

  const notify = (text: string, tone: Notice["tone"] = "warm") => setNotice({ text, tone });
  // 复制配置时解除映射锁：新环境通常要改目标，映射锁会挡住编辑。
  function openSettings(isNew: boolean, source?: Profile) {
    setSeed(source ? { ...source, id: "", name: `${source.name} 副本`, lockMapping: false, mapping: undefined } : undefined);
    setCreating(isNew); setScreen("settings"); setNotice(undefined);
  }
  async function persist(next: Config) { await saveConfig(next); setConfig(next); }
  function answerGit(value: boolean) { confirmGit.current?.(value); confirmGit.current = undefined; setGitPrompt(undefined); }

  function startJob(connectionOnly: boolean) {
    if (!profile) return;
    const abort = new AbortController();
    controller.current = abort;
    const started = Date.now();
    setJob({ kind: connectionOnly ? "check" : "deploy", title: connectionOnly ? "检查服务器" : "发布目录", step: 0, stepAt: [started], logs: "", status: "running", started });
    setNotice(undefined); setScreen("job");
    let declined = false; // 在 Git 确认处主动拒绝，按“已取消”而非“失败”展示
    const append = (text: string) => setJob(current => current && ({ ...current, logs: (current.logs + text).slice(-60_000) }));
    const finish = (status: Job["status"], error?: string) => setJob(current => current && ({ ...current, status, error, elapsed: Date.now() - current.started }));
    const task = connectionOnly ? checkServer(profile, abort.signal).then(text => append(`${text}\n`))
      : deploy(profile, event => {
        if (event.type === "log") { append(event.text); return; }
        // 每个阶段在输出里留一行标记，滚动回看时容易分段。
        setJob(current => {
          if (!current) return current;
          const stepAt = [...current.stepAt]; stepAt[event.index!] = Date.now();
          const gap = current.logs && !current.logs.endsWith("\n") ? "\n" : "";
          return { ...current, step: event.index!, stepAt, logs: `${current.logs}${gap}▸ ${event.text}\n` };
        });
      }, abort.signal, state => new Promise<boolean>(resolve => {
        setGitPrompt(state);
        const cancel = () => answerGit(false);
        confirmGit.current = value => { declined ||= !value; abort.signal.removeEventListener("abort", cancel); resolve(value); };
        abort.signal.addEventListener("abort", cancel, { once: true });
        if (abort.signal.aborted) cancel();
      }));
    void task.then(() => finish("success"))
      .catch(error => { append(`\n${message(error)}\n`); finish(abort.signal.aborted || declined ? "cancelled" : "error", message(error)); });
  }

  function execute(value: string) {
    setCommand(false); setNotice(undefined);
    const action = value.trim().replace(/^\//, "");
    if (action === "new") openSettings(true);
    else if (action === "quit") exit();
    else if (action === "environments") setScreen("dashboard");
    else if (!profile) notify("请先新建或选择发布配置");
    else if (action === "config") openSettings(false);
    else if (action === "copy") openSettings(true, profile);
    else if (action === "deploy") setScreen("confirm");
    else if (action === "check") startJob(true);
    else notify("可用命令：/new /config /deploy /check /environments /quit");
  }

  async function removeProfile(target: Profile) {
    await deletePassword(target);
    await persist({ version: 1, profiles: config.profiles.filter(item => item.id !== target.id) });
    setIndex(Math.max(0, index - 1)); setScreen("dashboard"); notify("配置已删除", "good");
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (screen === "job" && job?.status === "running") controller.current?.abort();
      else exit();
      return;
    }
    if (screen === "settings") return;
    // Ctrl 组合键留给滚动等专用处理（如 Ctrl+D 翻页），不触发单字母快捷键。
    if (key.ctrl) return;
    if (command) { if (key.escape) setCommand(false); return; }
    if (key.escape) {
      if (gitPrompt) answerGit(false);
      else if (screen === "job" && job?.status === "running") controller.current?.abort();
      else { setScreen("dashboard"); setNotice(undefined); }
      return;
    }
    if (screen === "job" && job && job.status !== "running" && !gitPrompt) {
      if (key.return) setScreen("dashboard");
      else if (input === "r" && job.status !== "success") startJob(job.kind === "check");
      return;
    }
    if (screen !== "dashboard") return;
    if (input === "/") { setCommand(true); return; }
    if (input === "n") { openSettings(true); return; }
    if (input === "q") { exit(); return; }
    if (key.upArrow || input === "k") setIndex(Math.max(0, index - 1));
    if (key.downArrow || input === "j") setIndex(Math.min(config.profiles.length - 1, index + 1));
    if (!profile) return;
    if (input === "e") openSettings(false);
    else if (input === "c") startJob(true);
    else if (input === "x") setScreen("delete");
    else if (input === "d") openSettings(true, profile);
    else if (key.return) setScreen("confirm");
  });

  const crumbs: string[] = screen === "settings" ? [creating ? "新建配置" : `${profile?.name ?? ""} · 编辑`]
    : screen === "confirm" ? [profile?.name ?? "", "发布"] : screen === "delete" ? [profile?.name ?? "", "删除"]
      : screen === "job" && job ? [profile?.name ?? "", job.title] : [];
  const hints: [string, string][] = screen === "dashboard"
    ? profile ? [["↑↓", "选择"], ["Enter", "发布"], ["e", "编辑"], ["c", "检查"], ["d", "复制"], ["x", "删除"], ["n", "新建"], ["/", "命令"], ...(width >= 78 ? [["PgUp/PgDn · Ctrl+U/D", "详情滚动"] as [string, string]] : []), ["q", "退出"]]
      : [["n", "新建"], ["/", "命令"], ["q", "退出"]]
    : screen === "confirm" || screen === "delete" ? [["y", "确认"], ["n", "取消"], ["←→", "切换"], ["↑↓", "滚动"], ["Esc", "返回"]]
      : screen === "job" && job ? gitPrompt ? [["y", "继续发布"], ["n", "取消"], ["↑↓ · Ctrl+U/D", "滚动提醒"], ["Esc", "取消"]]
        : job.status === "running" ? [["↑↓", "滚动"], ["PgUp/PgDn · Ctrl+U/D", "翻页"], ["G", "跟随"], ["Ctrl+C", "取消"]]
          : [["Esc", "返回"], ...(job.status === "success" ? [] : [["r", "重试"] as [string, string]]), ["↑↓", "滚动"], ["PgUp/PgDn · Ctrl+U/D", "翻页"], ["g/G", "首尾"]]
        : [];
  const showPath = width >= 100;

  if (columns < 40 || rows < 8) return <Box flexDirection="column" paddingX={1}>
    <Text color={colors.warm}>终端窗口太小</Text>
    <Text color={colors.muted}>请放大到至少 40 × 8，当前 {columns} × {rows}</Text>
  </Box>;

  return <Box flexDirection="column" paddingX={1} width={columns} height={rows}>
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={colors.accent}>◆ code-deploy</Text>
        {crumbs.map((crumb, offset) => <Text key={offset}><Text color={colors.line}>  ›  </Text><Text bold={offset === crumbs.length - 1} color={offset === crumbs.length - 1 ? colors.warm : colors.muted}>{crumb}</Text></Text>)}
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        {notice ? <Text color={colors[notice.tone]}>{truncate(notice.text, Math.floor(width * 0.55))}</Text> : <Text color={colors.muted}>v{version}</Text>}
      </Box>
    </Box>
    <Rule width={width} />
    <Box flexDirection="column" height={bodyHeight} overflow="hidden">
      {screen === "settings"
        ? <Settings key={creating ? `new-${seed?.name || "blank"}` : profile?.id} config={config} profile={creating ? undefined : profile} initial={creating ? seed : undefined} width={width} height={bodyHeight}
          onCancel={() => { setSeed(undefined); setScreen("dashboard"); }} onSave={async next => {
            const profiles = creating ? [...config.profiles, next] : config.profiles.map(item => item.id === next.id ? next : item);
            await persist({ version: 1, profiles });
            setIndex(profiles.findIndex(item => item.id === next.id)); setSeed(undefined); setScreen("dashboard"); notify("配置已保存", "good");
          }} />
        : screen === "job" && job
          ? gitPrompt ? <GitPrompt state={gitPrompt} width={width} height={bodyHeight} onAnswer={answerGit} />
            : <JobView job={job} width={width} height={bodyHeight} />
          : screen === "confirm" && profile
            ? <ConfirmPanel profile={profile} project={project} here={process.cwd()} width={width} height={bodyHeight} onConfirm={() => startJob(false)} onCancel={() => setScreen("dashboard")} />
            : screen === "delete" && profile
              ? <DeletePanel profile={profile} width={width} onCancel={() => setScreen("dashboard")} onConfirm={() => { void removeProfile(profile).catch(error => notify(message(error), "error")); }} />
              : <Dashboard profiles={config.profiles} index={index} project={project} here={process.cwd()} width={width} height={bodyHeight} />}
    </Box>
    {command && <Box><Text color={colors.accent} bold>❯ /</Text><TextInput placeholder="new · config · copy · deploy · check · environments · quit" onSubmit={execute} /></Box>}
    <Box justifyContent="space-between">
      <Box flexShrink={1} minWidth={0}><KeyHints items={hints} width={showPath ? width - configPath.length - 3 : width} /></Box>
      {showPath && <Box flexShrink={0} marginLeft={2}><Text color={colors.line}>{configPath}</Text></Box>}
    </Box>
  </Box>;
}
