import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, newProfile, saveConfig, type Profile } from "../src/config.js";
import { captureMapping, GitConfirmationRequired, inspectProject, prepareRelease } from "../src/preflight.js";
import { run } from "../src/process.js";
import { deploy } from "../src/deploy.js";

// 所有 Git 操作只访问临时目录和本地 bare 仓库。
async function fixture(task: (directory: string, profile: Profile) => Promise<void>) {
  const temporary = await mkdtemp(path.join(tmpdir(), "deploy-preflight-"));
  const cwd = process.cwd();
  const directory = await realpath(temporary);
  try {
    process.chdir(directory);
    const profile = { ...newProfile(), id: "demo", name: "Demo", host: "example.test", user: "deploy", remoteDirs: ["/srv/app"] };
    await task(directory, profile);
  } finally { process.chdir(cwd); await rm(temporary, { recursive: true, force: true }); }
}
const git = (args: string[], cwd = process.cwd()) => run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });
const init = async () => { await git(["init", "-b", "main"]); await git(["commit", "--allow-empty", "-m", "initial"]); };

test("通用默认配置、非 Git 目录与旧配置迁移", async () => fixture(async (directory, profile) => {
  assert.equal(profile.checkGit, true);
  assert.equal(profile.lockDirectory, false);
  assert.equal(profile.lockBranch, false);
  assert.equal(profile.lockMapping, false);
  assert.equal(profile.buildCommand, "");
  const state = await inspectProject(profile);
  assert.match(state.warnings.join(), /不属于 Git/);
  await assert.rejects(prepareRelease(profile), GitConfirmationRequired);
  assert.equal((await prepareRelease({ ...profile, checkGit: false })).warnings.length, 0);
  const file = path.join(directory, "legacy.json");
  const { lockBranch, lockDirectory, lockMapping, checkGit, remoteDirs, ...legacy } = profile;
  await writeFile(file, JSON.stringify({ version: 1, profiles: [{ ...legacy, remoteDir: "/srv/app", expectedBranch: "release" }] }));
  const migrated = (await loadConfig(file)).profiles[0]!;
  assert.deepEqual(migrated.remoteDirs, ["/srv/app"]); // 旧配置的单个远程目录迁移为列表
  assert.equal(migrated.lockDirectory, true);
  assert.equal(migrated.lockBranch, true);
  assert.equal(migrated.lockMapping, false);
  assert.equal(migrated.checkGit, true);
  // 旧映射锁默认解除，保留目录和分支约束，允许迁移后添加目标目录。
  for (const lockMapping of [true, false]) {
    await writeFile(file, JSON.stringify({ version: 1, profiles: [{ ...legacy, remoteDir: "/srv/app", expectedBranch: "release", lockMapping, mapping: {
      projectDir: directory, branch: "main", host: profile.host, user: profile.user, port: profile.port, remoteDir: "/srv/app"
    } }] }));
    const mapped = (await loadConfig(file)).profiles[0]!;
    assert.deepEqual(mapped.remoteDirs, ["/srv/app"]);
    assert.equal(mapped.mapping, undefined);
    assert.equal(mapped.lockMapping, false);
    assert.equal(mapped.lockDirectory, true);
    assert.equal(mapped.lockBranch, true);
    const expanded = { ...mapped, remoteDirs: [...mapped.remoteDirs, "/srv/other"] };
    await saveConfig({ version: 1, profiles: [expanded] }, file);
    const reloaded = (await loadConfig(file)).profiles[0]!;
    assert.deepEqual(reloaded.remoteDirs, expanded.remoteDirs);
    assert.equal(reloaded.lockMapping, false);
    assert.equal(reloaded.mapping, undefined);
  }
  // 已填写多目录但仍携带旧快照时，也不能被旧映射锁挡住启动和编辑。
  const expandedDirs = ["/srv/app", "/srv/other"];
  await writeFile(file, JSON.stringify({ version: 1, profiles: [{ ...profile, remoteDirs: expandedDirs, lockMapping: true, mapping: {
    projectDir: directory, branch: "main", host: profile.host, user: profile.user, port: profile.port, remoteDir: "/srv/old"
  } }] }));
  const partial = (await loadConfig(file)).profiles[0]!;
  assert.equal(partial.lockMapping, false);
  assert.equal(partial.mapping, undefined);
  assert.deepEqual(partial.remoteDirs, expandedDirs);
}));

