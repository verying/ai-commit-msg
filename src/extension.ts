import * as vscode from 'vscode';
import { ApiError, listModels, requestCommitMessage } from './apiClient';
import { clearApiKey, getApiKey, isInsecureBaseUrl, promptAndStoreApiKey, readConfig } from './config';
import { describeChange, getGitApi, pickRepository, readStagedSnapshot } from './git';
import type { Repository } from './gitApi';
import { buildPrompt } from './core/prompt';
import { decideProxy, ProxyDecision } from './core/proxy';
import { sanitizeCommitMessage } from './core/sanitize';
import { truncateDiff } from './core/truncate';

let outputChannel: vscode.OutputChannel | undefined;

/** 最近一次生成过程的日志快照，供「复制最近一次生成诊断」命令一键取用 */
let lastReportLines: string[] = [];
let capturingReport = false;
/** 生成中的互斥标记：避免重复点击并发写同一个提交信息输入框 */
let generating = false;
const REPORT_MAX_LINES = 4000;

function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`;
	outputChannel?.appendLine(line);
	if (capturingReport && lastReportLines.length < REPORT_MAX_LINES) {
		lastReportLines.push(line);
	}
}

function logBlock(title: string, text: string): void {
	log(`----- ${title}（${text.length} 字符）-----`);
	for (const line of text.split('\n')) {
		log(`| ${line}`);
	}
	log(`----- ${title} 结束 -----`);
}

function preview(value: string, max = 40): string {
	const oneLine = value.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 把任意字符串转成可放进日志的行内原始串（保留转义，便于区分 \n 与真实换行）。
 * 过长时截断展示，但长度信息单独给出，避免误判。
 */
function rawPreview(value: string, max = 300): string {
	const raw = JSON.stringify(value);
	return raw.length > max ? `${raw.slice(0, max)}…(原始串共 ${raw.length} 字符)` : raw;
}

function beginReport(): void {
	lastReportLines = [];
	capturingReport = true;
}

function endReport(): void {
	capturingReport = false;
}

export function activate(context: vscode.ExtensionContext): void {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('AI 提交');
		context.subscriptions.push(outputChannel);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('aiCommit.generate', () => generateCommitMessage(context)),
		vscode.commands.registerCommand('aiCommit.setApiKey', () => promptAndStoreApiKey(context)),
		vscode.commands.registerCommand('aiCommit.clearApiKey', () => clearApiKey(context)),
		vscode.commands.registerCommand('aiCommit.testConnection', () => testConnection(context)),
		vscode.commands.registerCommand('aiCommit.selectModel', () => selectModel(context)),
		vscode.commands.registerCommand('aiCommit.showLogs', () => outputChannel?.show(true)),
		vscode.commands.registerCommand('aiCommit.copyDiagnostics', () => copyDiagnostics())
	);
}

export function deactivate(): void { }

/**
 * 一键复制最近一次生成的诊断报告（请求参数 / SSE 结束方式 / 每次回读原始串 / 完整结果）。
 * 用户复现后执行一次本命令即可把全部关键信息贴回来，不必翻输出通道截图。
 */
async function copyDiagnostics(): Promise<void> {
	if (lastReportLines.length === 0) {
		void vscode.window.showInformationMessage('还没有生成记录。请先点击 SCM 标题栏的生成图标，再执行本命令。');
		return;
	}
	const text = lastReportLines.join('\n');
	try {
		await vscode.env.clipboard.writeText(text);
		void vscode.window.showInformationMessage(`已复制最近一次生成诊断（${lastReportLines.length} 行 / ${text.length} 字符），直接粘贴即可`);
	} catch (error) {
		void vscode.window.showErrorMessage(`复制失败：${error instanceof Error ? error.message : String(error)}，请打开「AI 提交」输出通道手动复制`);
	}
}

/**
 * 输入框写入通道。
 * Trae 的 git 扩展 fork 暴露了 setValueWithTransient（AI 生成结果专用通道），
 * 原版 VS Code 只有 value 赋值，二者都做兼容。
 */
interface InputBoxLike {
	value: string;
	setValueWithTransient?: (value: string, transient?: boolean) => void;
}

function commitViaInputBox(inputBox: Repository['inputBox'], value: string): string {
	const box = inputBox as unknown as InputBoxLike;
	if (typeof box.setValueWithTransient === 'function') {
		try {
			box.setValueWithTransient(value, true);
			return 'setValueWithTransient';
		} catch (error) {
			log(`[写入] setValueWithTransient 失败，回退普通赋值：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	inputBox.value = value;
	return 'value';
}

