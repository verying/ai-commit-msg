# AI 提交信息生成器

读取 Git **暂存区**的改动，调用任意 OpenAI 兼容接口生成提交信息，并填入源代码管理（SCM）输入框。

- 只读暂存区，不会把未暂存的改动混进来
- 支持 Conventional Commits，也可切换为普通描述
- 默认中文，可按 diff 内容自动判断中英文
- 生成期间不写输入框，结束后一次性写入，避免中途出现半截内容
- API Key 存放在 VS Code 的 SecretStorage，不写入设置文件

## 安装

### 从 vsix 安装

```bash
code --install-extension ai-commit-msg-0.1.0.vsix --force
```

或在 VS Code 中打开「扩展」视图，点右上角 `...` → 「从 VSIX 安装…」。

### 从源码构建

```bash
npm install
npm run compile
npm run package
```

## 快速开始

1. 打开一个 Git 仓库，在源代码管理视图里**暂存**要提交的文件。
2. 命令面板执行 `AI 提交: 设置 AI 接口密钥`，粘贴你的 API Key（仅保存在本机 SecretStorage）。
3. 在设置里填写 `aiCommit.baseUrl`，例如 `https://your-relay.example.com/v1`（需要包含版本前缀，插件会自动追加 `/chat/completions`）。
4. 点源代码管理标题栏最左侧的 ✨ 图标，或按 `Ctrl+Alt+Shift+G`。
5. 生成结束后提交信息会一次性填入输入框，确认后照常提交。

没有暂存任何文件时会提示先暂存；暂存区为空但存在未暂存改动时，会额外告知未暂存的数量。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `aiCommit.baseUrl` | 空 | OpenAI 兼容接口地址，需包含版本前缀，如 `https://host/v1` |
| `aiCommit.model` | `gpt-4o-mini` | 模型名称，由中转站实际支持情况决定 |
| `aiCommit.language` | `zh-CN` | `zh-CN` / `en` / `auto`（按 diff 内容判断） |
| `aiCommit.style` | `conventional` | `conventional`（`type(scope): subject`）或 `plain` |
| `aiCommit.maxDiffChars` | `120000` | 发送给模型的 diff 上限，超出按文件截断 |
| `aiCommit.requestTimeoutMs` | `60000` | 单次请求超时（毫秒） |
| `aiCommit.temperature` | `0.2` | 采样温度，0–1 |
| `aiCommit.maxTokens` | `0` | 返回 token 上限；**0 表示不发送该字段**，由接口默认上限决定 |
| `aiCommit.stream` | `true` | 是否使用流式返回；中转站不支持流式时关闭 |
| `aiCommit.extraInstructions` | 空 | 追加到系统提示词的额外要求 |

`aiCommit.maxTokens` 建议保持 `0`。显式设得太小会让输出被截断，日志里会显示 `finish_reason=length`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `AI 提交: 根据暂存的更改生成提交信息` | 主命令，也可用 SCM 标题栏图标或快捷键触发 |
| `AI 提交: 设置 AI 接口密钥` | 输入并保存 API Key 到 SecretStorage |
| `AI 提交: 清除 AI 接口密钥` | 删除已保存的 API Key |
| `AI 提交: 测试 AI 接口连接` | 发送一次最小请求验证地址、模型与密钥 |
| `AI 提交: 显示 AI 提交日志` | 打开「AI 提交」输出通道 |
| `AI 提交: 复制最近一次生成诊断` | 把最近一次生成的诊断文本复制到剪贴板 |

## 行为说明

### 输入框已有内容

生成开始前如果输入框里已经有文字，会询问是否「清空并生成」。选择其他结果则不发请求，也不覆盖草稿。

### 生成期间

模型输出只在内部累积，**不会往输入框里写中间结果**，进度显示在右下角通知里（「正在生成… 已接收 N 字符」）。生成结束后一次性写入完整文本。

提交信息框的可视高度有限，长消息需要在框内滚动查看，或拖动输入框下边缘放大。扩展在写入多行内容时会提示实际写入的行数与字符数。

### 写入自检

写完会回读一次做比对（换行符归一化后比较）。不一致时会补写一次；仍不一致则把完整内容复制到剪贴板并提示直接粘贴。

### 输出疑似被截断

若流式返回既没有 `[DONE]` 也没有 `finish_reason`，或最后一行明显断在半句（例如只有一个 `-`、以「与/和/及/或/并」或逗号结尾），扩展会自动改用**非流式**再请求一次，取更完整的一份写入。

### 首次提交

仓库还没有 HEAD 时，prompt 中会说明这是初始提交；`repo.diff(true)` 拿不到内容时回落到 `git diff --cached`。

### 超长 diff

超过 `aiCommit.maxDiffChars` 时按文件截断，并在 prompt 中注明「以下 diff 已截断」。

## 隐私与数据流

- 扩展只会向**你自己配置的** `aiCommit.baseUrl` 发起请求，没有内置遥测，也不会连接任何其他地址。
- 请求内容包含：仓库名、分支名、暂存文件列表、暂存区 diff 文本。
- API Key 保存在 VS Code SecretStorage（系统密钥链），不写入 `settings.json`；请求时放在 `Authorization: Bearer` 头里。
- `baseUrl` 允许使用 `http://`，但除 localhost / 127.0.0.1 外会提示存在明文传输风险，需确认后才继续。
- 「AI 提交」输出通道与「复制最近一次生成诊断」**不会记录 diff 内容**，但会包含仓库绝对路径、分支名、模型输出全文，以及输入框原有草稿的前若干字符。把诊断发给他人前请自行检查。
- 在受限模式（Restricted Mode）下扩展不会启用，避免在未信任的工作区把代码发往外部接口。

## 常见问题

**401 / 认证失败**
检查 API Key 是否有效、是否属于该中转站；密钥命令里重新录入一次。

**429 / 额度不足**
请求太频繁或额度用完，稍后重试或换 Key。

**5xx / 服务异常**
中转站侧问题，换模型或稍后重试。

**超时**
调大 `aiCommit.requestTimeoutMs`，或关闭 `aiCommit.stream` 再试。

**返回为空**
模型或中转站返回了空内容，重试；持续出现时检查 model 名称是否正确。

**`finish_reason=length`**
输出被 token 上限截断。把 `aiCommit.maxTokens` 设为 `0`（不发送）或调大。

**输入框里看着像断了半句**
先用「复制最近一次生成诊断」确认 `[自证] 采用的最终文本` 是否完整；若完整，则是在输入框里被视口裁剪，滚动或拉高输入框即可。若最终文本本身就短，看 `[SSE]` 的结束方式与 `finish_reason` 判断是模型还是中转站截断。

**中转站不支持流式**
把 `aiCommit.stream` 设为 `false`。

**多仓库 / 多根工作区**
优先使用 SCM 视图中当前选中的仓库；否则按当前编辑器所属仓库、再按有暂存改动的仓库依次选取。

## 开发

```bash
npm run compile          # 编译
npm test                 # 单元测试（node:test）
npm run test:e2e         # 真实 VS Code 实例端到端验证（需本机已安装 VS Code）
npm run package          # 打包 vsix
```

e2e 会复用本机已安装的 VS Code：优先读取环境变量 `VSCODE_EXE`，未设置时按各平台常见安装位置查找（Windows 的用户级与全局安装目录、macOS 的 `/Applications`、Linux 的 `/usr/share/code`）。它会在临时目录建一个 git 仓库、暂存文件、执行生成命令并读回真实 SCM 输入框的值。若装在自定义路径，请先设置 `VSCODE_EXE`。

## 许可证

[MIT](./LICENSE)
