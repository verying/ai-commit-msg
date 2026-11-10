import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

const LONG_MESSAGE = `feat(portal): 重构配车与门店映射的批量维护流程

- 将配车规则抽取为独立的领域服务，减少控制器中的重复分支
- 门店名称映射改为增量同步，避免全量重建导致的锁竞争
- 为批量导入补充幂等校验与失败重试，并在日志中记录批次标识
- 调整单元测试覆盖边界条件，包括空批次与重复门店编码
- 更新接口文档与变更说明，明确字段兼容性要求`;

const API_KEY = 'sk-test-secret';

interface TestServer {
	baseUrl: string;
	close: () => Promise<void>;
}

function startServer(handler: http.RequestListener): Promise<TestServer> {
	return new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				baseUrl: `http://127.0.0.1:${port}/v1`,
				close: () => new Promise<void>(done => {
					server.closeAllConnections();
					server.close(() => done());
				})
			});
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeStream(
	res: http.ServerResponse,
	message: string,
	options: { chunkDelayMs?: number; finishReason?: string; done?: boolean } = {}
): Promise<void> {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive'
	});

	const chunkSize = 16;
	for (let index = 0; index < message.length; index += chunkSize) {
		const piece = message.slice(index, index + chunkSize);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
		if (options.chunkDelayMs) {
			await sleep(options.chunkDelayMs);
		}
	}

	if (options.finishReason) {
		res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: options.finishReason }] })}\n\n`);
	}
	if (options.done) {
		res.write('data: [DONE]\n\n');
	}
	res.end();
}

function readRequestBody(req: http.IncomingMessage): Promise<any> {
	return new Promise(resolve => {
		let data = '';
		req.on('data', chunk => {
			data += chunk;
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(data));
			} catch {
				resolve({});
			}
		});
	});
}

/** 模拟 VS Code 的 SCM 输入框，可注入「回读拿到旧快照」的异常行为。 */
class FakeInputBox {
	private current: string;
	private staleArmed = false;
	private staleConsumed = false;
	readonly writes: string[] = [];
	enabled = true;
	placeholder = '';

	constructor(private readonly options: {
		initialValue?: string;
		/** 写入该值后，紧接的一次读取会返回 staleValue，模拟回显把最终值覆盖成旧快照 */
		staleOnWriteValue?: string;
		staleValue?: string;
		/** 武装后不再自愈，之后每次读取都返回 staleValue，模拟终值永远落不到界面 */
		staleRepeat?: boolean;
	} = {}) {
		this.current = options.initialValue ?? '';
	}

	get value(): string {
		if (this.staleArmed && this.options.staleValue !== undefined) {
			if (this.options.staleRepeat) {
				return this.options.staleValue;
			}
			if (!this.staleConsumed) {
				this.staleArmed = false;
				this.staleConsumed = true;
				return this.options.staleValue;
			}
		}
		return this.current;
	}

	set value(next: string) {
		this.current = next;
		this.writes.push(next);

		if (!this.staleConsumed && this.options.staleOnWriteValue !== undefined && next === this.options.staleOnWriteValue) {
			this.staleArmed = true;
		}
	}
}

interface GenerateResult {
	messages: string[];
	box: FakeInputBox;
	logs: string[];
	clipboard: string[];
	runCommand: (id: string) => Promise<unknown>;
}

async function runGenerate(
	handler: http.RequestListener,
	box: FakeInputBox,
	extraConfig: Record<string, unknown> = {},
	infoReply?: (message: string) => string | undefined
): Promise<GenerateResult> {
	const server = await startServer(handler);
	const messages: string[] = [];
	const logs: string[] = [];
	const clipboard: string[] = [];
	const handlers: Record<string, (() => unknown)> = {};

	const repo = {
		rootUri: { scheme: 'file', fsPath: path.join('D:', 'tmp', 'demo-repo') },
		inputBox: box,
		state: {
			HEAD: { name: 'main', commit: 'abc1234' },
			indexChanges: [{ status: 5, uri: { fsPath: path.join('src', 'a.ts') } }],
			workingTreeChanges: []
		},
		ui: { selected: true },
		diff: async () => 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
	};

	const gitApi = {
		state: 'initialized',
		onDidChangeState: () => ({ dispose: () => undefined }),
		git: { path: 'git' },
		repositories: [repo],
		getRepository: () => repo
	};

	const config: Record<string, unknown> = {
		baseUrl: server.baseUrl,
		model: 'test-model',
		language: 'zh-CN',
		style: 'conventional',
		maxDiffChars: 120000,
		requestTimeoutMs: 15000,
		temperature: 0,
		maxTokens: 1024,
		stream: true,
		extraInstructions: '',
		...extraConfig
	};

	const vscodeMock: any = {
		window: {
			activeTextEditor: undefined,
			createOutputChannel: () => ({
				appendLine: (line: string) => {
					logs.push(line);
				},
				show: () => undefined,
				dispose: () => undefined
			}),
			withProgress: async (_options: unknown, task: any) => task(
				{ report: () => undefined },
				{ onCancellationRequested: () => ({ dispose: () => undefined }) }
			),
			showErrorMessage: async (message: string) => {
				messages.push(`error:${message}`);
				return undefined;
			},
			showWarningMessage: async (message: string) => {
				messages.push(`warning:${message}`);
				return undefined;
			},
			showInformationMessage: async (message: string) => {
				messages.push(`info:${message}`);
				return infoReply?.(message);
			}
		},
		workspace: {
			getConfiguration: () => ({
				get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback)
			}),
			asRelativePath: (uri: { fsPath?: string }) => String(uri?.fsPath ?? '')
		},
		commands: {
			registerCommand: (id: string, handler: () => unknown) => {
				handlers[id] = handler;
				return { dispose: () => undefined };
			},
			executeCommand: async () => undefined
		},
		extensions: {
			getExtension: (id: string) => (id === 'vscode.git'
				? { isActive: true, activate: async () => undefined, exports: { getAPI: () => gitApi } }
				: undefined)
		},
		env: {
			clipboard: {
				writeText: async (text: string) => {
					clipboard.push(text);
				}
			}
		},
		ProgressLocation: { Notification: 15 }
	};

	const Module = require('module') as any;
	const originalLoad = Module._load;
	Module._load = function (request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	let extension: { activate: (context: unknown) => void };
	try {
		for (const key of Object.keys(require.cache)) {
			if (/[\\/]out[\\/]/.test(key) && !key.endsWith('.test.js')) {
				delete require.cache[key];
			}
		}
		extension = require('../extension');
	} finally {
		Module._load = originalLoad;
	}

	const context = {
		subscriptions: [] as unknown[],
		secrets: {
			get: async () => API_KEY,
			store: async () => undefined,
			delete: async () => undefined
		}
	};

	extension.activate(context);
	const generate = handlers['aiCommit.generate'];
	assert.ok(generate, 'aiCommit.generate 命令应已注册');

	try {
		await generate();
	} finally {
		await server.close();
	}

	return { messages, box, logs, clipboard, runCommand: async (id: string) => handlers[id]?.() };
}

test('生成期间不写输入框，结束后一次性完整写入', async () => {
	const box = new FakeInputBox();
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE, { chunkDelayMs: 120, finishReason: 'stop', done: true });
	}, box);

	assert.equal(box.value, LONG_MESSAGE.trim());
	assert.ok(box.value.split('\n').length >= 7, '长输出的每一行都应保留');
	assert.ok(!result.messages.some(message => message.includes('未能完整写入')), '不应出现写入失败提示');
	assert.ok(
		result.messages.some(message => message.includes('已完整写入')),
		'多行结果应明确告知已完整写入的行数，避免被误认为截断'
	);
	// 只有「先清空 + 再写终值」两次写入，流式阶段一次都没有
	assert.equal(box.writes.length, 2, '流式期间不应写输入框，只允许清空与最终写入各一次');
	assert.ok(result.logs.some(line => line.includes('收到[DONE]=true')), '日志应记录已收到 [DONE]');
	assert.ok(result.logs.some(line => line.includes('累计字符=')), '日志应记录累计字符数');
	assert.ok(result.logs.some(line => line.includes('[自证] 采用的最终文本')), '日志应记录最终文本');
	assert.ok(result.logs.some(line => line.includes('[自证] 一致=true')), '日志应自证期望与实际一致');
});

test('回读被旧快照覆盖时补写一次即修复', async () => {
	const box = new FakeInputBox({
		staleOnWriteValue: LONG_MESSAGE.trim(),
		staleValue: LONG_MESSAGE.trim().slice(0, 100)
	});
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE, { chunkDelayMs: 120, finishReason: 'stop', done: true });
	}, box);

	assert.equal(box.value, LONG_MESSAGE.trim(), '补写后应完整');
	assert.ok(result.logs.some(line => line.includes('长度=100')), '日志应记录到第一次回读的旧快照');
	assert.ok(result.logs.some(line => line.includes('补写后一致')), '日志应记录补写后一致');
});

test('回读始终是旧快照时改用非流式复核，仍不一致则复制完整内容', async () => {
	// 模拟「回读永远拿不到界面真实值」：任意写入后回读都是旧片段
	const stale = LONG_MESSAGE.trim().slice(0, 48);
	let requests = 0;
	const box = new FakeInputBox({
		staleOnWriteValue: LONG_MESSAGE.trim(),
		staleValue: stale,
		staleRepeat: true
	});

	const result = await runGenerate(async (req, res) => {
		requests++;
		const body = await readRequestBody(req);
		if (body.stream === false) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ choices: [{ message: { content: LONG_MESSAGE } }] }));
			return;
		}
		// 不给结束标记：触发扩展做一次非流式复核
		await writeStream(res, LONG_MESSAGE, { chunkDelayMs: 120 });
	}, box);

	assert.ok(requests >= 2, '未写到位时应发一次非流式请求复核');
	assert.ok(result.logs.some(line => line.includes('[自证] 非流式参考文本')), '日志应记录非流式复核结果');
	assert.ok(result.messages.some(message => message.includes('已复制到剪贴板')), '应提示完整内容已复制到剪贴板');
	assert.equal(result.clipboard[0], LONG_MESSAGE.trim(), '剪贴板应拿到完整生成结果');
});

test('复制最近一次生成诊断可一键拿到完整诊断文本', async () => {
	const box = new FakeInputBox();
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE, { chunkDelayMs: 120, finishReason: 'stop', done: true });
	}, box);

	await result.runCommand('aiCommit.copyDiagnostics');

	const report = result.clipboard[result.clipboard.length - 1] ?? '';
	assert.ok(report.includes('[配置]'), '诊断应包含请求配置');
	assert.ok(report.includes('[SSE]'), '诊断应包含 SSE 结束方式');
	assert.ok(report.includes('[自证] 采用的最终文本'), '诊断应包含最终文本');
	assert.ok(report.includes('[自证] 输入框实际值'), '诊断应包含输入框实际值');
	assert.ok(report.includes('[校验] 第一次回读'), '诊断应包含回读序列');
	assert.ok(result.messages.some(message => message.includes('已复制最近一次生成诊断')));
});

test('输入框已有内容时询问是否清空再生成', async () => {
	const box = new FakeInputBox({ initialValue: '旧的提交信息' });
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE, { chunkDelayMs: 120, finishReason: 'stop', done: true });
	}, box, {}, () => '清空并生成');

	assert.ok(result.messages.some(message => message.includes('是否清空后重新生成')));
	assert.equal(box.value, LONG_MESSAGE.trim());
});

test('流缺少结束标记时写入内容并提示可能不完整', async () => {
	const box = new FakeInputBox();
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE, {});
	}, box);

	assert.equal(box.value, LONG_MESSAGE.trim());
	assert.ok(result.messages.some(message => message.includes('未返回结束标记')));
});

test('finish_reason=length 时报错并恢复原值', async () => {
	const box = new FakeInputBox();
	const result = await runGenerate((_req, res) => {
		void writeStream(res, LONG_MESSAGE.slice(0, 120), { finishReason: 'length', done: true });
	}, box);

	assert.equal(box.value, '');
	assert.ok(result.messages.some(message => message.includes('maxTokens')));
});
