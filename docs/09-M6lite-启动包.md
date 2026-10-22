# 09 · M6-lite 最小可启动包

> 日期：2026-10-22  
> 结论：**`E:\agent` 现在可以直接启动**，无需目标电脑安装 Node。功能版本为 **M5**（扩展机制已并入）。

---

## 1. 装配内容

| 路径 | 内容 | 大小 |
|---|---|---|
| `agent.cmd` | 启动器（CRLF、ASCII、`%~dp0`、TEMP 重定向） | < 1 KB |
| `runtime\win-x64\node.exe` | Node.js **v24.18.0** 便携版 | 88.25 MB |
| `runtime\win-x64\LICENSE` | Node 许可证 | 0.15 MB |
| `app\dist\cli.js` | PocketAgent 单文件 bundle（M5） | 3.93 MB |
| `app\package.json` | `{"type":"module"}`（必需，否则 `.js` 会按 CommonJS 解析） | < 1 KB |
| `VERSION.json` | 版本与运行时信息 | < 1 KB |

总计：**27 个文件 / 92.46 MB**（含升级脚本、验收文档与交付总结；不含用户数据与会话）。

Node 便携包来源：npmmirror 镜像 `node-v24.18.0-win-x64.zip`，SHA256 校验通过：

```text
0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821
```

---

## 2. 启动方式

### 2.1 在项目目录启动（推荐）

在目标项目的终端中执行：

```powershell
E:\agent\agent.cmd
```

工作目录就是当前项目目录，Agent 会在该项目内读写与执行。

### 2.2 双击启动

双击 `agent.cmd` 会以 **U 盘根目录**为工作目录进入 TUI，适合临时对话。
切换盘符（E: → F:）不影响启动，启动器全部使用相对路径。

### 2.3 其他模式

```powershell
E:\agent\agent.cmd --plain           # 行式交互（终端不支持 TUI 时自动回退）
E:\agent\agent.cmd -p "问题"          # headless 单次输出
E:\agent\agent.cmd -p -               # 从 stdin 读取
E:\agent\agent.cmd --check            # 自检
E:\agent\agent.cmd --continue         # 恢复当前目录最近会话
```

---

## 3. 验证证据（本次实测）

| 项目 | 结果 |
|---|---|
| `agent.cmd --version` | `PocketAgent 0.1.0`，exit 0 |
| `agent.cmd --check` | exit 0；内置运行时“存在”；DeepSeek Key 已配置 |
| 真实 DeepSeek（经启动器） | 输出 `USB_OK`，exit 0，约 1.1 秒 |
| stdin 模式 | 输出 `STDIN_OK`，exit 0 |
| plain 模式 | 正常显示 Provider/权限并退出，exit 0 |
| 文件数 / 体积 | 27 个文件 / 92.46 MB |

启动器内容（逐字）：

```bat
@echo off
setlocal
set "AGENT_ROOT=%~dp0"
set "TEMP=%AGENT_ROOT%data\tmp"
set "TMP=%AGENT_ROOT%data\tmp"
if not exist "%AGENT_ROOT%data\tmp" mkdir "%AGENT_ROOT%data\tmp"
"%AGENT_ROOT%runtime\win-x64\node.exe" "%AGENT_ROOT%app\dist\cli.js" %*
exit /b %ERRORLEVEL%
```

---

## 4. 尚未包含（与完整 M6 的差距）

| 项目 | 状态 | 说明 |
|---|---|---|
| ripgrep | ❌ 未内置 | GitHub 直连被重置，可信镜像无该文件；`Grep` 自动使用 JS 回退（上限 5000 文件 / 单文件 1MB） |
| TUI 人工按键验收 | ⏳ 待用户 | 当前环境无交互终端；请双击或在 Windows Terminal 运行实测 |
| 干净 Windows 虚拟机验收 | ⏳ 未做 | 需验证无 Node、无 Git、标准用户环境 |
| 换盘符实测 | ⏳ 未做 | 代码已盘符无关，但未实际改盘符测试 |
| C 盘写入检查 | ⏳ 未做 | 启动器已重定向 TEMP/TMP，仍需 Process Monitor 验证 |
| 升级脚本 / 备份 | ⏳ 未做 | 完整 M6 内容 |
| 体积 / 启动性能基准 | ⏳ 未做 | 当前冷启动未计时 |

---

## 5. 安全提醒

- DeepSeek API Key 以明文保存在 `E:\agent\config\secrets.json`；U 盘遗失即密钥暴露。
- 不要把整个 `E:\agent` 上传到网盘或 Git 仓库。
- 建议在完整 M6 中启用口令加密（架构文档已预留方案）。

---

## 6. 后续

- 继续 **M5**（MCP / Skills / Subagents / 自定义命令 / Hooks）；
- M5 完成后重新构建并覆盖 `app\dist\cli.js` 即可，运行时与启动器无需改动；
- 最后再做完整 M6：干净机器验收、换盘符、C 盘写入检查、升级脚本、ripgrep 装配。
