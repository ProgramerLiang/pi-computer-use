"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createRuntime,
  toolScreenshot,
  toolMouseMove,
  toolMouseClick,
  toolMouseScroll,
  toolTypeText,
  toolScreenInfo,
} = require("../lib/tools.js");

// 1x1 透明 PNG：假后端往盘上写它，用来验证「截图 → 读尺寸 → 内联 base64」整条链路
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AH+iVBmAAAAAElFTkSuQmCC",
  "base64"
);

/** 把 IHDR 的宽高改成任意值。pngSize() 只读文件头，够用。 */
function pngWithSize(width, height) {
  const buf = Buffer.from(PNG_1X1);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const WAYLAND = {
  type: "wayland",
  waylandDisplay: "wayland-1",
  x11Display: ":1",
  xdgRuntimeDir: "/run/user/1000",
  evidence: ["XDG_SESSION_TYPE=wayland"],
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cu-test-"));
}

/**
 * 假下巴：把 PNG 落到命令最后一个参数指向的路径，其它命令只记录 argv。
 * 这样整个截图/输入链路都能被测到，又不碰真实桌面。
 */
function fakeRun(png = pngWithSize(1920, 1080)) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const target = argv[argv.length - 1];
    if (typeof target === "string" && target.endsWith(".png")) {
      const geometryIndex = argv.indexOf("-g");
      const geometry = geometryIndex >= 0 ? argv[geometryIndex + 1].match(/ (\d+)x(\d+)$/) : null;
      fs.writeFileSync(target, geometry ? pngWithSize(Number(geometry[1]), Number(geometry[2])) : png);
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

function waylandRuntime(overrides = {}) {
  const dir = tmpDir();
  return createRuntime({
    env: { XDG_RUNTIME_DIR: dir },
    environment: {
      session: WAYLAND,
      input: { kind: "ydotool", bin: "/usr/bin/ydotool", note: "ydotool（Wayland）" },
      screenshot: { kind: "grim", bin: "/usr/bin/grim", note: "grim（Wayland）" },
    },
    run: fakeRun(),
    ...overrides,
  });
}

/* --------------------------------------------------------------- 截图 */

test("截图：保存 PNG、返回路径与尺寸、并内联图片数据", async () => {
  const dir = tmpDir();
  const rt = waylandRuntime({ run: fakeRun() });
  const out = await toolScreenshot(rt, { dir, label: "unit" });

  assert.equal(out.ok, true);
  assert.match(out.path, /shot-unit-.*\.png$/);
  assert.equal(out.backend, "grim");
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mimeType, "image/png");
  assert.ok(out.images[0].data.length > 0);
  assert.ok(fs.existsSync(out.path));
});

test("截图：区域会裁剪成 grim 的 -g 几何语法", async () => {
  const run = fakeRun();
  const rt = waylandRuntime({ run });
  await toolScreenshot(rt, { dir: tmpDir(), region: { x: 10, y: 20, width: 300, height: 200 } });
  assert.deepEqual(run.calls.at(-1).slice(1, 3), ["-g", "10,20 300x200"]);
});

test("截图：grim 接收逻辑区域，输出 PNG 按 scale 呈现物理像素", async () => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const geometry = argv[0] === "/usr/bin/grim" && argv.includes("-g") ? argv[argv.indexOf("-g") + 1].match(/ (\d+)x(\d+)$/) : null;
    fs.writeFileSync(argv.at(-1), geometry ? pngWithSize(Number(geometry[1]), Number(geometry[2])) : pngWithSize(1920, 1080));
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };
  const rt = waylandRuntime({ run });
  const out = await toolScreenshot(rt, { dir: tmpDir(), region: { x: 10, y: 20, width: 300, height: 200 } });
  assert.deepEqual(calls.at(-1).slice(1, 3), ["-g", "10,20 300x200"]);
  assert.deepEqual([out.width, out.height], [300, 200]);
});
test("截图：inline=false 时只给路径，不带图片数据", async () => {
  const rt = waylandRuntime();
  const out = await toolScreenshot(rt, { dir: tmpDir(), inline: false });
  assert.equal(out.ok, true);
  assert.equal(out.images, undefined);
});

test("截图：没有截图后端时返回结构化错误而不是崩溃", async () => {
  const rt = createRuntime({
    environment: {
      session: WAYLAND,
      input: { kind: "ydotool", bin: "/usr/bin/ydotool" },
      screenshot: {
        kind: null,
        reason: "no_screenshot_backend",
        message: "Wayland 会话下没有 grim，无法截图。",
        hint: "pacman -S grim",
      },
    },
    run: fakeRun(),
  });
  await assert.rejects(
    () => toolScreenshot(rt, { dir: tmpDir() }),
    (err) => err.code === "no_screenshot_backend" && /grim/.test(err.message)
  );
});

test("截图：区域参数非整数时明确报错", async () => {
  const rt = waylandRuntime();
  await assert.rejects(
    () => toolScreenshot(rt, { dir: tmpDir(), region: { x: 0, y: 0, width: 1.5, height: 10 } }),
    /region\.width 必须是整数/
  );
});

/* --------------------------------------------------------------- 鼠标 */

