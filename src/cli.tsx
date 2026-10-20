#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { render } from "ink";
import { App } from "./app.js";
import { configFile, loadConfig, saveConfig } from "./config.js";
import { checkServer, deploy, steps } from "./deploy.js";
import { inspectProject } from "./preflight.js";

const help = `DEPLOY · 本地目录 A → 服务器目录 B

用法：
  code-deploy                         打开交互界面
  code-deploy <环境标识>              打开指定环境
  code-deploy list                    列出环境
  code-deploy check <环境标识>        检查锁定规则、Git 状态和远程目录
  code-deploy deploy <环境标识> --yes  按配置构建并部署
  code-deploy config                  显示配置文件路径
  code-deploy init <配置文件>         首次导入环境配置，不覆盖已有环境

选项：
  -y, --yes    确认发布，Git 异常仍须交互确认
  -h, --help   显示帮助

可使用 CODE_DEPLOY_CONFIG 指定其他配置文件。密码不写入 JSON。
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: { help: { type: "boolean", short: "h" }, yes: { type: "boolean", short: "y" } },
    allowPositionals: true
  });
  if (values.help) { console.log(help); return; }
  const [command, id] = positionals;
  if (command === "config") { console.log(configFile); return; }
  let config = await loadConfig();
  if (command === "init") {
    if (!id) throw new Error("用法：code-deploy init <配置文件>");
    if (config.profiles.length) throw new Error("已有环境配置，请通过 TUI 编辑，避免覆盖");
    config = await loadConfig(id);
    if (!config.profiles.length) throw new Error("导入文件不存在或没有环境配置");
    await saveConfig(config);
    console.log(`已导入 ${config.profiles.length} 个环境：${configFile}`);
    return;
  }
  if (command === "list") {
    if (!config.profiles.length) console.log("暂无环境，运行 code-deploy 新建。");
    for (const profile of config.profiles) {
      console.log(`${profile.id}  ${profile.name}\n  A: ${profile.lockDirectory || profile.lockMapping ? profile.projectDir : "启动目录"}\n  B: ${profile.user}@${profile.host}:${profile.port}\n${profile.remoteDirs.map(dir => `     ${dir}`).join("\n")}\n  目录锁: ${profile.lockDirectory} · 分支锁: ${profile.lockBranch ? profile.expectedBranch : "关闭"} · 映射锁: ${profile.lockMapping} · Git 检查: ${profile.checkGit}\n`);
    }
    return;
  }
  if (command === "check" || command === "deploy") {
    const profile = config.profiles.find(item => item.id === id);
    if (!profile) throw new Error(`找不到环境 ${id || "（未指定）"}，运行 code-deploy list 查看`);
    if (command === "deploy" && !values.yes) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await render(<App initialConfig={config} initialId={id} />, { alternateScreen: true, exitOnCtrlC: false }).waitUntilExit();
        return;
      }
      throw new Error("非交互发布需要 --yes 明确确认；发布将替换配置的远程目录");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    // 连续 Ctrl+C 仍等待构建进程树清理，不能恢复默认信号行为而提前退出。
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      if (command === "check") {
        const project = await inspectProject(profile, controller.signal, profile.checkGit);
        console.log(`${project.directory}\n${project.branch || "无分支"} · ${project.commit.slice(0, 10) || "无提交"}`);
        if (project.warnings.length) console.log(`Git 状态提醒：\n${project.warnings.join("\n\n")}`);
        console.log(await checkServer(profile, controller.signal));
      } else {
        console.log(`发布 ${profile.name}\nA: ${process.cwd()}\nB: ${profile.user}@${profile.host}:${profile.port}\n${profile.remoteDirs.map(dir => `   ${dir}`).join("\n")}`);
        const started = Date.now();
        await deploy(profile, event => {
          if (event.type === "step") console.log(`\n[${event.index! + 1}/${steps.length}] ${event.text}`);
          else process.stdout.write(event.text);
        }, controller.signal, process.stdin.isTTY && process.stdout.isTTY ? async state => {
          console.log(`\nGit 状态需要确认：\n${state.warnings.join("\n\n")}`);
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await prompt.question("仍使用当前本地内容发布？ [y/N] ", { signal: controller.signal });
            return answer.trim().toLowerCase() === "y";
          } finally { prompt.close(); }
        } : undefined);
        console.log(`\n部署完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s。`);
      }
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    return;
  }
  if (command && !config.profiles.some(profile => profile.id === command)) throw new Error(`未知命令或环境：${command}\n${help}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log(help); return; }
  await render(<App initialConfig={config} initialId={command} />, { alternateScreen: true, exitOnCtrlC: false }).waitUntilExit();
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