/**
 * 最终落地：只在生成完整结束后写入一次，不再有任何流式快照。
 *
 * 为什么不再「边生成边写」：三次复现的断点位置都不同、都停在正文中段，
 * 而流式写入会在输入框里留下多条半截快照，回读又只能拿到扩展宿主侧缓存，
 * 无法判断界面到底停在哪个快照上。改成单次写入后，输入框里只会有一个值，
 * 要么是完整文本、要么是空/原值，不存在「残留半句」的中间态。
 */
async function applyFinalMessage(
	inputBox: Repository['inputBox'],
	message: string
): Promise<{ status: 'ok' | 'lost'; actual: string }> {
	const lines = message.split('\n').length;
	// 真实 SCM 输入框会把换行规整成 \r\n，比较前先归一化，否则永远判「不一致」
	const normalize = (value: string): string => value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
	const same = (value: string): boolean => normalize(value) === normalize(message);

	// 让 SCM 视图处于可见状态，确保主线程确实渲染了这个输入框
	try {
		await vscode.commands.executeCommand('workbench.view.scm');
	} catch (error) {
		log(`[写入] 聚焦 SCM 视图失败（不影响写入）：${error instanceof Error ? error.message : String(error)}`);
	}

	log(`[写入] 一次性写入 ${message.length} 字符 / ${lines} 行（不再流式写入）`);

	// 先清空再写：确保主线程一定感知到值变化，避免「目标值与缓存相同」被跳过
	commitViaInputBox(inputBox, '');
	await delay(120);
	const mode = commitViaInputBox(inputBox, message);
	await delay(500);

	const first = inputBox.value;
	log(`[校验] 第一次回读 长度=${first.length} 原文=${rawPreview(first)} 通道=${mode}`);
	if (same(first)) {
		log('[校验] 一致，写入生效');
		return { status: 'ok', actual: first };
	}
	log(`[校验] 不一致：期望 ${message.length} 字符，实际 ${first.length} 字符，首个差异位置=${firstDiffIndex(first, message)}，补写一次`);

	commitViaInputBox(inputBox, message);
	await delay(700);
	const second = inputBox.value;
	log(`[校验] 第二次回读 长度=${second.length} 原文=${rawPreview(second)}`);
	if (same(second)) {
		log('[校验] 补写后一致');
		return { status: 'ok', actual: second };
	}
	log(`[校验] 补写后仍不一致：期望 ${message.length} 字符，实际 ${second.length} 字符，首个差异位置=${firstDiffIndex(second, message)}`);
	return { status: 'lost', actual: second };
}

/**
 * 粗判提交信息是否被截在半句上（用户复现的两种形态：「- 」独占一行、以「与」结尾）。
 * 命中后用非流式再取一次，取更完整的一份。
 */
