import { realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { profileSchema, targetKey, type Profile } from "./config.js";
import { run } from "./process.js";

export type ProjectState = {
  directory: string; branch: string; commit: string; changes: string;
  upstream: string; ahead: number; behind: number; warnings: string[]; fingerprint: string;
};

// 当前目录就是实际源目录；目录锁不会偷偷切换到另一个工作区。
export async function inspectProject(profile: Profile, signal?: AbortSignal, refresh = false, cwd = process.cwd()): Promise<ProjectState> {
  profileSchema.parse(profile);
  const directory = await realpath(cwd);
  if (!(await stat(directory)).isDirectory()) throw new Error("源目录不是目录");
  if (profile.lockDirectory || profile.lockMapping) {
    const expected = await realpath(profile.projectDir);
    if (directory !== expected) throw new Error(`本地目录已锁定，请在 ${expected} 运行；当前 ${directory}`);
  }
  const state: ProjectState = { directory, branch: "", commit: "", changes: "", upstream: "", ahead: 0, behind: 0, warnings: [], fingerprint: "" };
  const git = (args: string[]) => run("git", args, { cwd: directory, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  let isGit = false;
  try { isGit = await git(["rev-parse", "--is-inside-work-tree"]) === "true"; }
  catch (error) { if (signal?.aborted) throw error; }
  if (!isGit) {
    if (profile.lockBranch || profile.lockMapping) throw new Error("分支锁或映射锁要求源目录属于 Git 工作区");
    if (profile.checkGit) state.warnings.push("源目录不属于 Git 工作区，无法检查分支状态");
    return finish(state);
  }
  state.branch = await git(["branch", "--show-current"]);
  state.commit = await git(["rev-parse", "HEAD"]).catch(error => {
    if (signal?.aborted) throw error;
    return "";
  });
  enforceLocks(profile, state);
  state.changes = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!profile.checkGit) return finish(state);
  if (state.changes) state.warnings.push(`存在未提交改动（含暂存、未暂存或未跟踪文件）：\n${state.changes}`);
  if (!state.branch) state.warnings.push("当前处于 detached HEAD，未检出命名分支");
  try { state.upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]); }
  catch (error) {
    if (signal?.aborted) throw error;
    state.warnings.push("当前分支没有可用的上游跟踪分支，无法确认是否有未拉取提交");
    return finish(state);
  }
  if (refresh) {
    try {
      const remote = await git(["config", "--get", `branch.${state.branch}.remote`]);
      if (remote && remote !== ".") await git(["fetch", "--no-tags", "--", remote]);
    } catch (error) {
      if (signal?.aborted) throw error;
      state.warnings.push(`刷新远程分支失败，未拉取状态可能过期：\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const [ahead, behind] = (await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).split(/\s+/).map(Number);
  state.ahead = ahead!;
  state.behind = behind!;
  if (state.behind) state.warnings.push(`当前分支落后 ${state.upstream} ${state.behind} 个提交，存在未拉取代码`);
  if (state.ahead) state.warnings.push(`当前分支领先 ${state.upstream} ${state.ahead} 个提交，存在未推送代码`);
  return finish(state);
}

// 锁定规则属于硬约束，确认 Git 警告不能绕过。
function enforceLocks(profile: Profile, state: ProjectState) {
  if (profile.lockBranch && (!profile.expectedBranch || state.branch !== profile.expectedBranch)) {
    throw new Error(`分支不匹配：要求 ${profile.expectedBranch || "（未配置）"}，当前 ${state.branch || "detached HEAD"}`);
  }
  if (!profile.lockMapping) return;
  const mapping = profile.mapping;
  if (!mapping || state.directory !== mapping.projectDir || targetKey(profile) !== targetKey(mapping)) {
    throw new Error("锁定映射不匹配：本地目录、服务器及远程目录必须与保存的映射完全对应；请先解除映射锁再修改");
  }
}

// 指纹用于确认后复核，目录、提交或警告发生变化时重新等待确认。
function finish(state: ProjectState): ProjectState {
  state.fingerprint = createHash("sha256").update(JSON.stringify({
    directory: state.directory, branch: state.branch, commit: state.commit,
    changes: state.changes, upstream: state.upstream, ahead: state.ahead, behind: state.behind
  })).digest("hex");
  return state;
}

export async function captureMapping(profile: Profile, signal?: AbortSignal): Promise<Profile> {
  // 配置阶段只抓取现状，分支锁、映射锁的判定留到发布时。
  const state = await inspectProject({ ...profile, lockMapping: false, lockDirectory: true, lockBranch: false, checkGit: false }, signal);
  if (!state.branch) throw new Error("请先检出要锁定的发布分支");
  return { ...profile, projectDir: state.directory, lockMapping: true, mapping: {
    projectDir: state.directory, branch: state.branch, host: profile.host, user: profile.user,
    port: profile.port, remoteDirs: [...profile.remoteDirs]
  } };
}

export class GitConfirmationRequired extends Error {
  constructor(public state: ProjectState) {
    super(`Git 状态需要确认：\n${state.warnings.join("\n\n")}`);
    this.name = "GitConfirmationRequired";
  }
}

export type ConfirmGit = (state: ProjectState) => Promise<boolean>;

// TUI 和命令行共用确认入口，默认拒绝无交互的异常状态发布。
export async function prepareRelease(profile: Profile, signal?: AbortSignal, confirm?: ConfirmGit): Promise<ProjectState> {
  let state = await inspectProject(profile, signal, profile.checkGit);
  while (state.warnings.length) {
    if (!confirm) throw new GitConfirmationRequired(state);
    if (!await confirm(state)) throw new Error("已取消发布");
    const current = await inspectProject(profile, signal, false);
    if (current.fingerprint === state.fingerprint) return current;
    state = await inspectProject(profile, signal, profile.checkGit);
  }
  return state;
}
