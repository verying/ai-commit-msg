import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildChatCompletionsUrl, buildModelsUrl } from '../core/endpoint';
import { classifyNetworkError, formatCauseChain, isRetryableNetworkError } from '../core/netError';
import { decideProxy, matchesNoProxy } from '../core/proxy';
import { ApiError, requestCommitMessage } from '../apiClient';

function withCode(code: string, extra: Record<string, unknown> = {}): Error {
	const inner: any = new Error(`boom ${code}`);
	inner.code = code;
	Object.assign(inner, extra);
	const outer: any = new TypeError('fetch failed');
	outer.cause = inner;
	return outer;
}

test('baseUrl 归一化：末尾斜杠、缺路径、已带接口后缀', () => {
	assert.equal(buildChatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
	assert.equal(buildChatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
	assert.equal(buildChatCompletionsUrl('https://api.example.com/'), 'https://api.example.com/v1/chat/completions');
	assert.equal(buildChatCompletionsUrl('https://api.example.com'), 'https://api.example.com/v1/chat/completions');
	assert.equal(
		buildChatCompletionsUrl('https://api.example.com/v1/chat/completions'),
		'https://api.example.com/v1/chat/completions'
	);
	assert.equal(
		buildChatCompletionsUrl('https://api.example.com/v1/chat/completions/'),
		'https://api.example.com/v1/chat/completions'
	);
	assert.equal(buildModelsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models');
	assert.equal(buildModelsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models');
	assert.throws(() => buildChatCompletionsUrl('api.example.com/v1'), /必须是 http\(s\) 地址/);
	assert.throws(() => buildChatCompletionsUrl('  '), /aiCommit\.baseUrl/);
});

test('decideProxy：设置优先于环境变量', () => {
	const decision = decideProxy('https://api.example.com/v1/chat/completions', {
		setting: 'http://127.0.0.1:7890',
		env: { HTTPS_PROXY: 'http://10.0.0.1:8080' }
	});
	assert.equal(decision.proxyUrl, 'http://127.0.0.1:7890');
	assert.equal(decision.source, 'setting');
});

test('decideProxy：没有设置时读环境变量，并区分 http/https', () => {
	const httpsDecision = decideProxy('https://api.example.com/v1', { env: { HTTPS_PROXY: 'http://10.0.0.1:8080' } });
	assert.equal(httpsDecision.proxyUrl, 'http://10.0.0.1:8080');
	assert.equal(httpsDecision.source, 'env');

	const httpDecision = decideProxy('http://127.0.0.1:9000/v1', { env: { HTTP_PROXY: 'http://10.0.0.2:3128' } });
	assert.equal(httpDecision.proxyUrl, 'http://10.0.0.2:3128');
});

test('decideProxy：direct / proxySupport=off / NO_PROXY 都直连', () => {
	assert.equal(decideProxy('https://api.example.com/v1', { setting: 'direct', env: { HTTPS_PROXY: 'http://p:1' } }).proxyUrl, undefined);
	assert.equal(decideProxy('https://api.example.com/v1', { support: 'off', setting: 'http://p:1' }).source, 'none');

	const bypass = decideProxy('https://api.example.com/v1', {
		setting: 'http://p:1',
		env: { NO_PROXY: '.example.com' }
	});
	assert.equal(bypass.source, 'bypass');
	assert.equal(bypass.proxyUrl, undefined, '命中 NO_PROXY 时必须直连，不能把代理地址继续往下传');
	assert.match(bypass.detail, /NO_PROXY/);
});

test('matchesNoProxy 支持 *、精确、后缀与 host:port', () => {
	assert.equal(matchesNoProxy('a.com', 443, '*'), true);
	assert.equal(matchesNoProxy('a.com', 443, 'a.com'), true);
	assert.equal(matchesNoProxy('x.a.com', 443, '.a.com'), true);
	assert.equal(matchesNoProxy('a.com', 443, 'a.com:443'), true);
	assert.equal(matchesNoProxy('a.com', 443, 'b.com'), false);
});

test('socks 代理暂不支持时退回环境变量并记录原因', () => {
	const decision = decideProxy('https://api.example.com/v1', {
		setting: 'socks5://127.0.0.1:1080',
		env: { HTTPS_PROXY: 'http://10.0.0.1:8080' }
	});
	assert.equal(decision.proxyUrl, 'http://10.0.0.1:8080');

	const none = decideProxy('https://api.example.com/v1', { setting: 'socks5://127.0.0.1:1080', env: {} });
	assert.equal(none.proxyUrl, undefined);
	assert.match(none.detail, /暂不支持/);
});

test('网络错误分类与 cause 链', () => {
	const dns = classifyNetworkError(withCode('ENOTFOUND'));
	assert.equal(dns.code, 'ENOTFOUND');
	assert.match(dns.reason, /域名解析失败/);

	const refusedWithProxy = classifyNetworkError(withCode('ECONNREFUSED'), { proxyUrl: 'http://127.0.0.1:7890' });
	assert.match(refusedWithProxy.hint, /代理 http:\/\/127\.0\.0\.1:7890/);

	const chain = formatCauseChain(withCode('ECONNRESET', { errno: -4077, syscall: 'read', hostname: 'api.example.com' }));
	assert.match(chain, /code=ECONNRESET/);
	assert.match(chain, /errno=-4077/);
	assert.match(chain, /syscall=read/);
	assert.match(chain, /hostname=api\.example\.com/);

	assert.equal(isRetryableNetworkError(withCode('EAI_AGAIN')), true);
	assert.equal(isRetryableNetworkError(withCode('UND_ERR_CONNECT_TIMEOUT')), true);
	assert.equal(isRetryableNetworkError(withCode('ENOTFOUND')), false);
});

function startServer(handler: http.RequestListener): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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

test('5xx 会在连接阶段重试，最终成功', async () => {
	let attempts = 0;
	const logs: string[] = [];
	const server = await startServer((req, res) => {
		attempts++;
		req.resume();
		if (attempts < 3) {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'temporarily unavailable' }));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ choices: [{ message: { content: 'feat: ok' } }] }));
	});

	try {
		const content = await requestCommitMessage({
			baseUrl: server.baseUrl,
			apiKey: 'k',
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0,
			maxTokens: 0,
			stream: false,
			timeoutMs: 15000,
			onLog: line => logs.push(line)
		});
		assert.equal(content, 'feat: ok');
		assert.equal(attempts, 3);
		assert.ok(logs.some(line => line.includes('[重试] 第1次失败：HTTP 503')));
		assert.ok(logs.some(line => line.includes('[重试] 第2次失败：HTTP 503')));
	} finally {
		await server.close();
	}
});

