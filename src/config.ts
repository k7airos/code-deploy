import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// 配置文件独立于项目，切换工作目录不会改变环境列表。
export const configFile = process.env.CODE_DEPLOY_CONFIG || path.join(homedir(), ".config/code-deploy/config.json");
const singleLine = z.string().refine(value => !/[\x00-\x1f\x7f]/.test(value), "不能包含控制字符");

// 拒绝根目录、系统目录及带跳转的路径，降低误覆盖风险。
export function isSafeRemoteDir(value: string): boolean {
  const parts = value.split("/").filter(Boolean);
  return value.startsWith("/") && parts.length >= 2 &&
    !/[\x00-\x1f\x7f]/.test(value) && !parts.some(part => part === "." || part === "..") &&
    !["bin", "sbin", "etc", "usr", "lib", "lib64", "proc", "sys", "dev", "boot", "run"].includes(parts[0]!);
}

// 按完整路径段判断重叠，避免把 app 与 app2 当作父子目录。
function remoteDirsOverlap(first: string, second: string): boolean {
  const a = path.posix.normalize(first).replace(/\/$/, "");
  const b = path.posix.normalize(second).replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const remoteDirsSchema = z.array(z.string().refine(isSafeRemoteDir, "远程目录必须是至少两级的绝对路径，且不能是系统目录"))
  .min(1, "至少配置一个远程目录").superRefine((dirs, context) => {
    for (const [index, dir] of dirs.entries()) {
      if (dirs.slice(0, index).some(previous => remoteDirsOverlap(previous, dir))) {
        context.addIssue({ code: "custom", message: "远程目录不能重复或互为父子目录", path: [index] });
      }
    }
  });

const mappingSchema = z.object({
  projectDir: singleLine.refine(path.isAbsolute), branch: singleLine.min(1),
  host: singleLine.min(1), user: singleLine.min(1), port: z.number().int().min(1).max(65535),
  remoteDirs: remoteDirsSchema
});

export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "环境标识只能使用小写字母、数字和连字符"),
  name: singleLine.min(1, "请输入环境名称"),
  projectDir: singleLine.refine(path.isAbsolute, "本地目录必须是绝对路径"),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, "请输入 IP、主机名或 SSH 别名"),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "请输入服务器账号"),
  port: z.number().int().min(1).max(65535),
  remoteDirs: remoteDirsSchema,
  buildCommand: singleLine,
  outputDir: singleLine.min(1).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "发布内容必须是源目录内的相对路径，或使用 . 发布源目录本身"),
  expectedBranch: singleLine,
  auth: z.enum(["env", "keychain", "ssh"]),
  passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名称无效"),
  password: singleLine.optional(),
  lockDirectory: z.boolean().default(false),
  lockBranch: z.boolean().default(false),
  lockMapping: z.boolean().default(false),
  checkGit: z.boolean().default(true),
  mapping: mappingSchema.optional()
});

export type Profile = z.infer<typeof profileSchema>;
const configSchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema) }).superRefine((data, context) => {
  if (new Set(data.profiles.map(profile => profile.id)).size !== data.profiles.length) {
    context.addIssue({ code: "custom", message: "环境标识不能重复", path: ["profiles"] });
  }
  for (const profile of data.profiles) {
    if (profile.lockBranch && !profile.expectedBranch) context.addIssue({ code: "custom", message: `${profile.name}：开启分支锁时必须填写指定分支` });
    if (!profile.lockMapping) continue;
    const mapping = profile.mapping;
    if (!mapping || path.resolve(profile.projectDir) !== path.resolve(mapping.projectDir) ||
      targetKey(profile) !== targetKey(mapping)) {
      context.addIssue({ code: "custom", message: `${profile.name}：配置与锁定映射不一致，请先解除映射锁再修改` });
    }
    for (const other of data.profiles) {
      if (other.id === profile.id || !other.lockMapping || !other.mapping || !mapping) continue;
      const sameSource = path.resolve(mapping.projectDir) === path.resolve(other.mapping.projectDir);
      const sameTarget = targetKey(mapping) === targetKey(other.mapping);
      const sameServer = mapping.host === other.mapping.host && mapping.user === other.mapping.user && mapping.port === other.mapping.port;
      const overlapping = sameServer && mapping.remoteDirs.some(dir => other.mapping!.remoteDirs.some(otherDir => remoteDirsOverlap(dir, otherDir)));
      if ((sameSource && !sameTarget) || (!sameSource && overlapping)) {
        context.addIssue({ code: "custom", message: `${profile.name} 与 ${other.name} 的锁定映射不是一一对应，或远程目录存在重叠` });
      }
    }
  }
});
export type Config = z.infer<typeof configSchema>;

// 服务器和目录集合共同标识远程目标，规范化末尾斜线并按目录排序。
export function targetKey(target: Pick<Profile, "host" | "user" | "port" | "remoteDirs">): string {
  const dirs = target.remoteDirs.map(dir => path.posix.normalize(dir).replace(/\/$/, "")).sort();
  return JSON.stringify([target.host, target.user, target.port, dirs]);
}

// 保留旧目录与分支约束；单目录映射迁移后需重新确认，默认解除映射锁。
function migrateConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("profiles" in value) || !Array.isArray(value.profiles)) return value;
  return { ...value, profiles: value.profiles.map(profile => {
    // 只解除旧格式的映射锁，新版配置仍执行原有锁定校验。
    const legacyMapping = (profile.remoteDirs == null && Boolean(profile.remoteDir)) ||
      (profile.mapping?.remoteDirs == null && Boolean(profile.mapping?.remoteDir));
    return {
      ...profile,
      lockDirectory: profile.lockDirectory ?? true,
      lockBranch: profile.lockBranch ?? Boolean(profile.expectedBranch),
      remoteDirs: profile.remoteDirs ?? (profile.remoteDir ? [profile.remoteDir] : []),
      ...(legacyMapping ? { lockMapping: false, mapping: undefined } : {})
    };
  }) };
}

// 只将“文件不存在”视为空配置，避免损坏配置被悄悄覆盖。
export async function loadConfig(file = configFile): Promise<Config> {
  try {
    return configSchema.parse(migrateConfig(JSON.parse(await readFile(file, "utf8"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: [] };
    throw new Error(`读取配置失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(config: Config, file = configFile): Promise<void> {
  const parsed = configSchema.parse(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

// 新配置使用通用默认值，服务器、目录和分支均由用户填写。
export function newProfile(): Profile {
  return {
    id: "", name: "", projectDir: process.cwd(), host: "", user: process.env.USER || "deploy", port: 22,
    remoteDirs: [], buildCommand: "", outputDir: ".",
    expectedBranch: "", auth: "ssh", passwordEnv: "DEPLOY_SERVER_PASSWORD",
    lockDirectory: false, lockBranch: false, lockMapping: false, checkGit: true
  };
}
