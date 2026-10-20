import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSafeRemoteDir, loadConfig, profileSchema, saveConfig, newProfile, type Profile } from "../src/config.js";
import { deploy, formatRemoteOutput, quote, remoteDeployScript, run } from "../src/deploy.js";
import { resolvePassword } from "../src/credentials.js";

const profile: Profile = {
  ...newProfile(), checkGit: false, lockBranch: true, id: "test", name: "测试", projectDir: path.resolve("project"), host: "example.test", user: "deploy", port: 22,
  remoteDirs: ["/data/web/test/dist"], buildCommand: "mkdir -p dist && printf new > dist/index.html",
  outputDir: "dist", expectedBranch: "main", auth: "ssh", passwordEnv: "TEST_DEPLOY_PASSWORD"
};

// 远程脚本与 mock 依赖 POSIX 可执行文件：Windows 上 libuv 只补 .exe，命中不了无扩展名脚本。
const posixOnly = process.platform === "win32" ? "仅在 POSIX 环境运行：依赖 /bin/sh 与无扩展名可执行文件" : false;

test("内联密码字段优先于环境变量和钥匙串", async () => {
  const inline = profileSchema.parse({ ...newProfile(), id: "inline", name: "内联", host: "example.test", remoteDirs: ["/srv/app"], auth: "env", passwordEnv: "NOPE", password: "inline-secret" });
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
    for (const remoteDirs of [["/srv/app", "/srv/app/"], ["/srv//app", "/srv/app"], ["/srv/app/child", "/srv/app"], ["/srv/app", "/srv/app/child"]]) {
      assert.equal(profileSchema.safeParse({ ...profile, remoteDirs }).success, false);
    }
    assert.equal(profileSchema.safeParse({ ...profile, remoteDirs: ["/srv/app", "/srv/app2"] }).success, true);
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
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "code-deploy-switch-test-")));
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
    await pack();
    await run("/bin/sh", ["-c", remoteDeployScript(target, archive, "first")]);
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    assert.equal(await readFile(path.join(parent, ".dist.backup-first/index.html"), "utf8"), "old");
    assert.equal(await readFile(path.join(parent, "backend.dll"), "utf8"), "keep");

    await writeFile(archive, "corrupt");
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(target, archive, "corrupt")]));
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    await assert.rejects(stat(path.join(parent, ".dist.code-deploy-lock")));

    await pack();
    await mkdir(path.join(parent, ".dist.code-deploy-lock"));
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(target, archive, "locked")]), /目标正在部署/);
    await rm(path.join(parent, ".dist.code-deploy-lock"), { recursive: true });

    // 仅让新版本移动失败，验证旧版本能恢复。
    const bin = path.join(temporary, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "mv"), '#!/bin/sh\ncase "$1" in *.stage-rollback) exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o700 });
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(target, archive, "rollback")], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    await assert.rejects(stat(path.join(parent, ".dist.code-deploy-lock")));

    const link = path.join(parent, "linked-dist");
    await symlink(target, link);
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(link, archive, "link")]), /符号链接/);
    // 上级目录是链接时，即使最终目标不存在，也必须在创建目录前阻断。
    const alias = path.join(temporary, "alias");
    await symlink(parent, alias);
    await assert.rejects(run("/bin/sh", ["-c", remoteDeployScript(path.join(alias, "missing/dist"), archive, "ancestor")]), /符号链接/);
    await assert.rejects(stat(path.join(parent, "missing")));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("模拟 SSH 完整部署链：构建、归档、上传、切换及端口", { skip: posixOnly }, async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "code-deploy-flow-test-")));
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
    // 模拟 Windows 同名 find 不兼容，完整发布仍应成功。
    await writeFile(path.join(bin, "find"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.chdir(project);
    const events: string[] = [];
    await deploy({ ...profile, projectDir: project, remoteDirs: [target], port: 2222 }, event => {
      if (event.type === "step") events.push(event.text);
    });
    assert.equal(await readFile(path.join(target, "index.html"), "utf8"), "new");
    assert.equal(events.length, 4);
    const calls = await readFile(trace, "utf8");
    assert.match(calls, /-P\n2222/);
    assert.match(calls, /-p\n2222/);
    process.env.TEST_DEPLOY_PASSWORD = password;
    let logs = "";
    await deploy({ ...profile, projectDir: project, remoteDirs: [target], auth: "env" }, event => { logs += event.text; });
    assert.doesNotMatch(logs, /test-only-password/);
    assert.match(logs, /已隐藏/);
    assert.equal((await readFile(trace, "utf8")).includes(password), false);
    // 无构建命令、无 index.html、非 Git 目录也可直接发布。
    const plain = path.join(temporary, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "payload.json"), '{"value":1}');
    process.chdir(plain);
    await deploy({ ...profile, projectDir: plain, lockBranch: false, checkGit: false, buildCommand: "", outputDir: ".", remoteDirs: [target] }, () => {});
    assert.equal(await readFile(path.join(target, "payload.json"), "utf8"), '{"value":1}');
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    delete process.env.TEST_DEPLOY_PASSWORD;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("一份产物发布到多个远程目录：只构建上传一次，失败及取消均清理上传目录", { skip: posixOnly }, async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "code-deploy-multi-test-")));
  const originalPath = process.env.PATH;
  const originalCwd = process.cwd();
  try {
    const project = path.join(temporary, "project");
    const bin = path.join(temporary, "bin");
    const first = path.join(temporary, "server/a/dist");
    const second = path.join(temporary, "server/b/dist");
    const third = path.join(temporary, "server/c/dist");
    const trace = path.join(temporary, "calls.log");
    const uploads = path.join(temporary, "uploads.log");
    const builds = path.join(temporary, "builds");
    await mkdir(project); await mkdir(bin);
    const options = `while [ "$#" -gt 0 ]; do case "$1" in -o|-p|-P) shift 2;; *) break;; esac; done`;
    await writeFile(path.join(bin, "scp"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(trace)}\n${options}\ndestination=\${2#*:}\nprintf '%s\\n' "$destination" >> ${quote(uploads)}\n${quote(process.execPath)} -e 'const fs = require("node:fs"); if ((fs.statSync(require("node:path").dirname(process.argv[1])).mode & 511) !== 448) process.exit(1)' "$destination" || exit 1\ncp "$1" "$destination"\n`, { mode: 0o700 });
    await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(trace)}\n${options}\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.chdir(project);
    let logs = "";
    await deploy({ ...profile, projectDir: project, lockBranch: false, checkGit: false, remoteDirs: [first, second],
      buildCommand: `printf x >> ${quote(builds)} && mkdir -p dist && printf new > dist/index.html` }, event => { logs += event.text; });
    assert.equal(await readFile(path.join(first, "index.html"), "utf8"), "new");
    assert.equal(await readFile(path.join(second, "index.html"), "utf8"), "new");
    assert.match(logs, /切换到/);
    assert.equal((await readFile(builds, "utf8")).length, 1); // 只构建一次
    const calls = await readFile(trace, "utf8");
    assert.equal((calls.match(/^.*:.*\/archive\.tar\.gz$/gm) || []).length, 1); // 只上传一次
    assert.equal(calls.split(".code-deploy-lock").length - 1, 2); // 逐个目录切换
    const uploadedDirs = async () => (await readFile(uploads, "utf8")).trim().split("\n").map(file => path.dirname(file));
    await assert.rejects(stat((await uploadedDirs())[0]!));

    // 第二个目录被锁住时立即中断：第一个已切换，第三个不动。
    await mkdir(path.join(temporary, "server/b"), { recursive: true });
    await mkdir(path.join(temporary, "server/b/.dist.code-deploy-lock"), { recursive: true });
    await assert.rejects(deploy({ ...profile, projectDir: project, lockBranch: false, checkGit: false, remoteDirs: [first, second, third],
      buildCommand: `printf x >> ${quote(builds)} && mkdir -p dist && printf new > dist/index.html` }, () => {}), /目标正在部署/);
    assert.equal(await readFile(path.join(first, "index.html"), "utf8"), "new");
    await assert.rejects(stat(path.join(third, "index.html")));
    await assert.rejects(stat((await uploadedDirs())[1]!));

    // 上传过程中取消后，清理请求不能复用已取消的 signal。
    const controller = new AbortController();
    await writeFile(path.join(bin, "scp"), `#!/bin/sh\n${options}\nprintf '%s\\n' "\${2#*:}" >> ${quote(uploads)}\nprintf 'upload-ready\\n'\nsleep 30\n`, { mode: 0o700 });
    await assert.rejects(deploy({ ...profile, projectDir: project, lockBranch: false, remoteDirs: [first], buildCommand: "" }, event => {
      if (event.text.includes("upload-ready")) controller.abort();
    }, controller.signal), /操作已取消/);
    await assert.rejects(stat((await uploadedDirs())[2]!));
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("产物中的嵌套符号链接或 junction 在上传前被阻断", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-links-test-"));
  const cwd = process.cwd();
  try {
    const output = path.join(temporary, "dist/nested");
    const outside = path.join(temporary, "outside");
    await mkdir(output, { recursive: true }); await mkdir(outside);
    await symlink(outside, path.join(output, "link"), process.platform === "win32" ? "junction" : "dir");
    process.chdir(temporary);
    await assert.rejects(deploy({ ...profile, projectDir: temporary, lockBranch: false, buildCommand: "" }, () => {}), /包含符号链接/);
  } finally { process.chdir(cwd); await rm(temporary, { recursive: true, force: true }); }
});

test("取消构建终止 shell 及后代进程，忽略 SIGTERM 的进程也不能残留", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-cancel-test-"));
  const controller = new AbortController();
  const ready = path.join(temporary, "ready");
  const marker = path.join(temporary, "still-running");
  let pid: number | undefined;
  let command: Promise<string> | undefined;
  try {
    const worker = path.join(temporary, "worker.cjs");
    const parent = path.join(temporary, "parent.cjs");
    await writeFile(worker, `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'continued'), 800); setInterval(() => {}, 1000);`);
    await writeFile(parent, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
    command = run(`"${process.execPath}" "${parent}"`, [], { shell: true, signal: controller.signal });
    const cancelled = assert.rejects(command, /操作已取消/);
    for (let attempt = 0; attempt < 150; attempt++) {
      pid = await readFile(ready, "utf8").then(Number, () => undefined);
      if (pid) break;
      await setTimeout(20);
    }
    assert.ok(pid, "构建后代进程未就绪");
    controller.abort();
    await cancelled;
    await setTimeout(1000);
    await assert.rejects(stat(marker));
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await command?.catch(() => {});
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* 进程已终止 */ } }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("CLI 连续两次 Ctrl+C 等待构建进程树结束后才退出", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-sigint-test-"));
  const ready = path.join(temporary, "ready");
  let pid: number | undefined;
  let cli: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    const worker = path.join(temporary, "worker.cjs");
    const parent = path.join(temporary, "parent.cjs");
    const config = path.join(temporary, "config.json");
    // 后代继承输出管道且忽略 SIGTERM，迫使 CLI 等待强制终止，覆盖第二次 Ctrl+C。
    await writeFile(worker, `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`);
    await writeFile(parent, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`);
    await saveConfig({ version: 1, profiles: [{ ...profile, projectDir: temporary, lockBranch: false, buildCommand: `"${process.execPath}" "${parent}"` }] }, config);
    cli = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.tsx", import.meta.url)), "deploy", profile.id, "--yes"], {
      cwd: temporary, env: { ...process.env, CODE_DEPLOY_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    cli.stdout?.on("data", chunk => { output += chunk; });
    cli.stderr?.on("data", chunk => { output += chunk; });
    closed = new Promise((resolve, reject) => { cli!.on("error", reject); cli!.on("close", (code, signal) => resolve({ code, signal })); });
    for (let attempt = 0; attempt < 200; attempt++) {
      pid = await readFile(ready, "utf8").then(Number, () => undefined);
      if (pid) break;
      await setTimeout(20);
    }
    assert.ok(pid, output);
    cli.kill("SIGINT");
    await setTimeout(50);
    cli.kill("SIGINT");
    assert.deepEqual(await closed, { code: 1, signal: null }, output);
    assert.match(output, /操作已取消/);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* 进程已终止 */ } }
    if (cli?.exitCode === null && cli?.signalCode === null) cli.kill("SIGKILL");
    await closed?.catch(() => {});
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
