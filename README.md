# PocketAgent · 源码工作区

U 盘交付物位于 `E:\agent`；仓库内 `docs/` 是项目文档副本，交付版位于 `E:\agent\docs`。

- 当前进度：**M6 验收通过，TUI 实测通过，v1 候选**（`E:\agent` 可直接启动）
- 目标平台：Windows x64（架构预留 Linux/macOS）
- 运行时：Node.js 24（开发期使用系统 Node；交付期内置便携版）

## 开发命令

```bash
npm install          # 依赖安装（缓存已重定向到项目 .npm-cache）
npm run dev -- -p "你好"   # 开发态直接跑 TS
npm test             # 单元/集成测试（Vitest）
npm run typecheck    # 类型检查
npm run lint         # Biome 检查
npm run format       # Biome 格式化
npm run build        # esbuild 打包到 dist/cli.js
npm run smoke        # 版本冒烟
npm run smoke:e2e    # 工具闭环 + 会话恢复端到端冒烟
npm run smoke:plain  # plain 交互模式端到端冒烟
npm run smoke:mcp    # 真实 stdio MCP Server 端到端冒烟
```

## 目录

```text
src/
├── cli/            # 参数解析、三模式选择、自检
├── bootstrap/      # 根路径、路径表、配置、密钥
├── core/           # 消息模型、执行内核、系统提示、上下文压缩
├── runtime/        # SessionRuntime（headless/plain/TUI 共用）
├── memory/         # AGENTS.md / MEMORY.md 加载
├── extensions/     # Skills、自定义命令、Subagents、MCP、Hooks
├── providers/      # SSE、重试、模型列表、Anthropic / OpenAI 兼容适配器
├── permissions/    # 规则 DSL、权限门、项目级授权
├── session/        # JSONL 会话、压缩记录、恢复、消息重建
├── tools/          # Read/Write/Edit/Glob/Grep/Bash/Todo/Memory/Skill/Task
├── ui/             # Ink TUI、Markdown 渲染、审批队列、plain REPL
└── util/           # 错误、日志（含密钥脱敏）、文件与 Shell 抽象
tests/              # 136 个离线测试（工具/权限/会话/压缩/扩展/UI/端到端）
scripts/
├── build.mjs       # esbuild 单文件构建
└── e2e-smoke.mjs   # 本地 mock 服务端到端冒烟
```

## 配置（开发态）

首次运行会在仓库根生成：

- `config/settings.json`
- `config/providers.json`
- `config/secrets.json`（需手工创建，已被 .gitignore 忽略）

密钥也可用环境变量：

```powershell
$env:ANTHROPIC_API_KEY = "..."
$env:DEEPSEEK_API_KEY = "..."
```

环境变量优先于 `config/secrets.json`。

## 已验证

见 [`docs/12-交付总结.md`](docs/12-交付总结.md)。

## 注意

- 所有运行数据（`data/`）与配置（`config/`）都在 Agent 根内，不写用户目录。
- 开发期根目录为本仓库；打包后根目录为 `<root>\app\dist\cli.js` 的上两级，由 `resolveAgentRoot()` 通过标记文件推导。
