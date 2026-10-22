import { useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { PasswordInput, TextInput } from "@inkjs/ui";
import { homedir } from "node:os";
import { newProfile, profileSchema, type Config, type Profile } from "./config.js";
import { savePassword } from "./credentials.js";
import { captureMapping } from "./preflight.js";
import { wrapText } from "./text.js";
import { KeyHints, Spinner, Viewport, colors, useScroll } from "./ui.js";

export const authNames = { env: "环境变量", keychain: "系统钥匙串", ssh: "SSH 密钥 / Agent" };
type Field = Exclude<keyof Profile, "mapping">;
type FieldDef = { key: Field; label: string; hint: string; section: number };
const sections = ["基础", "服务器", "构建", "保护", "认证", "确认"];

// 向导按此顺序逐项提问；section 对应顶部进度条的分组。
const fields: FieldDef[] = [
  { key: "id", label: "环境标识", hint: "小写字母、数字、连字符；创建后固定", section: 0 },
  { key: "name", label: "显示名称", hint: "为这条发布配置取一个名称", section: 0 },
  { key: "projectDir", label: "本地目录 A", hint: "目录锁或映射锁开启时必须在此目录运行；未锁定时使用启动目录", section: 0 },
  { key: "host", label: "目标服务器", hint: "IP、域名或 SSH 别名", section: 1 },
  { key: "user", label: "登录账号", hint: "服务器上的 SSH 登录账号", section: 1 },
  { key: "port", label: "SSH 端口", hint: "服务器的 SSH 端口", section: 1 },
  { key: "remoteDirs", label: "远程目录 B", hint: "可配置多个目录，逐个回车添加；留空回车完成，空输入退格删除最后一个", section: 1 },
  { key: "buildCommand", label: "构建命令", hint: "在源目录执行；留空表示直接发布已有内容", section: 2 },
  { key: "outputDir", label: "发布内容", hint: "源目录内的相对路径；. 表示整个源目录，dist 表示构建产物", section: 2 },
  { key: "expectedBranch", label: "指定分支", hint: "开启分支锁时必须填写；关闭时仅保存此值，不限制发布", section: 3 },
  { key: "lockDirectory", label: "锁定本地目录", hint: "开启后只能在本地目录 A 本身运行；子目录也不允许", section: 3 },
  { key: "lockBranch", label: "锁定发布分支", hint: "发布时检查实际分支等于指定分支，用错分支时拦截提醒", section: 3 },
  { key: "lockMapping", label: "锁定映射关系", hint: "记录目录 A 与服务器、目录 B 的对应关系；分支由分支锁单独约束；需在目录 A 开启", section: 3 },
  { key: "checkGit", label: "Git 状态检查", hint: "默认开启；刷新上游，检查未提交、未拉取及未推送代码，异常时等待确认", section: 3 },
  { key: "auth", label: "登录方式", hint: "支持 SSH 密钥、环境变量或系统钥匙串", section: 4 },
  { key: "passwordEnv", label: "密码环境变量", hint: "仅环境变量认证使用；这里填写变量名，不是密码", section: 4 }
];
const actions = ["保存配置", "保存钥匙串密码", "取消修改"];
const protectedFields: Field[] = ["projectDir", "host", "user", "port", "remoteDirs", "expectedBranch"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function fieldValue(profile: Profile, key: Field): string {
  if (typeof profile[key] === "boolean") return profile[key] ? "开启" : "关闭";
  if (key === "auth") return authNames[profile.auth];
  if (key === "remoteDirs") return profile.remoteDirs.join(" · ") || "（未设置）";
  return String(profile[key] || "（未设置）");
}

// 引导式向导：一次只问当前一项，已答项保留在上方；↑↓ 回看或跳过。
export function Settings({ config, profile, initial, width: availableWidth, height: availableHeight, onSave, onCancel }: {
  config: Config; profile?: Profile; initial?: Profile; width?: number; height?: number;
  onSave: (profile: Profile) => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Profile>(initial || profile || newProfile);
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState(0);
  const [enteringPassword, setEnteringPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const field = fields[step];
  const done = step >= fields.length;
  const fixed = field?.key === "id" && Boolean(profile);
  const locked = Boolean(field && draft.lockMapping && protectedFields.includes(field.key));
  const isBoolean = field ? typeof draft[field.key] === "boolean" : false;
  const isDirs = field?.key === "remoteDirs";
  const isAuth = field?.key === "auth";

  // 可用高度扣掉进度条、当前问题卡片、提示行后，剩余空间留给已答项；放不下时只保留最近几项。
  const window = useWindowSize();
  const width = Math.min(availableWidth ?? window.columns - 2, 100);
  const height = availableHeight ?? window.rows - 4;
  const hint = field ? wrapText(field.hint, width - 4) : [];
  const extras = (draft.lockMapping && draft.mapping ? 1 : 0) + (error ? 1 : 0);
  const cardRows = done ? 3 + (enteringPassword ? 1 : 0) : 3 + hint.length + (isDirs && draft.remoteDirs.length ? 1 : 0);
  const room = Math.max(0, height - 3 - cardRows - extras);
  const review = useScroll(fields.length, Math.max(1, room));

  async function attempt(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await task(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  async function save() {
    if (!profile && config.profiles.some(item => item.id === draft.id)) throw new Error("环境标识已存在");
    profileSchema.parse(draft);
    if (draft.lockBranch && !draft.expectedBranch) throw new Error("开启分支锁时必须填写指定分支");
    await onSave(draft);
  }
  function advance() { setError(""); setStep(current => Math.min(fields.length, current + 1)); }
  function submitText(raw: string) {
    if (!field) return;
    // 远程目录逐个添加：回车一个加一个并留在本项，留空回车才进入下一项。
    if (field.key === "remoteDirs") {
      const value = raw.trim();
      if (!value) { advance(); return; }
      if (draft.remoteDirs.includes(value)) { setError("该目录已经添加过"); return; }
      const result = profileSchema.shape.remoteDirs.safeParse([...draft.remoteDirs, value]);
      if (!result.success) { setError(result.error.issues[0]!.message); return; }
      setDraft({ ...draft, remoteDirs: result.data });
      setTyped("");
      return;
    }
    let value: string | number = field.key === "port" ? Number(raw) : raw.trim();
    if (field.key === "projectDir" && typeof value === "string" && value.startsWith("~/")) value = `${homedir()}/${value.slice(2)}`;
    const result = profileSchema.shape[field.key].safeParse(value);
    if (!result.success) { setError(result.error.issues[0]!.message); return; }
    setDraft({ ...draft, [field.key]: result.data });
    advance();
  }
  function toggleBoolean() {
    if (!field) return;
    const value = draft[field.key];
    if (field.key === "lockMapping" && !value) void attempt(async () => { setDraft(await captureMapping(profileSchema.parse(draft))); });
    else setDraft({ ...draft, [field.key]: !value });
  }
  function cycleAuth(direction: number) {
    const order = Object.keys(authNames) as Profile["auth"][];
    setDraft({ ...draft, auth: order[(order.indexOf(draft.auth) + direction + order.length) % order.length]! });
  }
  useInput((input, key) => {
    if (key.ctrl && input === "s") { void attempt(save); return; }
    if (busy) return;
    if (key.escape) {
      if (enteringPassword) { setEnteringPassword(false); setError(""); }
      else onCancel();
      return;
    }
    if (enteringPassword) return;
    if (done) {
      if (review.handle(input, key, false)) return;
      if (key.leftArrow) setChoice((choice + actions.length - 1) % actions.length);
      if (key.rightArrow) setChoice((choice + 1) % actions.length);
      if (key.upArrow) setStep(fields.length - 1);
      if (!key.return) return;
      setError("");
      if (choice === 0) void attempt(save);
      else if (choice === 1) setEnteringPassword(true);
      else onCancel();
      return;
    }
    if (!field) return;
    // 输入框为空时退格，删除最后添加的目录。
    if (isDirs && !locked && key.backspace && !typed) {
      setDraft({ ...draft, remoteDirs: draft.remoteDirs.slice(0, -1) });
      return;
    }
    if (key.upArrow) { setError(""); setTyped(""); setStep(Math.max(0, step - 1)); return; }
    if (key.downArrow) { setTyped(""); advance(); return; }
    if (fixed || locked) { if (key.return) advance(); return; }
    if (isBoolean) {
      if (input === " " || key.leftArrow || key.rightArrow) toggleBoolean();
      if (key.return) advance();
      return;
    }
    if (field.key === "auth") {
      if (key.leftArrow) cycleAuth(-1);
      if (key.rightArrow || input === " ") cycleAuth(1);
      if (key.return) advance();
      return;
    }
    // 文本字段的 Enter 由 TextInput 的 onSubmit 处理
  });

  const answeredRow = (item: FieldDef) => <Box key={item.key} height={1}>
    <Box width={2} flexShrink={0}><Text color={colors.good}>✓</Text></Box>
    <Box width={14} flexShrink={0}><Text color={colors.muted} wrap="truncate-end">{item.label}</Text></Box>
    <Box flexGrow={1} minWidth={0}><Text wrap="truncate-end" color={typeof draft[item.key] === "boolean" ? (draft[item.key] ? colors.good : colors.muted) : (fieldValue(draft, item.key) === "（未设置）" ? colors.muted : undefined)}>{fieldValue(draft, item.key)}</Text></Box>
  </Box>;
  const choices = (options: string[], selected: number) => <Text wrap="truncate-end">{options.map((label, index) => <Text key={label} color={index === selected ? colors.accent : colors.muted} bold={index === selected}>
    {index > 0 && "   "}{index === selected ? "●" : "○"} {label}
  </Text>)}</Text>;
  const current = done ? sections.length - 1 : field!.section;
  const compact = width < 76;
  const tracker = sections.map((name, index) => ({ name, index })).filter(item => !compact || item.index === current);
  const hidden = !done && step > room ? step - Math.max(0, room - 1) : 0;
  const shown = done ? [] : fields.slice(hidden, step);
  const hints: [string, string][] = enteringPassword ? [["Enter", "保存密码"], ["Esc", "返回"]]
    : done ? [["←→", "选择"], ["Enter", "确认"], ["↑", "返回修改"], ["PgUp/PgDn · Ctrl+U/D", "滚动"], ["Ctrl+S", "保存"], ["Esc", "取消"]]
      : isBoolean || isAuth ? [["←→ 空格", "切换"], ["Enter", "确认"], ["↑↓", "上一项/下一项"], ["Ctrl+S", "保存"], ["Esc", "取消"]]
        : [["Enter", "确认"], ["↑↓", "上一项/跳过"], ["Ctrl+S", "保存"], ["Esc", "取消"]];

  return <Box flexDirection="column" height={height}>
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={colors.warm}>{profile ? "编辑配置" : "新建配置"}</Text>{"   "}
        {tracker.map(({ name, index }) => <Text key={name} color={index < current ? colors.good : index === current ? colors.accent : colors.muted} bold={index === current}>
          {index > 0 && !compact ? <Text color={colors.line}>{"  ─  "}</Text> : null}{index < current ? "✓" : index === current ? "●" : "○"} {name}
        </Text>)}
      </Text>
      <Box flexShrink={0} marginLeft={2}><Text color={colors.muted}>{Math.min(step + 1, fields.length)}/{fields.length}</Text></Box>
    </Box>
    <Box flexDirection="column" marginTop={room > 0 ? 1 : 0} width={width}>
      {done
        ? <Viewport rows={fields.map(answeredRow)} height={Math.max(1, room)} offset={review.offset} />
        : <>
          {hidden > 0 && room > 0 && <Text color={colors.muted}>  ⋯ 另有 {hidden} 项已填写，↑ 回看</Text>}
          {room > 0 && shown.map(answeredRow)}
        </>}
    </Box>
    {!done && field && <Box width={width} borderStyle="round" borderColor={colors.accent} paddingX={1} flexDirection="column">
      <Box>
        <Box width={14} flexShrink={0}><Text bold color={colors.accent} wrap="truncate-end">{field.label}</Text></Box>
        <Box flexGrow={1} minWidth={0}>
          {isBoolean
            ? choices(["开启", "关闭"], draft[field.key] ? 0 : 1)
            : isAuth
              ? choices(Object.values(authNames), Object.keys(authNames).indexOf(draft.auth))
              : fixed || locked
                ? <Text wrap="truncate-end">{fieldValue(draft, field.key)} <Text color={colors.muted}>（{fixed ? "创建后固定" : "映射锁已锁定"}）</Text></Text>
                : <TextInput key={`${field.key}-${step}-${isDirs ? draft.remoteDirs.length : 0}`} defaultValue={isDirs ? "" : String(draft[field.key] || "")} onChange={isDirs ? setTyped : undefined} onSubmit={submitText} />}
        </Box>
      </Box>
      {hint.map((line, index) => <Text key={index} color={colors.muted}>{line}</Text>)}
      {isDirs && draft.remoteDirs.length > 0 && <Text color={colors.muted} wrap="truncate-end">已添加: {draft.remoteDirs.join(" · ")}</Text>}
    </Box>}
    {done && <Box width={width} borderStyle="round" borderColor={colors.accent} paddingX={1} flexDirection="column">
      <Box gap={2}>
        {actions.map((label, offset) => offset === choice
          ? <Text key={label} backgroundColor={colors.accent} color={colors.ink} bold>{`  ${label}  `}</Text>
          : <Text key={label} backgroundColor={colors.chip} color={colors.muted}>{`  ${label}  `}</Text>)}
      </Box>
      {enteringPassword && <Box><Text color={colors.accent}>密码 </Text><PasswordInput onSubmit={password => void attempt(async () => {
        const parsed = profileSchema.parse(draft);
        await savePassword(parsed, password);
        setDraft({ ...parsed, auth: "keychain" }); setEnteringPassword(false);
      })} /></Box>}
    </Box>}
    {draft.lockMapping && draft.mapping && <Text color={colors.warm} wrap="truncate-end">锁定映射：{draft.mapping.projectDir} → {draft.mapping.host}:{draft.mapping.remoteDirs.join(" · ")}</Text>}
    {error && <Text color={colors.error} wrap="truncate-end">{error}</Text>}
    <Box flexGrow={1} />
    {busy ? <Text><Spinner /> <Text color={colors.muted}>正在处理…</Text></Text> : <KeyHints items={hints} width={width} />}
  </Box>;
}
