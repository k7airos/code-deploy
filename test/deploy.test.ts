import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isSafeRemoteDir, loadConfig, profileSchema, saveConfig, newProfile, type Profile } from "../src/config.js";
import { deploy, formatRemoteOutput, quote, remoteDeployScript, run } from "../src/deploy.js";
import { resolvePassword } from "../src/credentials.js";

const profile: Profile = {
  ...newProfile(), checkGit: false, lockBranch: true, id: "test", name: "测试", projectDir: "/tmp/project", host: "example.test", user: "deploy", port: 22,
  remoteDir: "/data/web/test/dist", buildCommand: "mkdir -p dist && printf new > dist/index.html",
  outputDir: "dist", expectedBranch: "main", auth: "ssh", passwordEnv: "TEST_DEPLOY_PASSWORD"
};

// 远程脚本与 mock 依赖 POSIX 可执行文件：Windows 上 libuv 只补 .exe，命中不了无扩展名脚本。
const posixOnly = process.platform === "win32" ? "仅在 POSIX 环境运行：依赖 /bin/sh 与无扩展名可执行文件" : false;

test("内联密码字段优先于环境变量和钥匙串", async () => {
  const inline = profileSchema.parse({ ...newProfile(), id: "inline", name: "内联", host: "example.test", remoteDir: "/srv/app", auth: "env", passwordEnv: "NOPE", password: "inline-secret" });
  assert.equal(await resolvePassword(inline), "inline-secret");
  assert.equal(inline.password, "inline-secret"); // 保存/加载往返不丢失
});

test("配置校验、原子保存、文件权限和损坏文件保护", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-config-test-"));
  try {
    const file = path.join(temporary, "config.json");
    assert.deepEqual((await loadConfig(file)).profiles, []);
    await saveConfig({ version: 1, profiles: [profile] }, file);
    // Windows 的 chmod 只实现只读位，权限位无法直接断言。
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform === "win32") assert.equal(mode & 0o200, 0o200);
    else assert.equal(mode, 0o600);
    assert.deepEqual((await loadConfig(file)).profiles, [profile]);
    await assert.rejects(saveConfig({ version: 1, profiles: [profile, profile] }, file));
    assert.equal(profileSchema.safeParse({ ...profile, host: "-oProxyCommand=bad" }).success, false);
    assert.equal(profileSchema.safeParse({ ...profile, outputDir: "../dist" }).success, false);
    for (const directory of ["/", "/data", "/etc/app/dist", "/data/web/../dist", "/data/web/./dist"]) {
      assert.equal(isSafeRemoteDir(directory), false, directory);
    }
    assert.equal(isSafeRemoteDir("/data/web/project with space/dist"), true);
    await writeFile(file, "invalid");
    await assert.rejects(loadConfig(file), /读取配置失败/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("错误分支在构建前阻断", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-branch-test-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(temporary);
    await run("git", ["init", "-b", "feature"], { cwd: temporary });
    await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "test"], { cwd: temporary });
    await assert.rejects(deploy({ ...profile, projectDir: temporary, buildCommand: "touch should-not-exist" }, () => {}), /分支不匹配/);
    await assert.rejects(stat(path.join(temporary, "should-not-exist")));
    process.chdir(originalCwd);
  } finally { process.chdir(originalCwd); await rm(temporary, { recursive: true, force: true }); }
});