function looksIncomplete(text: string): boolean {
	const lastLine = text.split('\n').filter(line => line.trim().length > 0).pop() ?? '';
	const trimmed = lastLine.trim();
	if (!trimmed) {
		return true;
	}
	if (/^[-*+]\s*$/.test(trimmed)) {
		return true;
	}
	if (/[，,、；;：:（(【\[]$/.test(trimmed)) {
		return true;
	}
	return /(与|和|及|或|并|以及|的)$/.test(trimmed);
}

/**
 * 选取最终写入文本：流式结果与非流式参考都有时，取更完整的那一份。
 * 流式若被中转站中途截断，非流式通常是完整的，直接用后者。
 */
function chooseFinalMessage(streamedRaw: string, reference: string): string {
	const streamed = sanitizeCommitMessage(streamedRaw);
	if (!reference) {
		return streamed;
	}
	return reference.length >= streamed.length ? reference : streamed;
}

function firstDiffIndex(actual: string, expected: string): number {
	const max = Math.min(actual.length, expected.length);
	for (let index = 0; index < max; index++) {
		if (actual[index] !== expected[index]) {
			return index;
		}
	}
	return max;
}

async function generateCommitMessage(context: vscode.ExtensionContext): Promise<void> {
	if (typeof fetch !== 'function') {
		void vscode.window.showErrorMessage('当前 VS Code 版本不支持 fetch，请升级 VS Code');
		return;
	}

	// 生成一次可能包含重试与非流式复核，耗时较长；期间再次点击会并发写同一个输入框，
	// 出现「后一次覆盖前一次」或两次写入交错的问题，这里直接挡住。
	if (generating) {
		void vscode.window.showInformationMessage('上一次生成还没结束，请等它完成或点进度通知上的取消后再试');
		return;
	}
	generating = true;

	log('[开始] 触发生成提交信息命令');
	beginReport();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'AI 生成提交信息',
				cancellable: true
			},
			async (progress, token) => {
				const abort = new AbortController();
				const cancellation = token.onCancellationRequested(() => {
					log('[取消] 用户取消了进度提示，中止请求');
					abort.abort();
				});

				let repo: Repository | undefined;
				let originalValue = '';

				try {
					progress.report({ message: '连接 Git 仓库…' });
					const api = await getGitApi();
					repo = pickRepository(api, vscode.window.activeTextEditor?.document.uri);
					if (!repo) {
						log('[仓库] 未找到 Git 仓库');
						void vscode.window.showWarningMessage('未找到 Git 仓库，请先打开一个 Git 项目');
						return;
					}

					const snapshot = await readStagedSnapshot(repo, api.git.path);
					log(`[仓库] ${repo.rootUri.fsPath} 暂存文件=${snapshot.changes.length} 未暂存=${repo.state.workingTreeChanges.length} diff字符=${snapshot.diff.length}`);
					if (snapshot.changes.length === 0) {
						const unstaged = repo.state.workingTreeChanges.length;
						log(`[仓库] 暂存区为空，未暂存=${unstaged}`);
						void vscode.window.showWarningMessage(
							unstaged > 0
								? `暂存区没有更改；检测到 ${unstaged} 个未暂存的更改，请先暂存要提交的文件`
								: '暂存区没有更改，请先暂存要提交的文件'
						);
						return;
					}

					const config = readConfig();
					log(`[配置] baseUrl=${config.baseUrl} model=${config.model} maxTokens=${config.maxTokens > 0 ? config.maxTokens : '未发送(0)'} stream=${config.stream} temperature=${config.temperature} timeout=${config.requestTimeoutMs}ms maxDiffChars=${config.maxDiffChars}`);

					if (!config.baseUrl) {
						const action = await vscode.window.showErrorMessage('请先配置 aiCommit.baseUrl', '打开设置');
						if (action === '打开设置') {
							await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
						}
						return;
					}

					if (isInsecureBaseUrl(config.baseUrl)) {
						const action = await vscode.window.showWarningMessage(
							`当前 baseUrl 使用 http://（${config.baseUrl}），API Key 与代码 diff 会明文传输。建议改用 https，或仅在可信内网使用。`,
							'仍然继续',
							'打开设置'
						);
						if (action === '打开设置') {
							await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
						}
						if (action !== '仍然继续') {
							log('[配置] 用户未确认通过 http 明文发送，已中止');
							return;
						}
						log('[配置] 用户确认通过 http 明文发送');
					}

					const apiKey = await getApiKey(context);
					if (!apiKey) {
						const action = await vscode.window.showErrorMessage('未配置 API Key', '设置密钥');
						if (action === '设置密钥') {
							await vscode.commands.executeCommand('aiCommit.setApiKey');
						}
						return;
					}

					const proxy = resolveProxyFor(config.baseUrl);
					log(`[代理] ${proxy.detail}`);

					progress.report({ message: '读取暂存区 diff…' });
					const truncated = truncateDiff(snapshot.diff, config.maxDiffChars);
					log(`[diff] 原始=${snapshot.diff.length} 字符，发送=${truncated.text.length} 字符，截断=${truncated.truncated}`);
					const repoName = repo.rootUri.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? repo.rootUri.fsPath;
					const messages = buildPrompt({
						repoName,
						branch: repo.state.HEAD?.name,
						isInitialCommit: snapshot.isInitialCommit,
						files: snapshot.changes.map(describeChange),
						diff: truncated.text,
						truncated: truncated.truncated,
						language: config.language,
						style: config.style,
						extraInstructions: config.extraInstructions
					});
					log(`[提示词] system=${messages[0].content.length} 字符，user=${messages[1].content.length} 字符`);
					logBlock('[提示词] 系统提示词', messages[0].content);

					const targetRepo = repo;
					const inputBox = targetRepo.inputBox;
					originalValue = inputBox.value;
					log(`[输入框] 开始前字符=${originalValue.length}「${preview(originalValue)}」`);

					if (originalValue.trim().length > 0) {
						// 保留「不覆盖已有内容」的语义，同时给出一步清空，避免上次残留挡住生成
						const action = await vscode.window.showInformationMessage(
							'提交信息输入框已有内容，是否清空后重新生成？',
							'清空并生成'
						);
						if (action !== '清空并生成') {
							log('[输入框] 已有内容且用户选择保留，结束');
							return;
						}
						commitViaInputBox(inputBox, '');
						await delay(300);
						originalValue = '';
						log('[输入框] 已清空，继续生成');
					}

					let deltaEvents = 0;
					let lastProgressAt = 0;
					const onDelta = (accumulated: string) => {
						deltaEvents++;
						const now = Date.now();
						if (now - lastProgressAt < 200) {
							return;
						}
						lastProgressAt = now;
						// 只更新进度提示，绝不写入输入框：输入框里不留任何半截快照
						progress.report({ message: `正在生成… 已接收 ${accumulated.length} 字符` });
					};

					let streamMeta: { sawDone: boolean; finishReason?: string } = { sawDone: true };

					progress.report({ message: config.stream ? '正在请求模型（流式）…' : '正在请求模型…' });

					const raw = await requestCommitMessage({
						baseUrl: config.baseUrl,
						apiKey,
						model: config.model,
						proxyUrl: proxy.proxyUrl,
						messages,
						temperature: config.temperature,
						maxTokens: config.maxTokens,
						stream: config.stream,
						timeoutMs: config.requestTimeoutMs,
						signal: abort.signal,
						onDelta,
						onLog: log,
						onCompletion: meta => {
							streamMeta = meta;
						}
					});

					log(`[生成] 增量事件=${deltaEvents}（仅用于进度提示，未写入输入框）`);
					log(`[生成] 累计字符=${raw.length} 行数=${raw.split('\n').length}`);
					logBlock('[自证] 流式累计原文', raw);

					// 只在流式收尾可疑、或文本明显断在半句时才补一次非流式请求（避免每次都多花一次调用），
					// 用于判断「模型/中转站到底返回了多少」：非流式更长即说明流式链路丢了内容。
					const streamedNormalized = sanitizeCommitMessage(raw);
					const incomplete = looksIncomplete(streamedNormalized);
					const likelyTruncated = config.stream && ((!streamMeta.sawDone && !streamMeta.finishReason) || incomplete);
					log(`[自证] 流式收尾可疑=${likelyTruncated}（收到[DONE]=${streamMeta.sawDone} finish_reason=${streamMeta.finishReason ?? '无'} 疑似半句=${incomplete}）`);
					let reference = '';
					if (likelyTruncated) {
						try {
							progress.report({ message: '流式收尾异常，改用非流式复核…' });
							const referenceRaw = await requestCommitMessage({
								baseUrl: config.baseUrl,
								apiKey,
								model: config.model,
								proxyUrl: proxy.proxyUrl,
								messages,
								temperature: config.temperature,
								maxTokens: config.maxTokens,
								stream: false,
								timeoutMs: config.requestTimeoutMs,
								signal: abort.signal,
								onLog: log
							});
							reference = sanitizeCommitMessage(referenceRaw);
							logBlock('[自证] 非流式参考文本', reference);
							log(`[自证] 流式=${raw.length} 字符 末尾「${preview(raw.trimEnd().slice(-40))}」 / 非流式=${referenceRaw.length} 字符 末尾「${preview(reference.trimEnd().slice(-40))}」`);
							if (reference.length > sanitizeCommitMessage(raw).length) {
								log('[自证] 非流式结果更长，说明流式链路丢了内容，改用非流式结果写入');
								void vscode.window.showWarningMessage('流式返回的内容比非流式少，已改用非流式结果写入');
							}
						} catch (error) {
							log(`[自证] 非流式复核失败（不影响本次生成）：${error instanceof Error ? error.message : String(error)}`);
						}
					}

					const finalMessage = chooseFinalMessage(raw, reference);
					log(`[清洗] 流式 ${raw.length} → ${finalMessage.length} 字符${reference ? `（非流式参考 ${reference.length} 字符）` : ''}`);
					logBlock('[自证] 采用的最终文本', finalMessage);

					if (!finalMessage) {
						void vscode.window.showWarningMessage('模型返回为空，请重试');
						return;
					}

					let applied = await applyFinalMessage(inputBox, finalMessage);
					logBlock('[自证] 输入框实际值', applied.actual);
					log(`[自证] 一致=${applied.status === 'ok'} 期望=${finalMessage.length} 字符 实际=${applied.actual.length} 字符 差异位置=${applied.status === 'ok' ? '无' : firstDiffIndex(applied.actual, finalMessage)}`);

					if (applied.status === 'lost' && reference && reference !== finalMessage) {
						log('[自证] 单次写入未通过校验，改用非流式参考文本再写一次');
						const retried = await applyFinalMessage(inputBox, reference);
						logBlock('[自证] 非流式文本写入后输入框实际值', retried.actual);
						if (retried.status === 'ok') {
							applied = retried;
						}
					}

					if (applied.status === 'ok') {
						progress.report({ message: '已生成' });
						// SCM 输入框的可见高度只够几行，长消息会被裁剪成「看着像断了半句」。
						// 这里给出明确的行数结论，避免把「视口裁剪」误认为内容丢失。
						const lineCount = finalMessage.split('\n').length;
						if (lineCount >= 5) {
							void vscode.window
								.showInformationMessage(
									`已完整写入 ${lineCount} 行 / ${finalMessage.length} 字符。提交信息框可视高度有限，剩余行需在框内滚动查看（可拖动输入框下边缘放大）。`,
									'复制完整内容'
								)
								.then(action => {
									if (action === '复制完整内容') {
										void vscode.env.clipboard.writeText(finalMessage);
										void vscode.window.showInformationMessage('完整提交信息已复制到剪贴板');
									}
								});
						}
					} else {
						const fallback = reference.length > finalMessage.length ? reference : finalMessage;
						log(`[自证] 输入框实际值与生成结果不一致，把完整文本（${fallback.length} 字符）放进剪贴板`);
						try {
							await vscode.env.clipboard.writeText(fallback);
							void vscode.window.showWarningMessage('提交信息未能完整写入输入框，完整内容已复制到剪贴板，可直接粘贴；如需反馈请运行「AI 提交: 复制最近一次生成诊断」');
						} catch (error) {
							log(`[自证] 写入剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
							void vscode.window.showWarningMessage('提交信息未能完整写入输入框，完整内容已记录在「AI 提交」输出通道，可复制后手动粘贴');
						}
					}

					if (config.stream && !streamMeta.sawDone && !streamMeta.finishReason) {
						log('[警告] 流结束但既无 [DONE] 也无 finish_reason，内容可能被中途截断');
						void vscode.window.showWarningMessage('接口未返回结束标记，生成结果可能不完整，建议重试');
					}
				} catch (error) {
					if (repo) {
						commitViaInputBox(repo.inputBox, originalValue);
						log(`[回滚] 异常退出，恢复原值 ${originalValue.length} 字符`);
					}
					log(`[异常] ${error instanceof ApiError ? `kind=${error.kind} ` : ''}${error instanceof Error ? error.message : String(error)}`);
					reportError(error);
				} finally {
					cancellation.dispose();
					log('[结束] 生成流程结束');
					log(`[结束] 本次诊断共 ${lastReportLines.length} 行；执行命令「AI 提交: 复制最近一次生成诊断」可一键复制`);
					endReport();
				}
			}
		);
	} finally {
		generating = false;
	}
}

async function testConnection(context: vscode.ExtensionContext): Promise<void> {
	const config = readConfig();
	log(`[测试连接] baseUrl=${config.baseUrl} model=${config.model}`);
	if (!config.baseUrl) {
		const action = await vscode.window.showErrorMessage('请先配置 aiCommit.baseUrl', '打开设置');
		if (action === '打开设置') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
		}
		return;
	}

	const apiKey = await getApiKey(context);
	if (!apiKey) {
		const action = await vscode.window.showErrorMessage('未配置 API Key', '设置密钥');
		if (action === '设置密钥') {
			await vscode.commands.executeCommand('aiCommit.setApiKey');
		}
		return;
	}

	if (isInsecureBaseUrl(config.baseUrl)) {
		const action = await vscode.window.showWarningMessage(
			`当前 baseUrl 使用 http://（${config.baseUrl}），API Key 会明文传输。建议改用 https。`,
			'仍然继续',
			'打开设置'
		);
		if (action === '打开设置') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
		}
		if (action !== '仍然继续') {
			return;
		}
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: '测试 AI 接口连接',
			cancellable: true
		},
		async progress => {
			progress.report({ message: '发送测试请求…' });
			const proxy = resolveProxyFor(config.baseUrl);
			log(`[代理] ${proxy.detail}`);
			try {
				const result = await requestCommitMessage({
					baseUrl: config.baseUrl,
					apiKey,
					model: config.model,
					proxyUrl: proxy.proxyUrl,
					messages: [{ role: 'user', content: 'ping' }],
					temperature: 0,
					// 16 个 token 在推理模型/长前缀下容易被判成 length，误报连接失败
					maxTokens: 64,
					stream: false,
					timeoutMs: config.requestTimeoutMs,
					onLog: log
				});
				void vscode.window.showInformationMessage(`连接成功：${result.slice(0, 80)}`);
			} catch (error) {
				if (error instanceof ApiError && error.kind === 'truncated') {
					// 能返回 length 说明链路是通的，只是 token 上限太小
					void vscode.window.showInformationMessage('连接成功（返回内容触达 token 上限，属正常现象）');
					return;
				}
				reportError(error);
			}
		}
	);
}

/** 读取 VS Code 的 http.proxy / http.proxySupport 与环境变量，决定本次请求是否走代理 */
function resolveProxyFor(url: string): ProxyDecision {
	const httpConfig = vscode.workspace.getConfiguration('http');
	return decideProxy(url, {
		setting: httpConfig.get<string>('proxy') ?? '',
		support: httpConfig.get<string>('proxySupport') ?? 'override'
	});
}

async function selectModel(context: vscode.ExtensionContext): Promise<void> {
	const config = readConfig();
	if (!config.baseUrl) {
		const action = await vscode.window.showErrorMessage('请先配置 aiCommit.baseUrl', '打开设置');
		if (action === '打开设置') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
		}
		return;
	}

	const apiKey = await getApiKey(context);
	if (!apiKey) {
		const action = await vscode.window.showErrorMessage('未配置 API Key', '设置密钥');
		if (action === '设置密钥') {
			await vscode.commands.executeCommand('aiCommit.setApiKey');
		}
		return;
	}

	const proxy = resolveProxyFor(config.baseUrl);
	log(`[模型] 当前 model=${config.model} 代理=${proxy.detail}`);

	let models: string[];
	try {
		models = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '获取可用模型', cancellable: false },
			() => listModels({
				baseUrl: config.baseUrl,
				apiKey,
				proxyUrl: proxy.proxyUrl,
				timeoutMs: config.requestTimeoutMs,
				onLog: log
			})
		);
	} catch (error) {
		reportError(error);
		return;
	}

	log(`[模型] 接口返回 ${models.length} 个模型`);
	if (models.length === 0) {
		void vscode.window.showWarningMessage('接口没有返回任何模型，可能不支持 /v1/models；请手动在设置里填写 aiCommit.model');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		models.map(model => ({ label: model, description: model === config.model ? '当前使用' : undefined })),
		{ placeHolder: `当前模型：${config.model}；选择后写入用户设置 aiCommit.model`, matchOnDescription: true }
	);
	if (!picked) {
		return;
	}

	await vscode.workspace.getConfiguration('aiCommit').update('model', picked.label, vscode.ConfigurationTarget.Global);
	void vscode.window.showInformationMessage(`已切换模型：${picked.label}`);
}

