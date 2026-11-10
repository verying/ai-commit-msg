import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';

export const EXPECTED_MESSAGE = `feat(sales): 新增门店现车配车流程

- 新增 V2 批售订单比对，支持按门店维度查看差异
- 补充大定渠道与买断车的配车校验
- 修复门店现车分配弹窗的空值判断`;

/** 模拟中转站在流式下提前掐断：正好停在「- 补充大定渠道与」 */
export const TRUNCATED_MESSAGE = `feat(sales): 新增门店现车配车流程

- 新增 V2 批售订单比对，支持按门店维度查看差异
- 补充大定渠道与`;

function splitIntoChunks(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += size) {
		chunks.push(text.slice(index, index + size));
	}
	return chunks;
}

function readBody(req: http.IncomingMessage): Promise<any> {
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

interface MockServer {
	baseUrl: string;
	/** true：流式请求只吐半句就断开（不发 finish_reason / [DONE]） */
	setTruncateStream: (value: boolean) => void;
	close: () => void;
}

function startMockServer(): Promise<MockServer> {
	return new Promise(resolve => {
		let truncateStream = false;

		const server = http.createServer(async (req, res) => {
			const body = await readBody(req);
			if (!req.url?.includes('/chat/completions')) {
				res.writeHead(404);
				res.end();
				return;
			}

			// 非流式：始终返回完整内容
			if (body.stream === false) {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ choices: [{ message: { content: EXPECTED_MESSAGE }, finish_reason: 'stop' }] }));
				return;
			}

			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
			if (truncateStream) {
				// 只发半句，然后直接断开：不写 finish_reason、不写 [DONE]
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: TRUNCATED_MESSAGE } }] })}\n\n`);
				res.end();
				return;
			}

			for (const chunk of splitIntoChunks(EXPECTED_MESSAGE, 12)) {
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
			}
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
			res.write('data: [DONE]\n\n');
			res.end();
		});

		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as { port: number };
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				setTruncateStream: value => {
					truncateStream = value;
				},
				close: () => server.close()
			});
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const normalize = (value: string): string => value.replace(/\r\n/g, '\n');

async function waitForStagedRepo(timeoutMs: number): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const gitExtension = vscode.extensions.getExtension('vscode.git');
		if (gitExtension) {
			const api = gitExtension.exports.getAPI(1);
			if (api.state === 'initialized' && api.repositories.length > 0) {
				const repo = api.repositories[0];
				if (repo.state.indexChanges.length > 0) {
					return repo;
				}
			}
		}
		await delay(500);
	}
	throw new Error('等待 Git 仓库与暂存文件超时');
}

export async function run(): Promise<void> {
	const server = await startMockServer();

	const configuration = vscode.workspace.getConfiguration('aiCommit');
	await configuration.update('baseUrl', server.baseUrl, vscode.ConfigurationTarget.Global);
	await configuration.update('model', 'e2e-model', vscode.ConfigurationTarget.Global);
	await configuration.update('stream', true, vscode.ConfigurationTarget.Global);

	const repo = await waitForStagedRepo(30000);

	// 场景一：正常流式，完整内容必须一次性落进真实 SCM 输入框
	repo.inputBox.value = '';
	await vscode.commands.executeCommand('aiCommit.generate');

	const actual = repo.inputBox.value;
	assert.equal(
		normalize(actual),
		normalize(EXPECTED_MESSAGE),
		`输入框内容应与完整生成结果一致；实际长度=${actual.length} 期望长度=${EXPECTED_MESSAGE.length} 实际原文=${JSON.stringify(actual)}`
	);

	await delay(1500);
	assert.equal(normalize(repo.inputBox.value), normalize(EXPECTED_MESSAGE), '1.5 秒后输入框内容仍应保持完整');

	// 场景二：流式被中转站掐断在半句，扩展应自动用非流式补全后写入
	repo.inputBox.value = '';
	server.setTruncateStream(true);
	await vscode.commands.executeCommand('aiCommit.generate');

	const recovered = repo.inputBox.value;
	assert.equal(
		normalize(recovered),
		normalize(EXPECTED_MESSAGE),
		`流式截断后应改用非流式完整内容；实际长度=${recovered.length} 实际原文=${JSON.stringify(recovered)}`
	);

	server.close();
}