test("目录锁、分支锁和映射锁独立生效；其他配置不能破坏一一映射", async () => fixture(async (directory, profile) => {
  await init();
  const unlocked = { ...profile, projectDir: "/not-used/when-unlocked", expectedBranch: "release", checkGit: false };
  assert.equal((await inspectProject(unlocked)).directory, directory);
  await assert.rejects(inspectProject({ ...profile, lockBranch: true, expectedBranch: "release" }), /分支不匹配/);
  await mkdir("child");
  await assert.rejects(inspectProject({ ...profile, lockDirectory: true }, undefined, false, path.join(directory, "child")), /本地目录已锁定/);
  const locked = await captureMapping(profile);
  assert.equal(locked.lockDirectory, false);
  assert.equal(locked.mapping!.branch, "main");
  // 配置阶段不执行分支锁，只抓取现状；分支判定留到发布时
  const mismatched = await captureMapping({ ...profile, lockBranch: true, expectedBranch: "other" });
  assert.equal(mismatched.mapping!.branch, "main");
  assert.equal((await inspectProject(locked)).directory, directory);
  await assert.rejects(inspectProject({ ...locked, remoteDirs: ["/srv/other"] }), /映射不匹配/);
  await assert.rejects(inspectProject({ ...locked, host: "other.test" }), /映射不匹配/);
  await git(["switch", "-c", "feature"]);
  // 同目录换任务分支不破坏映射；分支正误由分支锁单独约束
  assert.equal((await inspectProject(locked)).branch, "feature");
  await assert.rejects(inspectProject({ ...locked, lockBranch: true, expectedBranch: "main" }), /分支不匹配/);
  await git(["switch", "main"]);
  const file = path.join(directory, "config.json");
  await saveConfig({ version: 1, profiles: [locked] }, file);
  assert.deepEqual((await loadConfig(file)).profiles[0], locked); // 新版有效映射锁保持开启
  await assert.rejects(saveConfig({ version: 1, profiles: [locked, { ...locked, id: "conflict", remoteDirs: ["/srv/other"], mapping: { ...locked.mapping!, remoteDirs: ["/srv/other"] } }] }, file), /一一对应/);
  await assert.rejects(saveConfig({ version: 1, profiles: [{ ...locked, remoteDirs: ["/srv/other"] }] }, file), /不一致/);
  const first = { ...locked, remoteDirs: ["/srv/app", "/srv/other"], mapping: { ...locked.mapping!, remoteDirs: ["/srv/app", "/srv/other"] } };
  for (const remoteDirs of [["/srv/app/"], ["/srv/app/child"]]) {
    const second = { ...locked, id: "second", projectDir: path.join(directory, "second"), remoteDirs,
      mapping: { ...locked.mapping!, projectDir: path.join(directory, "second"), remoteDirs } };
    await assert.rejects(saveConfig({ version: 1, profiles: [first, second] }, file), /一一对应/);
  }
  const separate = { ...locked, id: "separate", projectDir: path.join(directory, "separate"), remoteDirs: ["/srv/app2"],
    mapping: { ...locked.mapping!, projectDir: path.join(directory, "separate"), remoteDirs: ["/srv/app2"] } };
  await saveConfig({ version: 1, profiles: [first, separate] }, file);
}));

test("未提交、暂存、未跟踪状态提醒；确认前不继续，取消即终止", async () => fixture(async (_directory, profile) => {
  await init();
  await writeFile("tracked.txt", "initial");
  await git(["add", "tracked.txt"]); await git(["commit", "-m", "tracked"]);
  await writeFile("tracked.txt", "modified");
  await writeFile("new.txt", "untracked");
  await writeFile("staged.txt", "staged"); await git(["add", "staged.txt"]);
  const state = await inspectProject(profile);
  assert.match(state.changes, /M tracked.txt/);
  assert.match(state.changes, /A  staged.txt/);
  assert.match(state.changes, /\?\? new.txt/);
  await assert.rejects(prepareRelease(profile), /Git 状态需要确认/);
  let calls = 0;
  await assert.rejects(prepareRelease(profile, undefined, async () => { calls++; return false; }), /已取消发布/);
  assert.equal(calls, 1);
  await prepareRelease(profile, undefined, async () => { calls++; return true; });
  assert.equal(calls, 2);
  // 异常 Git 状态必须在构建前等待确认，取消不得执行构建命令。
  let releaseConfirmation: ((value: boolean) => void) | undefined;
  const release = deploy({ ...profile, buildCommand: "touch should-not-build" }, () => {}, undefined,
    () => new Promise<boolean>(resolve => { releaseConfirmation = resolve; }));
  while (!releaseConfirmation) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(readFile("should-not-build"));
  releaseConfirmation(false);
  await assert.rejects(release, /已取消发布/);
  let confirmations = 0;
  await prepareRelease(profile, undefined, async () => {
    confirmations++;
    if (confirmations === 1) await writeFile("another.txt", "changed while waiting");
    return true;
  });
  assert.equal(confirmations, 2);
}));

test("fetch 后发现未拉取提交；未推送、无上游和 fetch 失败均需确认", async () => fixture(async (directory, profile) => {
  const remote = path.join(directory, "remote.git");
  const source = path.join(directory, "source");
  const clone = path.join(directory, "clone");
  await git(["init", "--bare", "-b", "main", remote]);
  await mkdir(source); process.chdir(source); await init();
  await git(["remote", "add", "origin", remote]); await git(["push", "-u", "origin", "main"]);
  await git(["clone", remote, clone]); process.chdir(clone);
  const localProfile = { ...profile, projectDir: clone };
  assert.equal((await inspectProject(localProfile, undefined, true)).warnings.length, 0);
  await git(["commit", "--allow-empty", "-m", "upstream"], source);
  await git(["push"], source);
  assert.equal((await inspectProject(localProfile)).behind, 0);
  const behind = await inspectProject(localProfile, undefined, true);
  assert.equal(behind.behind, 1);
  assert.match(behind.warnings.join(), /未拉取/);
  await assert.rejects(prepareRelease(localProfile), GitConfirmationRequired);
  await prepareRelease(localProfile, undefined, async state => state.behind === 1);
  await git(["merge", "--ff-only", "@{upstream}"]);
  await git(["commit", "--allow-empty", "-m", "local"]);
  assert.equal((await inspectProject(localProfile)).ahead, 1);
  await git(["remote", "set-url", "origin", path.join(directory, "missing.git")]);
  assert.match((await inspectProject(localProfile, undefined, true)).warnings.join(), /刷新远程分支失败/);
  let failureConfirmed = false;
  await prepareRelease(localProfile, undefined, async state => { failureConfirmed = state.warnings.some(warning => warning.includes("刷新远程分支失败")); return true; });
  assert.equal(failureConfirmed, true);
  await git(["branch", "--unset-upstream"]);
  assert.match((await inspectProject(localProfile)).warnings.join(), /没有可用的上游/);
  assert.equal(await readFile(path.join(clone, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
}));
