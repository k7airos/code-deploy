import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { profileSchema, type Profile } from "./config.js";
import { resolvePassword } from "./credentials.js";
import { run, quote, type RunOptions } from "./process.js";
import { prepareRelease, inspectProject, type ConfirmGit } from "./preflight.js";

export const steps = ["发布前检查", "准备发布内容", "打包上传", "切换版本"];
export type DeployEvent = { type: "step" | "log"; text: string; index?: number };
export { quote, run } from "./process.js";
export { inspectProject } from "./preflight.js";

// 使用 OpenSSH，沿用 ~/.ssh/config、known_hosts 及本机 SSH agent。
async function withSsh<T>(profile: Profile, task: (ssh: (command: string, args: string[], options?: RunOptions) => Promise<string>) => Promise<T>): Promise<T> {
  const password = await resolvePassword(profile);
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-ssh-"));
  try {
    // shortcut: Windows 密码认证依赖 Win32-OpenSSH 的 SSH_ASKPASS 支持，未实测；建议密钥或 agent
    const askpass = path.join(temporary, process.platform === "win32" ? "askpass.cmd" : "askpass.sh");
    if (password) await writeFile(askpass, process.platform === "win32"
      ? '@echo off\r\necho %CODE_DEPLOY_SSH_PASSWORD%\r\n'
      : '#!/bin/sh\nprintf "%s\\n" "$CODE_DEPLOY_SSH_PASSWORD"\n', { mode: 0o700 });
    const base = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "NumberOfPasswordPrompts=1"];
    if (!password) base.push("-o", "BatchMode=yes");
    return await task((command, args, options = {}) => run(command,
      [...base, command === "scp" ? "-P" : "-p", String(profile.port), ...args], {
        ...options,
        env: {
          ...process.env,
          ...(password ? { CODE_DEPLOY_SSH_PASSWORD: password, DISPLAY: process.env.DISPLAY || "code-deploy", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" } : {})
        },
        onOutput: text => options.onOutput?.(password ? text.split(password).join("[已隐藏]") : text)
      }).then(result => password ? result.split(password).join("[已隐藏]") : result).catch(error => {
        throw new Error(password ? String(error.message).split(password).join("[已隐藏]") : error.message);
      }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// 检查目标及全部祖先路径，阻止通过上级符号链接绕过目录保护。
const remotePathGuard = `ancestor=$target
while [ "$ancestor" != / ]; do
  if [ -L "$ancestor" ]; then echo "目标或上级目录是符号链接，请填写真实路径: $ancestor" >&2; exit 1; fi
  ancestor=\${ancestor%/*}
  [ -n "$ancestor" ] || ancestor=/
done`;

export async function checkServer(profile: Profile, signal?: AbortSignal): Promise<string> {
  profileSchema.parse(profile);
  return withSsh(profile, ssh => ssh("ssh", [`${profile.user}@${profile.host}`, `set -eu
for target in ${profile.remoteDirs.map(dir => quote(path.posix.normalize(dir).replace(/\/$/, ""))).join(" ")}; do
  echo "== $target"
  ${remotePathGuard}
  if [ -d "$target" ]; then ls -ld "$target"; ls -1 "$target" | head -20; else echo '目标尚不存在，部署时会创建'; fi
done`], { signal }));
}

// version.json 用标记包裹传回，本地解析后美化展示。
const versionBegin = "__CODE_DEPLOY_VERSION_BEGIN__";
const versionEnd = "__CODE_DEPLOY_VERSION_END__";

// 递归查找符号链接；不依赖外部 find，Windows 上的 find 不是 GNU 版本会直接失败。
export async function findSymlinks(directory: string, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const pending = [directory];
  while (pending.length) {
    if (signal?.aborted) throw new Error("操作已取消");
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) found.push(full);
      else if (entry.isDirectory()) pending.push(full);
    }
  }
  return found;
}

// 先完整解压，再保留旧版本并切换；失败时恢复旧目录。
export function remoteDeployScript(dir: string, archive: string, token: string): string {
  const target = path.posix.normalize(dir).replace(/\/$/, "");
  const parent = path.posix.dirname(target);
  const name = path.posix.basename(target);
  return `set -eu
target=${quote(target)}
parent=${quote(parent)}
archive=${quote(archive)}
stage=${quote(`${parent}/.${name}.stage-${token}`)}
backup=${quote(`${parent}/.${name}.backup-${token}`)}
lock=${quote(`${parent}/.${name}.code-deploy-lock`)}
switched=0
${remotePathGuard}
mkdir -p "$parent"
if [ -e "$target" ] && [ ! -d "$target" ]; then echo '目标不是目录，已停止' >&2; exit 1; fi
if ! mkdir "$lock"; then echo '目标正在部署或留有锁目录，请核实后处理' >&2; exit 1; fi
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$switched" = 0 ] && [ -d "$backup" ] && [ ! -e "$target" ]; then mv "$backup" "$target"; fi
  rm -rf -- "$stage"
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
mkdir "$stage"
tar -xzf "$archive" -C "$stage"
test -n "$(ls -A "$stage")"
if [ -e "$target" ]; then mv "$target" "$backup"; fi
mv "$stage" "$target"
switched=1
echo "部署完成: $target"
if [ -d "$backup" ]; then echo "旧版本保留: $backup"; fi
if [ -f "$target/version.json" ]; then echo '${versionBegin}'; cat "$target/version.json"; echo; echo '${versionEnd}'; fi`;
}

// 标记内的 JSON 解析为逐行键值；解析失败保留原文。
export function formatRemoteOutput(text: string): string {
  const start = text.indexOf(versionBegin);
  const stop = start < 0 ? -1 : text.indexOf(versionEnd, start);
  if (start < 0 || stop < 0) return text;
  const body = text.slice(start + versionBegin.length, stop).trim();
  let pretty = body;
  try {
    const data: unknown = JSON.parse(body);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      pretty = ["version.json", ...Object.entries(data as Record<string, unknown>).map(([key, value]) =>
        `  ${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`)].join("\n");
    }
  } catch { /* 保留原文 */ }
  return `${text.slice(0, start)}${pretty}\n${text.slice(stop + versionEnd.length)}`;
}

export async function deploy(profile: Profile, emit: (event: DeployEvent) => void, signal?: AbortSignal, confirm?: ConfirmGit): Promise<void> {
  const step = (index: number) => emit({ type: "step", index, text: steps[index]! });
  const log = (text: string) => emit({ type: "log", text });
  step(0);
  const project = await prepareRelease(profile, signal, confirm);
  log(`${project.directory}\n${project.branch || "无分支"} · ${project.commit.slice(0, 10) || "无提交"}\n`);
  // 构建前核验凭据，避免构建完成才发现没有密码。
  await resolvePassword(profile);
  step(1);
  // shell:true 由 Node 按平台选择 /bin/sh 或 cmd.exe
  if (profile.buildCommand) await run(profile.buildCommand, [], { shell: true, cwd: project.directory, signal, onOutput: log });
  else log("未配置构建命令，直接发布现有目录内容\n");
  const current = await inspectProject(profile, signal);
  if (current.directory !== project.directory || current.branch !== project.branch || current.commit !== project.commit) {
    throw new Error("准备期间源目录、分支或 HEAD 发生变化，请重新发起发布");
  }
  const output = await realpath(path.join(project.directory, profile.outputDir));
  const relative = path.relative(project.directory, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("构建产物必须位于项目目录内");
  if (!(await lstat(output)).isDirectory()) throw new Error("构建产物不是目录");
  if (!(await readdir(output)).length) throw new Error("发布目录为空");
  // 禁止归档符号链接，避免服务器解压时逃离暂存目录。
  const links = await findSymlinks(output, signal);
  if (links.length) throw new Error(`构建产物包含符号链接，请先移除：\n${links.join("\n")}`);
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-build-"));
  const token = randomUUID();
  const localArchive = path.join(temporary, "dist.tar.gz");
  const remoteTemporary = `/tmp/code-deploy-${token}`;
  const remoteArchive = `${remoteTemporary}/archive.tar.gz`;
  try {
    step(2);
    await run("tar", [...(process.platform === "darwin" ? ["--no-xattrs"] : []), "-czf", localArchive, "-C", output, "."], {
      signal, env: { ...process.env, COPYFILE_DISABLE: "1" }
    });
    await withSsh(profile, async ssh => {
      const destination = `${profile.user}@${profile.host}`;
      // 私有目录保护上传产物；目录名冲突时拒绝复用。
      await ssh("ssh", [destination, `umask 077\nmkdir ${quote(remoteTemporary)}`], { signal });
      try {
        await ssh("scp", [localArchive, `${profile.user}@${profile.host.includes(":") ? `[${profile.host}]` : profile.host}:${remoteArchive}`], { signal, onOutput: log });
        step(3);
        // 同一份产物按顺序切换到每个目标目录，任一失败即中断。
        for (const dir of profile.remoteDirs) {
          log(`切换到 ${dir}\n`);
          let remoteOutput = "";
          await ssh("ssh", [destination, remoteDeployScript(dir, remoteArchive, token)], { signal, onOutput: text => { remoteOutput += text; } });
          log(formatRemoteOutput(remoteOutput));
        }
      } finally {
        // 取消后仍独立尝试清理，清理错误不覆盖原始发布结果。
        try {
          await ssh("ssh", [destination, `rm -rf -- ${quote(remoteTemporary)}`], { signal: AbortSignal.timeout(10_000) });
        } catch (error) {
          log(`远程临时目录清理失败，请手动删除 ${remoteTemporary}：${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
