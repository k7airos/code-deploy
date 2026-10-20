import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { Settings } from "../src/settings.js";
import { run } from "../src/deploy.js";
import { newProfile, type Profile } from "../src/config.js";

const profile = { ...newProfile(), id: "example", name: "测试环境", host: "example.test", user: "deploy", remoteDir: "/srv/web" };

// 预检包含真实子进程，帧出现时间不定：轮询直至匹配。
const waitFor = async (instance: { lastFrame: () => string | undefined }, pattern: RegExp, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout && !pattern.test(instance.lastFrame() ?? "")) await setTimeout(50);
  assert.match(instance.lastFrame()!, pattern);
};

// 键盘驱动真实组件：纵向列表选择，向导编辑时已答项留在上方。
test("TUI 环境列表、发布默认取消和向导编辑", async () => {
  const instance = render(createElement(App, { initialConfig: { version: 1, profiles: [profile] } }));
  try {
    await setTimeout(100);
    assert.match(instance.lastFrame()!, /› 测试环境/); // 纵向列表
    assert.match(instance.lastFrame()!, /deploy@example\.test/); // 目标服务器
    assert.match(instance.lastFrame()!, /…\/srv\/web/); // 目录最后两级
    instance.stdin.write("\r"); await setTimeout(60);
    assert.match(instance.lastFrame()!, /确认发布/);
    instance.stdin.write("\r"); await setTimeout(60);
    assert.match(instance.lastFrame()!, /Enter 发布/); // 回车默认取消，回到仪表盘
    instance.stdin.write("e"); await setTimeout(60);
    assert.match(instance.lastFrame()!, /编辑配置/);
    assert.match(instance.lastFrame()!, /创建后固定/); // id 不可改，行内提示
    instance.stdin.write("\r"); await setTimeout(60); // 跳过 id → 名称
    assert.match(instance.lastFrame()!, /显示名称/);
    assert.match(instance.lastFrame()!, /环境标识\s+example/); // 已答项留在上方
  } finally { instance.unmount(); instance.cleanup(); }
});

test("向导逐项填写，回车接受默认值，Ctrl+S 统一保存", async () => {
  let saved: Profile | undefined;
  const instance = render(createElement(Settings, {
    config: { version: 1, profiles: [] },
    onSave: async value => { saved = value; }, onCancel: () => {}
  }));
  const key = async (value: string) => { instance.stdin.write(value); await setTimeout(45); };
  try {
    await setTimeout(70);
    await key("demo"); await key("\r"); // id
    await key("Demo app"); await key("\r"); // name
    assert.match(instance.lastFrame()!, /环境标识\s+demo/);
    assert.match(instance.lastFrame()!, /显示名称\s+Demo app/);
    await key("\r"); // projectDir 接受默认
    await key("example.test"); await key("\r"); // host
    await key("\r"); await key("\r"); // user、port 接受默认
    await key("/srv/demo"); await key("\r"); // remoteDir
    await key("\u0013"); // Ctrl+S，其余保持默认
    assert.equal(saved?.id, "demo", instance.lastFrame());
    assert.equal(saved?.name, "Demo app");
    assert.equal(saved?.host, "example.test");
    assert.equal(saved?.remoteDir, "/srv/demo");
    assert.equal(saved?.checkGit, true);
  } finally { instance.unmount(); instance.cleanup(); }
});

test("开关字段空格切换，登录方式方向键循环", async () => {
  let saved: Profile | undefined;
  const instance = render(createElement(Settings, {
    config: { version: 1, profiles: [profile] }, profile,
    onSave: async value => { saved = value; }, onCancel: () => {}
  }));
  const key = async (value: string) => { instance.stdin.write(value); await setTimeout(40); };
  try {
    await setTimeout(70);
    for (let i = 0; i < 13; i++) await key("\u001b[B"); // id → checkGit
    assert.match(instance.lastFrame()!, /Git 状态检查\s+开启/);
    await key(" "); // 开启 → 关闭
    assert.match(instance.lastFrame()!, /Git 状态检查\s+关闭/);
    await key("\u001b[B"); // → 登录方式
    await key("\u001b[C"); // ssh → env
    assert.match(instance.lastFrame()!, /登录方式\s+环境变量/);
    await key("\u0013");
    assert.equal(saved?.checkGit, false, instance.lastFrame());
    assert.equal(saved?.auth, "env");
  } finally { instance.unmount(); instance.cleanup(); }
});

test("TUI 显示 Git 提醒并等待选择，拒绝后结束发布", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "code-deploy-tui-git-test-"));
  const originalCwd = process.cwd();
  const instance = render(createElement(App, { initialId: profile.id, initialConfig: { version: 1, profiles: [profile] } }));
  try {
    // 用本地临时仓库代替真实仓库：预检不依赖网络 fetch，用例结果稳定。
    await run("git", ["init", "-b", "main"], { cwd: temporary });
    await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "test"], { cwd: temporary });
    process.chdir(temporary);
    await setTimeout(80);
    instance.stdin.write("\r"); await setTimeout(60);
    instance.stdin.write("y");
    await waitFor(instance, /Git 状态需要确认/);
    assert.match(instance.lastFrame()!, /尚未执行构建或上传/);
    instance.stdin.write("n");
    await waitFor(instance, /已取消发布/);
  } finally {
    instance.unmount(); instance.cleanup();
    process.chdir(originalCwd);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("发布确认屏隐藏列表、标题为发布项；d 复制当前配置进入向导", async () => {
  const other = { ...profile, id: "prod", name: "生产" };
  const instance = render(createElement(App, { initialConfig: { version: 1, profiles: [profile, other] } }));
  try {
    await setTimeout(100);
    assert.match(instance.lastFrame()!, /生产/); // 仪表盘两栏都有
    instance.stdin.write("\r"); await setTimeout(60);
    assert.match(instance.lastFrame()!, /确认发布/);
    assert.ok(!instance.lastFrame()!.includes("生产"), instance.lastFrame()); // 列表隐藏
    instance.stdin.write("\u001b"); await setTimeout(60); // 返回仪表盘
    instance.stdin.write("d"); await setTimeout(60); // 复制
    assert.match(instance.lastFrame()!, /新建配置/);
    instance.stdin.write("copy1"); await setTimeout(40);
    instance.stdin.write("\r"); await setTimeout(60); // id → 名称
    assert.match(instance.lastFrame()!, /测试环境 副本/); // 名称预填
    assert.match(instance.lastFrame()!, /环境标识\s+copy1/);
  } finally { instance.unmount(); instance.cleanup(); }
});

test("无配置时保持列表 + 预览的统一布局", async () => {
  const instance = render(createElement(App, { initialConfig: { version: 1, profiles: [] } }));
  try {
    await setTimeout(80);
    const frame = instance.lastFrame()!;
    assert.match(frame, /暂无配置/);
    assert.match(frame, /配置一次，选择发布/);
    assert.match(frame, /↑↓ 选择 · Enter 发布/);
  } finally { instance.unmount(); instance.cleanup(); }
});
