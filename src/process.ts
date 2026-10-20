import { execFile, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onOutput?: (text: string) => void; shell?: boolean };
export type { RunOptions };

// 参数以数组传递，只有用户明确配置的构建命令通过 shell 执行。
export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new Error("操作已取消"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, shell: options.shell, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let output = "";
    let killTimer: NodeJS.Timeout | undefined;
    let treeKill: Promise<void> | undefined;
    function kill(signal: NodeJS.Signals) {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // macOS 对只剩僵尸进程的组 kill 返回 EPERM，Windows 上进程已退出返回 EINVAL，均无需处理
        if (!["ESRCH", "EPERM", "EINVAL"].includes((error as NodeJS.ErrnoException).code!)) throw error;
      }
    }
    const abort = () => {
      // Windows 的 child.kill 只结束 cmd.exe，taskkill 同时结束构建子进程。
      if (process.platform === "win32" && child.pid) {
        treeKill = new Promise(resolve => {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
            if (error) {
              child.kill();
              reject(new Error(`操作已取消，但终止 Windows 子进程树失败，请检查残留进程：${error.message}`));
            }
            resolve();
          });
        });
        return;
      }
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const collect = (chunk: string) => {
      const text = stripVTControlCharacters(chunk).replace(/\r/g, "");
      output = (output + text).slice(-100_000);
      options.onOutput?.(text);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", async (code, signal) => {
      await treeKill;
      // shell 先退出时仍清理整个进程组，避免提前清掉强制终止定时器后留下构建进程。
      if (options.signal?.aborted && process.platform !== "win32") kill("SIGKILL");
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(new Error("操作已取消；若已进入远程切换阶段，请检查服务器上的当前版本"));
      else if (code !== 0) reject(new Error(`${command} 执行失败 (${signal || code})\n${output.slice(-4000)}`));
      else resolve(output.trim());
    });
  });
}

// 单引号转义用于远程 POSIX shell，支持目录中的空格及引号。
export const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
