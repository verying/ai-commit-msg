# Changelog

## 0.1.1

针对「时好时坏的 `fetch failed`」做连接层加固。

### 新增

- 代理支持：按 VS Code 的 `http.proxy` / `http.proxySupport` 与 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 决定是否走代理（socks/pac 暂不支持，会退回环境变量）。
- 连接阶段重试：`EAI_AGAIN`、`ECONNRESET`、`ECONNREFUSED`、`UND_ERR_CONNECT_TIMEOUT`、`UND_ERR_SOCKET`、`ETIMEDOUT` 及 HTTP 5xx 最多重试 2 次（指数退避），仅在尚未收到任何内容时重试。
- 新增命令「AI 提交: 选择模型（从 /v1/models 拉取）」，可直接从接口列出的模型中挑选并写入 `aiCommit.model`。
- 网络错误细分：按 `error.cause` 里的 `code` 给出中文原因与排查建议（DNS、连接拒绝、超时、证书等）。
- 日志新增：目标主机、代理来源、整体/连接超时、第几次尝试、完整 `cause` 链（`code`/`errno`/`syscall`/`hostname`）。

### 修复

- 模型不存在时不再误报为网络问题，改为提示模型不可用并引导选择可用模型。
- 请求改用自带 undici `Agent`（`autoSelectFamily` 开启），减少 IPv6-only 解析与连接池复用旧连接导致的间歇失败；每次请求独立连接，用完即关。
- `baseUrl` 归一化规则明确：末尾斜杠、`/v1`、`/v1/chat/completions`、纯域名均能正确拼出请求地址。
- 代理地址非法（缺协议头、特殊字符未编码）时提示「代理地址无法使用」并按配置错误处理，不再抛原始英文异常。
- 代理地址里的账号密码在日志与错误提示中打码（`user:***@host`），避免反馈问题时泄露凭据。
- `NO_PROXY` 补齐 `*.example.com`、`example.com:8080`、IPv6 条目；CIDR 写法不再被误判为命中。
- 生成期间再次点击生成会被直接挡下，避免两次请求并发写同一个提交信息输入框；退避等待中取消/超时会立即结束，不再多发一次请求。
- 接口返回非 JSON（例如被网关/代理换成 HTML 错误页）时提示「返回的不是 JSON」，不再归类成网络错误。

### 依赖

- 新增运行时依赖 `undici`（Node 官方 HTTP 客户端，零传递依赖），用于提供代理 dispatcher 与连接参数控制；同时取消打包时的 `--no-dependencies`。
- `undici` 选用 6.x（要求 Node ≥ 18.17），与扩展声明的最低 VS Code 1.90（Node 20.9）兼容；7.x 要求 Node ≥ 20.18.1，会让旧版 VS Code 装上后无法联网。

## 0.1.0

对外首发版本。相对 0.0.5 的主要变化是发布合规与健壮性，功能行为不变。

### 变更

- 提交信息改为**生成完整后一次性写入**，生成期间不再往 SCM 输入框写流式中间结果，避免残留半截内容。
- 写入后回读校验统一做换行符归一化（真实 SCM 输入框会把 `\n` 规整成 `\r\n`），避免误判为不一致而反复重写。
- 流式收尾异常或文本疑似断在半句时，自动改用非流式再请求一次，取更完整的一份。
- 多行结果写入后提示实际行数与字符数，避免把输入框视口裁剪误认为内容丢失。
- 输入框已有内容时先询问「清空并生成」，不再静默覆盖或静默跳过。
- 新增命令「AI 提交: 复制最近一次生成诊断」，一键把最近一次生成的诊断文本复制到剪贴板。

### 修复

- 修复 0.0.4 及之前版本在真实 VS Code 中因 `\r\n` 与 `\n` 不一致导致的「写入校验永远失败、误报内容不全」。
- 异常回滚改为走与正常写入相同的通道（兼容 Trae 的 `setValueWithTransient`）。
- 「测试连接」的 token 上限从 16 放宽到 64，并忽略 `finish_reason=length`，避免把连通误报为失败。

### 安全与合规

- 生产环境不再读取 `AICOMMIT_API_KEY` 环境变量兜底，API Key 只来自 SecretStorage（该兜底仅用于自动化 e2e）。
- 非 localhost 的 `http://` 地址在请求前提示明文传输风险，需确认后继续。
- 受限工作区不再启用扩展（`untrustedWorkspaces.supported: false`），避免在未信任工作区把代码发往第三方。
- 补齐 `LICENSE`（MIT）、`README.md`、`CHANGELOG.md`，`repository` 字段与 `keywords` 元数据。
- 打包脚本去掉了 `--allow-missing-repository`。

### 其它

- `.gitignore` 增加 `.vscode-test/`，避免把 e2e 缓存与含诊断内容的日志提交进仓库。
- e2e 不再写死本机 VS Code 路径，改为优先读 `VSCODE_EXE`、否则按各平台常见安装位置查找。
- 命令面板与快捷键不再限制 `scmProvider == git`，非 Git 窗口里也能触发并看到友好提示。
- 新增 `git.ts` 单元测试：多仓库选择、首次提交无 HEAD、`repo.diff` 失败回落 CLI、虚拟工作区报错。
- 扩展 `name` 由 `ai-commit-msg` 改为 `ai-commit-msg-generator`：Marketplace 上 `ai-commit-msg` 已被其他发布者占用（`vaibhava17.ai-commit-msg`），扩展 ID 相应为 `verying.ai-commit-msg-generator`。配置前缀 `aiCommit.*` 与命令 ID 不依赖扩展名，未做改动。

## 0.0.5

- 停掉流式写入，改为生成结束后一次性写入；新增真实 VS Code 端到端验证。
- 新增「复制最近一次生成诊断」命令。

## 0.0.4

- 重写终值写入与回读校验；新增诊断日志。

## 0.0.3

- 新增「AI 提交」输出通道；`maxTokens` 默认改为 0（不发送）。

## 0.0.2

- 修复接管误判导致提前停止写入。

## 0.0.1

- 首个可用版本：SCM 标题栏图标、暂存 diff、OpenAI 兼容接口、写入提交信息输入框。
