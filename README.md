# PI Computer Use

Linux 桌面的 **computer use** 插件，给 PI-Desktop 的 agent 一套工具去截屏、移动鼠标、
点击、打字、按组合键。Wayland 走 `grim` + `ydotool`，X11 走 `import`/`scrot` + `xdotool`。

> ⚠️ **这个插件可以完全控制你的桌面。** 装上之后，agent 能在你不知情的窗口里点击、
> 打字、按快捷键（包括 `ctrl+alt+t` 开终端之类）。动作只在你（或 agent）显式调用工具时
> 发生，但请自行评估在你机器上启用它的风险。不要在工作机、生产机或有敏感凭据的会话里
> 随意开放。

## 它做什么

| 工具 | 作用 | 风险标签 |
| --- | --- | --- |
| `cu_screenshot` | 截取整屏或指定区域，存 PNG 到临时目录并返回路径，同时把图片内联给模型 | low |
| `cu_mouse_move` | 把鼠标移到绝对坐标 `(x, y)` | medium |
| `cu_mouse_click` | 点击（左/中/右，单击/双击/三击），可先移动到坐标 | medium |
| `cu_mouse_scroll` | 滚轮（**仅 X11**，见「已知限制」） | medium |
| `cu_type_text` | 把文本输入到当前焦点窗口 | medium |
| `cu_key_press` | 按组合键，如 `ctrl+c`、`ctrl+shift+t`、`Return` | medium |
| `cu_screen_info` | 只读探测：会话类型、屏幕尺寸、可用后端、依赖是否安装 | low |
| `cu_window_list` | 列出窗口（X11 用 `wmctrl`/`xdotool`；niri 下用 `niri msg`） | low |

所有工具都接受 JSON Schema 声明的参数；坐标以屏幕左上角为原点，单位像素。
`cu_screenshot` 默认内联图片（上限 6 MiB），只要路径时传 `inline: false`。

## 依赖：按会话类型分

先用 `cu_screen_info`（或 `echo $XDG_SESSION_TYPE`）确认会话类型。

### Wayland

| 能力 | 需要 | 缺失时的行为 |
| --- | --- | --- |
| 截图 | `grim`（wlroots 系：niri/sway/hyprland 均可） | 返回 `no_screenshot_backend` + 安装提示 |
| 鼠标/键盘 | `ydotool` **并且** `ydotoold` 守护进程在跑 | 返回 `ydotoold_not_running` 或 `no_input_backend` |
| 只打字（降级） | `wtype` | 鼠标/组合键返回 `unsupported_on_backend` |

```bash
# Arch
sudo pacman -S grim ydotool
systemctl --user enable --now ydotoold      # 或者：ydotoold &
# Debian/Ubuntu
sudo apt install grim ydotool
```

`ydotool` 通过 `/dev/uinput` 注入事件，需要 ydotoold 以有权限的身份运行。
插件**不会**替你提权、不会去 chmod 设备节点、不会绕过权限模型——权限没配好就直接报错。

> `xdotool` 在 Wayland 下**无效**：它只能操作 XWayland 窗口，不是全局输入注入。
> 插件因此不会在 Wayland 会话里退回去用 xdotool。

### X11

| 能力 | 需要 |
| --- | --- |
| 截图 | ImageMagick 的 `import`（首选）或 `scrot` |
| 鼠标/键盘/滚轮 | `xdotool` |
| 窗口列表 | `wmctrl`（首选）或 `xdotool` |

```bash
sudo pacman -S xdotool imagemagick wmctrl    # Arch
sudo apt install xdotool imagemagick wmctrl  # Debian/Ubuntu
```

## 错误约定

缺依赖从不静默失败，工具返回 `{ ok: false, error: { code, message, hint } }`：

| code | 含义 |
| --- | --- |
| `no_graphical_session` | 当前是 tty/SSH，没有 X11 或 Wayland |
| `no_screenshot_backend` | 缺 `grim` / `import` / `scrot` |
| `no_input_backend` | 缺 `ydotool` / `wtype` / `xdotool` |
| `ydotoold_not_running` | 装了 ydotool 但守护进程没起 |
| `unsupported_on_backend` | 当前后端做不到（Wayland 滚轮、wtype 打组合键） |
| `invalid_coordinate` | 坐标不是非负整数，或只给了 x 没给 y |
| `coordinate_out_of_bounds` | 坐标超出实际屏幕尺寸 |
| `command_failed` | 底层命令非零退出，`message` 里带 stderr 末几行 |
| `no_window_backend` | 没有可用的窗口枚举手段 |

## 已知限制（如实说明）

- **Wayland 滚轮不可用**：`ydotool` 1.x 没有 wheel 子命令。工具会返回
  `unsupported_on_backend`，而不是发一条注定失败的命令。
- **Wayland 窗口枚举不是通用能力**：协议层没有这个接口。当前只在 niri 下通过
  `niri msg --json windows` 实现；其它合成器返回 `no_window_backend`。
  插件会从 `$XDG_RUNTIME_DIR` 里自己找 `NIRI_SOCKET`，不依赖宿主环境变量。
- **没有视觉理解**：插件只负责截屏和发事件，看图是模型的事。若上游模型不支持图像输入，
  内联的截图会被上游拒绝或忽略。
- **单显示器假设**：坐标是整屏合成的绝对坐标，多显示器下需要自己换算偏移量。
- **不做 OCR、不做元素定位**：没有 accessibility tree，也没有 DOM，只有像素。

## 安全语义

- 插件加载时**不做任何事**：不截图、不注册全局热键、不起定时器、不在后台点击。
- 只有 agent（或你）显式调用 `cu_*` 工具时才会产生副作用。
- 不修改系统状态，不写注册表/配置文件，不改 `uinput` 权限。
- 唯一写入的路径是截图文件（默认 `$TMPDIR/pi-computer-use/`，可用 `PI_COMPUTER_USE_DIR` 覆盖）。
- 不联网、不引入任何 npm 依赖（零 `node_modules`）。

## 安装到 PI-Desktop

```bash
# 打包成 .piplug（用 PI-Desktop 自带工具，store-only zip）
# 然后在 设置 → 插件 里安装，并确认授予 agent.tool.register
```

插件 id：`local.pi-computer-use`，权限：`agent.tool.register`（高权限，需你显式同意）。

## 开发

```bash
node --test test/          # 40 个离线单测，不需要真实桌面
```

目录：

```
manifest.json     工具声明（schema 由 lib/tools.js 生成，避免两处漂移）
main.js           入口：注册/注销工具
lib/session.js    会话探测 + 可执行文件查找 + 子进程执行
lib/backends.js   按会话类型挑截图/输入后端，缺依赖时给明确错误
lib/keymap.js     按键名 <-> evdev keycode <-> xdotool 键名
lib/actions.js    纯函数：把意图翻译成 argv（单测主要测这一层）
lib/capture.js    截图、PNG 头解析、区域裁剪
lib/tools.js      工具 schema + execute
test/             离线单测
```

单测全部用注入的假 `run` / `which`，不碰真实桌面，可在 CI 里跑。