test("远程脚本在临时目录完成解压、备份，保护父目录，并处理失败恢复", { skip: posixOnly }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-switch-test-"));
  try {
    const parent = path.join(temporary, "server with ' quote");
    const target = path.join(parent, "dist");
    const output = path.join(temporary, "output");
    const archive = path.join(temporary, "archive.tar.gz");
    await mkdir(target, { recursive: true });
    await mkdir(output);
    await writeFile(path.join(parent, "backend.dll"), "keep");
    await writeFile(path.join(target, "index.html"), "old");
    await writeFile(path.join(output, "index.html"), "new");
    const pack = () => run("tar", ["-czf", archive, "-C", output, "."]);
    const remote = { ...profile, remoteDir: target };
    await pack();
    await run("/bin/sh", ["-c", remoteDeployScript(remote, archive, "first")]);
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    assert.equal(await readFile(path.join(parent, ".dist.backup-first/index.html"), "utf8"), "old");
    assert.equal(await readFile(path.join(parent, "backend.dll"), "utf8"), "keep");

    await writeFile(archive, "corrupt");
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(remote, archive, "corrupt")]));
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    await assert.rejects(stat(path.join(parent, ".dist.code-deploy-lock")));

    await pack();
    await mkdir(path.join(parent, ".dist.code-deploy-lock"));
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(remote, archive, "locked")]), /目标正在部署/);
    await rm(path.join(parent, ".dist.code-deploy-lock"), { recursive: true });

    // 仅让新版本移动失败，验证旧版本能恢复。
    const bin = path.join(temporary, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "mv"), '#!/bin/sh\ncase "$1" in *.stage-rollback) exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o700 });
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(remote, archive, "rollback")], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    await assert.rejects(stat(path.join(parent, ".dist.code-deploy-lock")));

    const link = path.join(parent, "linked-dist");
    await symlink(target, link);
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript({ ...remote, remoteDir: link }, archive, "link")]), /符号链接/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("模拟 SSH 完整部署链：构建、归档、上传、切换及端口", { skip: posixOnly }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-flow-test-"));
  const originalPath = process.env.PATH;
  const originalCwd = process.cwd();
  const password = "test-only-password-$quote";
  try {
    const project = path.join(temporary, "project");
    const bin = path.join(temporary, "bin");
    const target = path.join(temporary, "server/dist");
    const trace = path.join(temporary, "calls.log");
    await mkdir(project); await mkdir(bin);
    await run("git", ["init", "-b", "main"], { cwd: project });
    await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "test"], { cwd: project });
    const options = `while [ "$#" -gt 0 ]; do case "$1" in -o|-p|-P) shift 2;; *) break;; esac; done`;
    await writeFile(path.join(bin, "scp"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(trace)}\n${options}\ncp "$1" "\${2#*:}"\n`, { mode: 0o700 });
    await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(trace)}\nif [ -n "$CODE_DEPLOY_SSH_PASSWORD" ]; then test "$("$SSH_ASKPASS")" = "$CODE_DEPLOY_SSH_PASSWORD" || exit 1; printf '%s\\n' "$CODE_DEPLOY_SSH_PASSWORD"; fi\n${options}\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.chdir(project);
    const events: string[] = [];
    await deploy({ ...profile, projectDir: project, remoteDir: target, port: 2222 }, event => {
      if (event.type === "step") events.push(event.text);
    });
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    assert.equal(events.length, 4);
    const calls = await readFile(trace, "utf8");
    assert.match(calls, /-P\n2222/);
    assert.match(calls, /-p\n2222/);
    process.env.TEST_DEPLOY_PASSWORD = password;
    let logs = "";
    await deploy({ ...profile, projectDir: project, remoteDir: target, auth: "env" }, event => { logs += event.text; });
    assert.doesNotMatch(logs, /test-only-password/);
    assert.match(logs, /已隐藏/);
    assert.equal((await readFile(trace, "utf8")).includes(password), false);
    // 无构建命令、无 index.html、非 Git 目录也可直接发布。
    const plain = path.join(temporary, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "payload.json"), '{"value":1}');
    process.chdir(plain);
    await deploy({ ...profile, projectDir: plain, lockBranch: false, checkGit: false, buildCommand: "", outputDir: ".", remoteDir: target }, () => {});
    assert.equal(await readFile(path.join(target, "payload.json"), "utf8"), '{"value":1}');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    delete process.env.TEST_DEPLOY_PASSWORD;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("取消命令终止子进程", async () => {
  const controller = new AbortController();
  // 用当前 Node 充当长跑子进程，避免依赖 POSIX shell。
  const command = run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(command, /操作已取消/);
});

test("构建产物含符号链接时拒绝发布", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-symlink-test-"));
  const originalCwd = process.cwd();
  try {
    const project = path.join(temporary, "project");
    const output = path.join(project, "dist");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "index.html"), "new");
    try {
      await symlink(path.join(output, "index.html"), path.join(output, "link.html"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.skip("当前系统不允许创建符号链接：Windows 需管理员或开发者模式");
      return;
    }
    process.chdir(project);
    await assert.rejects(deploy({
      ...profile, projectDir: project, outputDir: "dist", buildCommand: "", expectedBranch: "",
      lockBranch: false, lockDirectory: false, lockMapping: false, checkGit: false
    }, () => {}), /符号链接/);
  } finally { process.chdir(originalCwd); await rm(temporary, { recursive: true, force: true }); }
});

test("远程输出中的 version.json 解析为逐行键值，非法内容保留原文", () => {
  const raw = `部署完成: /srv/app\n__CODE_DEPLOY_VERSION_BEGIN__\n{"name":"app","version":"1.2.3","meta":{"a":1}}\n__CODE_DEPLOY_VERSION_END__\n`;
  const pretty = formatRemoteOutput(raw);
  assert.match(pretty, /部署完成: \/srv\/app/);
  assert.match(pretty, /version\.json\n {2}name: app\n {2}version: 1\.2\.3\n {2}meta: \{"a":1\}/);
  assert.ok(!pretty.includes("BEGIN"));
  assert.equal(formatRemoteOutput("无标记输出"), "无标记输出");
  const broken = raw.replace('"meta"', 'meta'); // 去掉引号制造非法 JSON
  assert.ok(formatRemoteOutput(broken).includes('"name":"app"')); // 非法 JSON 保留原文
});
