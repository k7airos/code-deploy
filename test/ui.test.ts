import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { stringWidth, truncate, wrapText } from "../src/text.js";
import { JobView, type Job } from "../src/views.js";

test("wrapText 按显示宽度折行，中文占两格，不丢内容", () => {
  const rows = wrapText("abcdefghij\n构建完成构建完成", 6);
  assert.deepEqual(rows, ["abcdef", "ghij", "构建完", "成构建", "完成"]);
  assert.ok(rows.every(row => stringWidth(row) <= 6));
  assert.deepEqual(wrapText("a\tb\u0007\n", 10), ["a  b"]); // 展开制表符、丢弃控制字符、忽略末尾换行
  assert.deepEqual(wrapText("", 10), []);
});

test("truncate 按显示宽度截断并追加省略号", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("发布失败原因很长", 7), "发布失…");
});

const job = (lines: number, status: Job["status"] = "running"): Job => ({
  kind: "deploy", title: "发布目录", step: 1, stepAt: [0, 0], status, started: Date.now(), elapsed: 1200,
  logs: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n") + "\n", error: "ssh 执行失败 (255)\nPermission denied"
});

// 高度很小时输出仍可滚动：默认跟随最新行，PgUp 回看，G 回到底部。
test("JobView 小窗口下可滚动回看输出，并常驻结果与失败原因", async () => {
  const instance = render(createElement(JobView, { job: job(50, "error"), width: 60, height: 9 }));
  try {
    await setTimeout(60);
    const frame = () => instance.lastFrame()!;
    assert.match(frame(), /line 50/); // 跟随到底部
    assert.ok(!/line 1 /.test(frame()));
    assert.match(frame(), /发布失败/); // 结果行常驻
    assert.match(frame(), /ssh 执行失败 \(255\)：Permission denied/);
    instance.stdin.write("\u001b[H"); await setTimeout(60); // Home
    assert.match(frame(), /line 1 /);
    assert.ok(!/line 50/.test(frame()));
    assert.match(frame(), /G 回到底部/);
    instance.stdin.write("\u0004"); await setTimeout(60); // Ctrl+D 翻页（Mac 键盘无 PgDn）
    assert.match(frame(), /line 6 /);
    instance.stdin.write("G"); await setTimeout(60); // 回到底部
    assert.match(frame(), /line 50/);
    assert.equal(frame().split("\n").length <= 9, true);
  } finally { instance.unmount(); instance.cleanup(); }
});
