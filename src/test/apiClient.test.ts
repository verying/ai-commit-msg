import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, ChatRequest, requestCommitMessage } from '../apiClient';

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

function baseRequest(baseUrl: string, overrides: Partial<ChatRequest> = {}): ChatRequest {
	return {
		baseUrl,
		apiKey: API_KEY,
		model: 'test-model',
		messages: [{ role: 'user', content: 'generate' }],
		temperature: 0.2,
		maxTokens: 100,
		stream: true,
		timeoutMs: 10000,
		...overrides
	};
}

test('流式返回按 delta 累加并回调', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.write('data: {"choices":[{"delta":{"content":"feat"}}]}\n\n');
		res.write('data: {"choices":[{"delta":{"content":": add"}}]}\n\n');
		res.write('data: {"choices":[{"delta":{"content":" test"}}]}\n\n');
		res.end('data: [DONE]\n\n');
	});

	try {
		const deltas: string[] = [];
		const result = await requestCommitMessage(baseRequest(server.baseUrl, {
			onDelta: accumulated => deltas.push(accumulated)
		}));
		assert.equal(result, 'feat: add test');
		assert.deepEqual(deltas, ['feat', 'feat: add', 'feat: add test']);
	} finally {
		await server.close();
	}
});

test('401 映射为 auth 且不泄露 Key', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'bad key' } }));
	});

	try {
		await assert.rejects(
			() => requestCommitMessage(baseRequest(server.baseUrl, { stream: false })),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.kind, 'auth');
				assert.ok(error.message.includes('401'));
				assert.ok(!error.message.includes(API_KEY));
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test('超时映射为 timeout', async () => {
	const server = await startServer(() => {
		// 永不响应
	});

	try {
		await assert.rejects(
			() => requestCommitMessage(baseRequest(server.baseUrl, { timeoutMs: 100 })),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.kind, 'timeout');
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test('非流式 JSON 返回 message.content', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ choices: [{ message: { content: 'fix: bug' } }] }));
	});

	try {
		const result = await requestCommitMessage(baseRequest(server.baseUrl, { stream: false }));
		assert.equal(result, 'fix: bug');
	} finally {
		await server.close();
	}
});

test('外部取消映射为 aborted', async () => {
	const server = await startServer((_req, res) => {
		setTimeout(() => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
		}, 500);
	});

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);

	try {
		await assert.rejects(
			() => requestCommitMessage(baseRequest(server.baseUrl, { signal: controller.signal })),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.kind, 'aborted');
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test('SSE 中的 error 映射为 server', async () => {
	const server = await startServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.end('data: {"error":{"message":"quota exceeded"}}\n\n');
	});

	try {
		await assert.rejects(
			() => requestCommitMessage(baseRequest(server.baseUrl)),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.kind, 'server');
				assert.ok(error.message.includes('quota'));
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test('maxTokens=0 时不发送 max_tokens，日志记录流细节', async () => {
	let requestBody: any;
	const logs: string[] = [];
	const server = await startServer((req, res) => {
		let raw = '';
		req.on('data', chunk => {
			raw += chunk;
		});
		req.on('end', () => {
			requestBody = JSON.parse(raw);
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: {"choices":[{"delta":{"content":"feat: x"}}]}\n\n');
			res.end('data: [DONE]\n\n');
		});
	});

	try {
		const result = await requestCommitMessage(baseRequest(server.baseUrl, {
			maxTokens: 0,
			onLog: line => logs.push(line)
		}));
		assert.equal(result, 'feat: x');
		assert.ok(!('max_tokens' in requestBody), 'maxTokens=0 时不应发送 max_tokens');
		assert.ok(logs.some(line => line.includes('结束方式=DONE')), '日志应记录结束方式');
		assert.ok(logs.some(line => line.includes('收到[DONE]=true')), '日志应记录 [DONE]');
		assert.ok(logs.some(line => line.includes('累计字符=')), '日志应记录累计字符数');
	} finally {
		await server.close();
	}
});