test("鼠标移动：发出 ydotool 绝对移动；越界坐标被拦", async () => {
  const run = fakeRun();
  const rt = waylandRuntime({ run });
  const ok = await toolMouseMove(rt, { x: 10, y: 20 });
  assert.equal(ok.ok, true);
  assert.equal(ok.action, "mouse_move");
  assert.deepEqual(run.calls.at(-1), ["/usr/bin/ydotool", "mousemove", "--absolute", "-x", "10", "-y", "20"]);

  await assert.rejects(
    () => toolMouseMove(rt, { x: 5000, y: 5000 }),
    (err) => err.code === "coordinate_out_of_bounds"
  );
});

test("鼠标移动：负数与非整数坐标被拒", async () => {
  const rt = waylandRuntime();
  await assert.rejects(
    () => toolMouseMove(rt, { x: -1, y: 0 }),
    (err) => err.code === "invalid_coordinate"
  );
  await assert.rejects(
    () => toolMouseMove(rt, { x: 1.2, y: 0 }),
    (err) => err.code === "invalid_coordinate"
  );
});

test("点击：只给 x 不给 y 被拒", async () => {
  const rt = waylandRuntime();
  await assert.rejects(
    () => toolMouseClick(rt, { x: 1 }),
    (err) => err.code === "invalid_coordinate" && /同时给 y/.test(err.message)
  );
});

test("点击：双击发两条 ydotool click，右键用 0xC1", async () => {
  const run = fakeRun();
  const rt = waylandRuntime({ run });
  const out = await toolMouseClick(rt, { button: "right", count: 2 });
  assert.equal(out.ok, true);
  const clicks = run.calls.filter((c) => c[1] === "click");
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks[0], ["/usr/bin/ydotool", "click", "0xC1"]);
});

test("Wayland 滚轮：返回 unsupported_on_backend 而不是假成功", async () => {
  const rt = waylandRuntime();
  await assert.rejects(
    () => toolMouseScroll(rt, { direction: "down" }),
    (err) => err.code === "unsupported_on_backend" && Boolean(err.hint)
  );
});

/* --------------------------------------------------------------- 键盘 */

test("输入文本：空字符串被拒；Wayland 未验证送达时明确失败", async () => {
  const run = fakeRun();
  const rt = waylandRuntime({ run });
  await assert.rejects(() => toolTypeText(rt, { text: "" }), /text/);
  await assert.rejects(
    () => toolTypeText(rt, { text: "hello world" }),
    (err) => err.code === "input_not_delivered"
  );
  assert.equal(run.calls.length, 0);
});

test("Wayland typing and keypress fail explicitly until client delivery is verified", async () => {
  const run = fakeRun();
  const rt = waylandRuntime({ run });
  for (const action of [
    () => toolTypeText(rt, { text: "probe" }),
    () => require("../lib/tools.js").toolKeyPress(rt, { key: "ctrl+c" }),
  ]) {
    await assert.rejects(action, (err) => err.code === "input_not_delivered");
  }
  assert.equal(run.calls.length, 0);
});

/* --------------------------------------------------------------- 错误分支 */

test("没有输入后端时，每个输入工具都返回同一个明确错误", async () => {
  const rt = createRuntime({
    environment: {
      session: WAYLAND,
      input: {
        kind: null,
        reason: "no_input_backend",
        message: "Wayland 会话下既没有 ydotool 也没有 wtype，无法注入任何输入。",
        hint: "pacman -S ydotool",
      },
      screenshot: { kind: "grim", bin: "/usr/bin/grim" },
    },
    run: fakeRun(),
  });
  const calls = [
    () => toolMouseMove(rt, { x: 0, y: 0 }),
    () => toolMouseClick(rt, {}),
    () => toolTypeText(rt, { text: "x" }),
    () => toolMouseScroll(rt, { direction: "down" }),
  ];
  for (const call of calls) {
    await assert.rejects(
      call,
      (err) => err.code === "no_input_backend" && /ydotool/.test(err.message)
    );
  }
});

test("命令失败时把 stderr 带出来，而不是静默成功", async () => {
  const rt = waylandRuntime({
    run: () => ({ ok: false, status: 1, stdout: "", stderr: "failed to connect to socket" }),
  });
  await assert.rejects(
    () => toolMouseMove(rt, { x: 0, y: 0 }),
    (err) => err.code === "command_failed" && /failed to connect/.test(err.message)
  );
});

/* --------------------------------------------------------------- 只读探测 */

test("screen_info：报告会话类型、屏幕尺寸与依赖安装情况", async () => {
  const rt = waylandRuntime({
    which: (bin) => (bin === "grim" ? "/usr/bin/grim" : null),
    environment: {
      session: WAYLAND,
      input: { kind: "ydotool", bin: "/usr/bin/ydotool", note: "ydotool（Wayland）" },
      screenshot: { kind: "grim", bin: "/usr/bin/grim", note: "grim（Wayland）" },
    },
    env: { XDG_SESSION_TYPE: "wayland", PATH: "/nonexistent" },
  });
  const out = await toolScreenInfo(rt);
  assert.equal(out.ok, true);
  assert.equal(out.sessionType, "wayland");
  assert.deepEqual(out.screen, { width: 1920, height: 1080 });
  assert.equal(out.screenshotBackend, "grim");
  assert.equal(out.inputBackend, "ydotool");
  assert.equal(out.deps.grim, false);
  assert.equal(out.deps.ydotool, false);
});
