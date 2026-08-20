# herdr-gui 使用说明

herdr-gui 是 Herdr 的 Web 图形界面。它启动一个本地 bridge 服务，在浏览器里展示 workspace、worktree、terminal 和 agent 状态。
需要后台常驻时，直接查看 [使用用户服务管理](#使用用户服务管理)。

## 前置条件

- 已安装并启动 Herdr。
- 本机默认 Herdr socket 存在于 `~/.config/herdr/herdr.sock`。
- 如果使用源码开发，需要安装 Bun。
- 如果使用 standalone binary，不需要在目标机器安装 Bun。

## 安装和更新

当前 Linux 和 macOS 的 x86-64、arm64 版本通过 GitHub Releases 发布：

```text
https://github.com/powerfooI/herdr-gui/releases
```

推荐普通用户安装到 `~/.local/bin`。安装脚本会自动选择当前系统架构对应的包，
并在安装前校验发布归档对应的 SHA-256 文件：

```bash
curl -fsSL "https://github.com/powerfooI/herdr-gui/releases/latest/download/install-herdr-gui.sh" | bash
```

确认 `~/.local/bin` 在 `PATH` 里：

```bash
echo "$PATH" | tr ':' '\n' | grep -Fx "$HOME/.local/bin" \
  || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

重新打开 shell 后可以直接运行：

```bash
herdr-gui --help
herdr-gui
```

如果要安装到系统路径，使用：

```bash
curl -fsSL "https://github.com/powerfooI/herdr-gui/releases/latest/download/install-herdr-gui.sh" \
  | sudo env HERDR_GUI_INSTALL_DIR=/usr/local/bin bash
```

### 安装固定版本

不设置版本时会安装 latest 包。如果希望安装固定版本：

```bash
curl -fsSL "https://github.com/powerfooI/herdr-gui/releases/latest/download/install-herdr-gui.sh" \
  | HERDR_GUI_VERSION=0.2.16 bash
```

可以通过 `HERDR_GUI_INSTALL_DIR` 修改安装目录，通过
`HERDR_GUI_RELEASE_BASE_URL` 使用其他平铺发布镜像。发布镜像必须使用 HTTPS；
仅绑定在本机 loopback 的测试镜像可以使用 HTTP。URL 不可包含凭据、query 或
fragment。覆盖已有安装时，安装脚本和应用内更新都会把原 binary 保留为同目录下的
`herdr-gui.previous`，便于新版本无法启动时手动恢复。

### 旧版本更新

旧版本用户直接重新执行安装命令即可覆盖旧 binary。推荐先停止正在运行的 herdr-gui：

```bash
pkill -f 'herdr-gui' || true
```

然后更新到最新版本：

```bash
curl -fsSL "https://github.com/powerfooI/herdr-gui/releases/latest/download/install-herdr-gui.sh" | bash
```

如果之前安装在 `/usr/local/bin`：

```bash
curl -fsSL "https://github.com/powerfooI/herdr-gui/releases/latest/download/install-herdr-gui.sh" \
  | sudo env HERDR_GUI_INSTALL_DIR=/usr/local/bin bash
```

## 快速启动

使用已构建好的 standalone binary：

```bash
./server/herdr-gui
```

启动后终端会打印访问地址，默认是：

```text
http://127.0.0.1:8787
```

然后用浏览器打开该地址。

如果 binary 已经复制到其他位置：

```bash
./herdr-gui
```

## 监听端口和地址

默认只监听本机：

```bash
./herdr-gui --host 127.0.0.1 --port 8787
```

如果希望局域网内手机或其他设备访问，监听 `0.0.0.0`：

```bash
./herdr-gui --host 0.0.0.0 --port 8781
```

未设置密码时，herdr-gui 会把随机 token 保存在权限为 `0600` 的
`~/.config/herdr-gui/auth-token`，并打印带 token 的内网访问地址，例如：

```text
http://192.0.2.23:8781/?token=<token>
```

在手机浏览器中打开即可自动登录。登录成功后地址栏中的 token 会立即被移除，
后续使用 HttpOnly session cookie。也可以通过 `--password` 或
`HERDR_GUI_PASSWORD` 设置固定密码，继续使用登录页面。需要轮换随机 token
时，先停止服务，删除 `~/.config/herdr-gui/auth-token`，然后重新启动。

## 多连接与远程 Herdr

标题旁的连接选择器可以添加、测试、连接、断开、编辑和删除 Herdr server。
Profile 由同一个 bridge 的所有已认证浏览器共享，但每个浏览器独立选择当前展示的
连接。Local profile 只附着已经存在的 Unix socket，不会启动 Herdr。创建首个
profile 时，默认本地 server 会以可写的 `Local` profile 保留在列表中，而不是被
移除。

SSH profile 要求远端 Herdr server 已经运行，并填写 OpenSSH Host alias 或
`user@host`。远端 control/render socket 路径可留空：herdr-gui 会在连接时通过
SSH 解析远端 home 目录下的默认 socket（`~/.config/herdr/herdr.sock` 与
`~/.config/herdr/herdr-client.sock`）。例如：

```text
SSH destination: devbox
Control socket: （留空自动推断）
Render socket:  （留空自动推断）
```

端口、跳板机和 identity 等连接参数应放在 `~/.ssh/config`：

```sshconfig
Host devbox
  HostName example.com
  User dev
  Port 2222
```

herdr-gui 使用正常的 OpenSSH host-key 和 ssh-agent/系统 Keychain 策略，不保存
密码、私钥、passphrase 或任意 SSH options。每个 SSH profile 使用独立 tunnel；
bridge 会监督 tunnel，并只对临时 transport failure 执行有界重试。

连接 profile 以私有目录和文件权限原子保存在
`~/.config/herdr-gui/connections.json`。如果进程启动时显式传入旧式 CLI/env
连接设置，该 legacy process default 仍然可用，但在连接管理器中只读。

连接选择器支持键盘操作：先用 `Tab` 聚焦，按 `Enter`、`Space`、`↑` 或 `↓`
打开，再用方向键、`Home` 和 `End` 选择。目前没有全局的上一个/下一个连接快捷键。

旧式单远端启动方式仍然兼容：

```bash
./herdr-gui --ssh-host devbox
```

浏览器仍访问本机 herdr-gui，实际操作远端 Herdr。如果需要手动指定单连接 socket：

```bash
./herdr-gui \
  --socket-path /path/to/herdr.sock \
  --client-socket-path /path/to/herdr-client.sock
```

## 常用参数

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--host <addr>` | `HOST` | 监听地址，默认 `127.0.0.1` |
| `--port <n>` | `PORT` | 监听端口，默认 `8787` |
| `--password <pw>` | `HERDR_GUI_PASSWORD` | 可选固定密码；非 localhost 默认生成 token |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Herdr control socket |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Herdr terminal render socket |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | 通过 SSH 连接远程 Herdr |
| `--session <name>` | `HERDR_SESSION` | 指定 Herdr session |
| `--public-dir <path>` | `PUBLIC_DIR` | 使用外部静态资源目录 |
| `--open` | `OPEN_BROWSER=1` | 启动后自动打开浏览器 |
| `--help` | - | 查看命令帮助 |

更新相关环境变量：

- `HERDR_GUI_UPDATE_BASE_URL`：覆盖 latest 发布资产所在目录。自定义镜像必须以
  flat layout 提供各平台归档、`.sha256` 和对应的
  `herdr-gui-<platform>.update.json` 元数据；除本机 loopback HTTP 镜像外必须使用
  HTTPS，且 URL 不可包含凭据、query 或 fragment。
- `HERDR_GUI_DISABLE_UPDATE_CHECK=1`：关闭更新检查。
- `HERDR_GUI_RESTART_SUPERVISOR=0|1`：覆盖 systemd/launchd 自动识别结果。
  对无法自动识别的外部 supervisor，设置为 `1` 后才允许应用内更新。

示例：

```bash
HERDR_GUI_PASSWORD='your-password' ./herdr-gui --host 0.0.0.0 --port 8781
```

## 使用用户服务管理

standalone binary 可以直接安装并管理当前平台的用户服务：

```bash
herdr-gui service install
herdr-gui service status
herdr-gui service restart
herdr-gui service reload
herdr-gui service uninstall
```

命令行为：

| 命令 | 作用 |
| --- | --- |
| `service install` | 创建或更新当前平台的用户服务定义，随后启动服务 |
| `service install --force` | 强制替换不是由 herdr-gui 生成的同名服务定义 |
| `service status` | 展示 systemd 或 launchd 返回的当前服务状态 |
| `service restart` | 重启进程；修改 `herdr-gui.env` 后使用此命令 |
| `service reload` | 让服务管理器重新读取 unit/plist，然后重启进程 |
| `service uninstall` | 停止服务并删除服务定义，但保留环境配置和登录 token |

`service install` 仅支持 standalone binary，不能从 `bun run` 的开发进程中
安装。它会根据平台生成以下文件：

| 用途 | Linux | macOS |
| --- | --- | --- |
| 服务定义 | `~/.config/systemd/user/herdr-gui.service` | `~/Library/LaunchAgents/dev.herdr.herdr-gui.plist` |
| 环境配置 | `~/.config/herdr-gui/herdr-gui.env` | `~/.config/herdr-gui/herdr-gui.env` |
| 登录 token | `~/.config/herdr-gui/auth-token` | `~/.config/herdr-gui/auth-token` |

Linux 自动使用 systemd user service，macOS 自动使用 launchd LaunchAgent。
`install` 会默认监听 `0.0.0.0:8787`，创建持久化随机 token，打印带
`?token=...` 的 localhost 和内网访问地址，然后启动服务。首次运行会创建权限为
`0600` 的 `~/.config/herdr-gui/herdr-gui.env`；token 单独保存在权限同样为
`0600` 的 `~/.config/herdr-gui/auth-token`。重新安装和卸载均保留环境文件。
修改配置后运行 `herdr-gui service restart`。命令不会覆盖非 herdr-gui 生成的
service 定义，确实需要替换时使用
`herdr-gui service install --force`。
修改 systemd unit 或 launchd plist 后运行 `herdr-gui service reload`，该命令
会让服务管理器重新读取 definition 并重启进程。

仓库中的 [`deploy/systemd/herdr-gui.service`](deploy/systemd/herdr-gui.service)
是一个 systemd user service 示例。它使用 `Restart=always` 管理进程。herdr-gui
会通过 systemd 注入的 `INVOCATION_ID` 自动识别 supervisor，因此应用内更新只
负责替换 binary 和退出，随后由 systemd 启动新版本，不会额外创建脱离 systemd
管理的进程。

安装 unit 和配置文件：

```bash
mkdir -p ~/.config/systemd/user ~/.config/herdr-gui
cp deploy/systemd/herdr-gui.service ~/.config/systemd/user/
cp deploy/herdr-gui.env.example ~/.config/herdr-gui/herdr-gui.env
chmod 600 ~/.config/herdr-gui/herdr-gui.env
${EDITOR:-vi} ~/.config/herdr-gui/herdr-gui.env
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now herdr-gui.service
```

如需固定密码，应通过 `HERDR_GUI_PASSWORD` 写入上述环境文件，不要放在
`ExecStart` 或命令行参数里，否则会显示在 `ps` 和 systemd 状态中。未设置时，
非 localhost 服务会使用持久化的随机 token。linger 使 user service 在退出
SSH 后继续运行，并在机器启动后由 user manager 拉起。

查看状态和日志：

```bash
systemctl --user status herdr-gui.service
journalctl --user -u herdr-gui.service -f
curl -fsS http://127.0.0.1:8787/healthz
```

修改环境文件后重启服务：

```bash
systemctl --user restart herdr-gui.service
```

确认配置是否生效：

```bash
systemctl --user show herdr-gui.service \
  -p ActiveState -p SubState -p MainPID -p Restart -p UnitFileState
systemctl --user cat herdr-gui.service
loginctl show-user "$USER" -p Linger
stat -c '%a %n' ~/.config/herdr-gui/herdr-gui.env
```

### 通过自定义 wrapper 启动

如果部署环境必须通过额外的进程包装器启动 herdr-gui，可以使用
`systemctl --user edit herdr-gui.service` 覆盖 `ExecStart`。包装器和
herdr-gui 都应使用绝对路径，并且最终仍由 systemd 负责进程重启。只要自定义
`ExecStart` 继续调用当前的 herdr-gui binary，后续执行
`herdr-gui service install` 会保留该命令，同时更新 unit 的其他标准配置。

## 使用 launchd 管理 macOS 进程

macOS 可以使用仓库中的
[`deploy/launchd/dev.herdr.herdr-gui.plist`](deploy/launchd/dev.herdr.herdr-gui.plist)
创建用户级 LaunchAgent。它使用 `KeepAlive` 管理进程。herdr-gui 会通过
plist 中的 `HERDR_GUI_RESTART_SUPERVISOR=1` 明确识别 supervisor；应用内更新
完成后，launchd 会重新启动新 binary。

创建配置并安装 plist：

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs ~/.config/herdr-gui
cp deploy/herdr-gui.env.example ~/.config/herdr-gui/herdr-gui.env
chmod 600 ~/.config/herdr-gui/herdr-gui.env
sed "s|__HOME__|$HOME|g" \
  deploy/launchd/dev.herdr.herdr-gui.plist \
  > ~/Library/LaunchAgents/dev.herdr.herdr-gui.plist
plutil -lint ~/Library/LaunchAgents/dev.herdr.herdr-gui.plist
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/dev.herdr.herdr-gui.plist
```

查看状态和日志：

```bash
launchctl print "gui/$(id -u)/dev.herdr.herdr-gui"
tail -F ~/Library/Logs/herdr-gui.stdout.log \
  ~/Library/Logs/herdr-gui.stderr.log
```

修改环境文件后重启：

```bash
launchctl kickstart -k "gui/$(id -u)/dev.herdr.herdr-gui"
```

卸载 LaunchAgent：

```bash
launchctl bootout "gui/$(id -u)/dev.herdr.herdr-gui"
```

## 界面使用

左侧是 workspace 列表。点击 workspace 会切换当前 workspace。

点击 workspace 面板右上角的 `+` 可以创建 workspace。创建时可以填写：

- `Name`：workspace 名称，可选。
- `CWD`：工作目录，可选。

在 workspace 上右键可以打开菜单：

- `Pin workspace` / `Pin worktree`：把 workspace 或 linked worktree 置顶；
  置顶的 linked worktree 会脱离原仓库分组，作为独立项目显示在列表顶部。再次打开
  菜单取消置顶后，它会回到原 parent workspace 下。配置保存在当前浏览器中。
- linked worktree 会显示紧凑的分支图标；置顶并脱离原分组后会展开为 `WT`
  标记。如果 workspace 名称与 Git branch 完全相同，则不再重复显示 branch
  标签。
- 有 linked worktree 的主 workspace 左侧会显示箭头；点击可以折叠或展开同组
  worktree，折叠状态也保存在当前浏览器中。
- `New worktree...`：从主 checkout 创建新 worktree。
- `Rename workspace...`：重命名 workspace。
- `Remove worktree`：移除 linked worktree。
- `Close workspace`：关闭 workspace。

顶部右侧的 `Menu` 用来查看和修改配置，包括：

- 明暗主题、强调色和任务完成通知。
- 移动端 terminal 快捷键和自动 branch 更新。
- Changelog、键盘快捷键和 herdr-gui 更新。
- 当前连接状态、client 数量、访问 URL、Herdr socket、server 版本和协议。
- 暂停或恢复当前 client，以及暂停其他已连接 client。

Worktree Hooks 属于仓库配置，请从 workspace 右键菜单、命令菜单或
`Worktree Lifecycle` 打开。

## Terminal

terminal 区域支持鼠标滚轮和触摸滑动。移动端默认显示两行对齐的快捷键，包含
`Ctrl+C`、`Ctrl+D`、`Ctrl+R`、`Esc`、`Tab`、`Enter`、`Alt+Up`、
`Page Up` 和 `Page Down`。

打开顶部 `Menu`，选择 `Mobile terminal shortcuts` 可以自定义快捷键阵列：

- 固定显示 `2×8` 个可配置槽位；点击已有按钮可以修改，点击空的 `+`
  槽位可以直接在该位置添加按钮。
- 可以修改按钮文字和动作；`Page Up` / `Page Down` 浏览一整页终端历史，
  `Alt+Page Up` / `Alt+Page Down` 浏览半页终端历史，其他按键会发送给
  shell 或 TUI。
- 清空槽位不会挤压编辑器里的其他按钮，所选位置会原样保存；终端快捷键
  悬浮框会自动忽略空槽位并紧凑显示非空按钮。
- 两行使用相同宽度的网格列；内容较多时可以横向滚动。
- 还可以配置最多四个纵向侧边按钮，显示在原 `Up` / `Dn` 所在的终端
  右侧位置；默认均为空，空槽位不会显示。
- 两组配置都保存在当前浏览器中，不会修改 Herdr server 配置。

如果移动端没有系统 Nerd Font，herdr-gui 会加载内置的 glyph-only Nerd Font
子集，用来显示常见图标字符。

## Worktree Hooks

herdr-gui 直接读取仓库里的 Paseo `paseo.json`，不会生成 Herdr plugin，也不会在
界面中修改 hook 命令。Hook 对每个仓库默认启用；可以从 workspace 右键菜单选择
`Worktree hooks...`，或在 `Worktree Lifecycle` 中打开 `Hook details`，查看当前
仓库检测到的配置并按仓库禁用或重新启用。完整功能说明见
[FEATURES.md](./FEATURES.md#paseo-worktree-hooks)。

示例：

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

当前支持四个 Paseo hook：

| Hook | 执行时机 | 工作目录 |
| --- | --- | --- |
| `setup` | 新 linked worktree 创建并打开之后 | 新 worktree |
| `opened` | 已有 linked worktree 打开之后 | 打开的 worktree |
| `teardown` | 删除 linked worktree 之前 | 即将删除的 worktree |
| `removed` | 删除完成之后 | source checkout |

命令通过 `sh -c` 执行，可以使用普通 shell 语法。`setup`、`opened` 和
`teardown` 会先读取目标 checkout 的 `paseo.json`；只有目标中不存在该文件时，
才回退到 source checkout。命令可以使用以下环境变量：

- `PASEO_HOOK`
- `PASEO_CHECKOUT_PATH`
- `PASEO_SOURCE_CHECKOUT_PATH`
- `HERDR_GUI_HOOK_EVENT`
- `HERDR_GUI_HOOK_CHECKOUT_PATH`
- `HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH`

操作通知会展示 hook 结果和长度受限的诊断信息；失败时可能包含 exit code、
stderr 或 error。`teardown` 失败时会停止删除，修复命令或临时禁用该仓库的 hook
后才能重试。其他 hook 不会回滚已经完成的生命周期操作：`setup` 或 `opened`
失败不会撤销创建/打开，`removed` 失败也无法恢复已删除的 worktree。

如果使用 `--ssh-host`，`paseo.json` 会从远程仓库读取，hook 也在远程机器执行。
Hook 属于受信任的仓库代码，不会运行在 sandbox 中；执行 worktree 操作前应先检查
仓库的 `paseo.json`。

## 开发模式

源码开发时需要两个进程：

```bash
bun run dev:server
```

另一个终端：

```bash
bun run dev:web
```

然后打开：

```text
http://localhost:5173
```

开发模式下，Vite 前端访问本地 bridge。

## 构建 standalone binary

构建当前平台的单文件可执行程序：

```bash
bun run build
```

产物：

```text
server/herdr-gui
```

构建 Linux x64：

```bash
bun run build:linux-x64
```

构建其他发布架构：

```bash
bun run build:linux-arm64
bun run build:darwin-x64
bun run build:darwin-arm64
```

构建多个平台：

```bash
bun run build:all
```

注意：standalone binary 会包含 Bun runtime 和前端资源，因此文件较大。发布时建议压缩成 `.tar.xz` 或 `.zip`。

## 清理构建产物

清理前端 dist、嵌入生成文件、standalone binary 和 Bun 临时文件：

```bash
bun run clean
```

如果只在 `server` 目录清理：

```bash
cd server
bun run clean
```

## 常见问题

### 打开后连接不上 Herdr

确认 Herdr 正在运行，并且 socket 路径正确：

```bash
ls ~/.config/herdr/herdr.sock
```

如果 socket 不在默认位置，用：

```bash
./herdr-gui --socket-path /path/to/herdr.sock
```

### 手机访问不了

确认启动时使用了 `0.0.0.0`，然后打开启动日志打印的带 token 地址：

```bash
./herdr-gui --host 0.0.0.0 --port 8781
```

同时确认手机和电脑在同一个网络，防火墙没有拦截该端口。

### `--ssh-host` 后连接的不是远程 Herdr

确认命令里没有同时传入本地 `--socket-path` 或 `HERDR_SOCKET_PATH`。显式 socket path 会覆盖自动 SSH tunnel。

推荐只使用：

```bash
./herdr-gui --ssh-host user@host
```

### 想让启动时自动打开浏览器

默认不会自动打开浏览器。需要显式传：

```bash
./herdr-gui --open
```

或者：

```bash
OPEN_BROWSER=1 ./herdr-gui
```