function reportError(error: unknown): void {
	if (!(error instanceof ApiError)) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
		return;
	}

	switch (error.kind) {
		case 'aborted':
			return;
		case 'auth':
			void vscode.window.showErrorMessage('认证失败，请检查 API Key 或中转站权限', '设置密钥').then(action => {
				if (action === '设置密钥') {
					void vscode.commands.executeCommand('aiCommit.setApiKey');
				}
			});
			return;
		case 'rate-limit':
			void vscode.window.showErrorMessage('请求过于频繁或额度不足，请稍后重试');
			return;
		case 'server':
			void vscode.window.showErrorMessage(`中转站服务异常：${error.message}`);
			return;
		case 'network':
			void vscode.window.showErrorMessage(`无法连接中转站：${error.message}`, '查看日志', '测试连接').then(action => {
				if (action === '查看日志') {
					void vscode.commands.executeCommand('aiCommit.showLogs');
				} else if (action === '测试连接') {
					void vscode.commands.executeCommand('aiCommit.testConnection');
				}
			});
			return;
		case 'model':
			void vscode.window.showErrorMessage(`${error.message}，可从接口拉取可用模型列表`, '选择模型', '打开设置').then(action => {
				if (action === '选择模型') {
					void vscode.commands.executeCommand('aiCommit.selectModel');
				} else if (action === '打开设置') {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.model');
				}
			});
			return;
		case 'timeout':
			void vscode.window.showErrorMessage(error.message);
			return;
		case 'empty':
			void vscode.window.showWarningMessage('模型返回为空，请重试');
			return;
		case 'truncated':
			void vscode.window.showErrorMessage('接口返回 finish_reason=length，输出被截断。可把 aiCommit.maxTokens 设为 0（不发送，由接口默认上限决定）或调大后重试', '打开设置').then(action => {
				if (action === '打开设置') {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.maxTokens');
				}
			});
			return;
		case 'config':
			void vscode.window.showErrorMessage(`请求配置有误：${error.message}`, '打开设置').then(action => {
				if (action === '打开设置') {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'aiCommit.baseUrl');
				}
			});
			return;
	}
}