test('4xx 不重试，直接报错', async () => {
	let attempts = 0;
	const server = await startServer((req, res) => {
		attempts++;
		req.resume();
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
	});

	try {
		await assert.rejects(
			() => requestCommitMessage({
				baseUrl: server.baseUrl,
				apiKey: 'bad',
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				temperature: 0,
				maxTokens: 0,
				stream: false,
				timeoutMs: 15000
			}),
			(error: unknown) => error instanceof ApiError && error.kind === 'auth'
		);
		assert.equal(attempts, 1);
	} finally {
		await server.close();
	}
});

test('连接被重置会立即重试一次并成功', async () => {
	let attempts = 0;
	const logs: string[] = [];
	const server = await startServer((req, res) => {
		attempts++;
		req.resume();
		if (attempts === 1) {
			req.socket.destroy();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ choices: [{ message: { content: 'fix: ok' } }] }));
	});

	try {
		const content = await requestCommitMessage({
			baseUrl: server.baseUrl,
			apiKey: 'k',
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0,
			maxTokens: 0,
			stream: false,
			timeoutMs: 15000,
			onLog: line => logs.push(line)
		});
		assert.equal(content, 'fix: ok');
		assert.equal(attempts, 2);
		assert.ok(logs.some(line => line.includes('[重试] 第1次失败')));
	} finally {
		await server.close();
	}
});

