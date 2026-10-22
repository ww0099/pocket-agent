# USB 发布包组装

本目录包含 U 盘发布所需的**非二进制文件**。以下内容不入库：

- `node_modules/`、`dist/`
- `app/` 构建产物（`dist/cli.js`）
- `runtime/`（Node 便携运行时）
- `config/`（含 `secrets.json`）
- `data/`、日志、会话

## 目标布局

```text
E:\agent\
├── agent.cmd
├── upgrade.cmd
├── upgrade.ps1
├── VERSION.json
├── app\
│   ├── package.json          # {"type":"module"}，必需
│   └── dist\cli.js           # npm run build 产物
├── runtime\win-x64\node.exe  # Node 24 便携版
├── tools\ripgrep\rg.exe      # 可选
├── config\ data\             # 首次运行生成
└── docs\                     # 仓库 docs/ 的副本
```

## 组装步骤

1. 构建 bundle：

   ```powershell
   npm ci
   npm run build
   ```

2. 准备 Node 便携运行时（v24.18.0 win-x64）。官方 zip 的 SHA256：

   ```text
   0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821
   ```

   解压后只需 `node.exe` 与 `LICENSE`，放到 `runtime\win-x64\`。

3. 复制文件：

   ```powershell
   Copy-Item packaging\agent.cmd        E:\agent\agent.cmd
   Copy-Item packaging\upgrade.cmd      E:\agent\upgrade.cmd
   Copy-Item packaging\upgrade.ps1      E:\agent\upgrade.ps1
   Copy-Item packaging\VERSION.json     E:\agent\VERSION.json
   Copy-Item packaging\app\package.json E:\agent\app\package.json
   Copy-Item dist\cli.js                E:\agent\app\dist\cli.js
   Copy-Item docs\*                     E:\agent\docs\
   ```

4. 自检：

   ```powershell
   E:\agent\agent.cmd --check
   E:\agent\agent.cmd --version
   ```

5. 不要覆盖已有的 `config\`、`data\`、`memory\`、`skills\`、`agents\`、`commands\`。

## 换行与编码

- `agent.cmd` / `upgrade.cmd` 必须 CRLF；
- `upgrade.ps1` 建议 UTF-8 with BOM（Windows PowerShell 5.1 中文兼容）；
- 仓库 `.gitattributes` 已对 `.cmd` / `.bat` 强制 CRLF。