test('NO_PROXY 支持通配前缀、端口限定与子域，CIDR 不误命中', () => {
	assert.equal(matchesNoProxy('x.a.com', 443, '*.a.com'), true);
	assert.equal(matchesNoProxy('a.com', 443, '*.a.com'), true);
	assert.equal(matchesNoProxy('a.com', 8443, 'a.com:443'), false);
	assert.equal(matchesNoProxy('a.com', 443, '.a.com:443'), true);
	assert.equal(matchesNoProxy('a.com', 443, '10.0.0.0/8'), false);
	assert.equal(matchesNoProxy('::1', 443, '[::1]:443'), true);
	assert.equal(matchesNoProxy('a.com', 443, ' a.com , b.com '), true);
});

test('日志与提示里的代理账号密码会打码', () => {
	const decision = decideProxy('https://api.example.com/v1', {
		setting: 'http://user:s3cret@127.0.0.1:7890',
		env: {}
	});
	assert.equal(decision.proxyUrl, 'http://user:s3cret@127.0.0.1:7890', '真正连接时仍需完整凭据');
	assert.ok(!decision.detail.includes('s3cret'), `detail 不应泄露密码：${decision.detail}`);
	assert.match(decision.detail, /user:\*\*\*/);

	const hint = classifyNetworkError(withCode('ECONNREFUSED'), { proxyUrl: 'http://user:s3cret@h:1' }).hint;
	assert.ok(!hint.includes('s3cret'), `错误提示不应泄露密码：${hint}`);
});

test('非法代理地址归类为配置错误，而不是网络错误', async () => {
	await assert.rejects(
		() => requestCommitMessage({
			baseUrl: 'https://api.example.com/v1',
			apiKey: 'k',
			model: 'm',
			proxyUrl: 'not-a-url',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0,
			maxTokens: 0,
			stream: false,
			timeoutMs: 5000
		}),
		(error: unknown) => error instanceof ApiError && error.kind === 'config' && /代理地址无法使用/.test(error.message)
	);
});

test('模型不存在归类为 model，不报网络错误', async () => {
	const server = await startServer((req, res) => {
		req.resume();
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'The model `gpt-x` does not exist' } }));
	});

	try {
		await assert.rejects(
			() => requestCommitMessage({
				baseUrl: server.baseUrl,
				apiKey: 'k',
				model: 'gpt-x',
				messages: [{ role: 'user', content: 'hi' }],
				temperature: 0,
				maxTokens: 0,
				stream: false,
				timeoutMs: 15000
			}),
			(error: unknown) => error instanceof ApiError && error.kind === 'model'
		);
	} finally {
		await server.close();
	}
});

test('退避等待中取消：立刻结束，不再发下一次请求', async () => {
	let attempts = 0;
	const server = await startServer((req, res) => {
		attempts++;
		req.resume();
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end('{"error":"busy"}');
	});

	try {
		const controller = new AbortController();
		const pending = requestCommitMessage({
			baseUrl: server.baseUrl,
			apiKey: 'k',
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0,
			maxTokens: 0,
			stream: false,
			timeoutMs: 30000,
			signal: controller.signal
		});
		setTimeout(() => controller.abort(), 120);

		await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'aborted');
		assert.equal(attempts, 1, '取消后不能再发请求');
	} finally {
		await server.close();
	}
});

test('流式已开始输出后连接中断：不重发请求', async () => {
	let attempts = 0;
	const server = await startServer((req, res) => {
		attempts++;
		req.resume();
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.write('data: {"choices":[{"delta":{"content":"feat: partial"}}]}\n\n');
		setTimeout(() => req.socket.destroy(), 50);
	});

	try {
		await assert.rejects(
			() => requestCommitMessage({
				baseUrl: server.baseUrl,
				apiKey: 'k',
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				temperature: 0,
				maxTokens: 0,
				stream: true,
				timeoutMs: 15000
			}),
			(error: unknown) => error instanceof ApiError && error.kind === 'network'
		);
		assert.equal(attempts, 1, '流式开始后不能重试，否则内容会重复');
	} finally {
		await server.close();
	}
});
