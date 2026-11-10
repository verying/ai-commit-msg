import { test } from 'node:test';
import assert from 'node:assert/strict';

const vscodeMock = {
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	workspace: {
		getConfiguration: () => ({
			get: () => undefined
		})
	},
	window: {
		showWarningMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showInputBox: async () => undefined
	}
};

function loadConfig(): typeof import('../config') {
	const Module = require('module') as any;
	const originalLoad = Module._load;
	Module._load = function (request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		for (const key of Object.keys(require.cache)) {
			if (/[\\/]out[\\/]config\.js$/.test(key)) {
				delete require.cache[key];
			}
		}
		return require('../config');
	} finally {
		Module._load = originalLoad;
	}
}

function contextWith(mode: number, secret?: string): any {
	return {
		extensionMode: mode,
		subscriptions: [],
		secrets: {
			get: async () => secret,
			store: async () => undefined,
			delete: async () => undefined
		}
	};
}

test('isInsecureBaseUrl：https 一律安全', () => {
	const { isInsecureBaseUrl } = loadConfig();
	assert.equal(isInsecureBaseUrl('https://api.example.com/v1'), false);
	assert.equal(isInsecureBaseUrl('https://127.0.0.1/v1'), false);
});

test('isInsecureBaseUrl：本机 http 视为调试，不告警', () => {
	const { isInsecureBaseUrl } = loadConfig();
	assert.equal(isInsecureBaseUrl('http://localhost:11434/v1'), false);
	assert.equal(isInsecureBaseUrl('http://127.0.0.1:8080/v1'), false);
	assert.equal(isInsecureBaseUrl('http://[::1]:8080/v1'), false);
});

test('isInsecureBaseUrl：远程 http 视为明文风险', () => {
	const { isInsecureBaseUrl } = loadConfig();
	assert.equal(isInsecureBaseUrl('http://relay.example.com/v1'), true);
	assert.equal(isInsecureBaseUrl('http://10.0.0.5:3000/v1'), true);
});

test('getApiKey：SecretStorage 有值时优先使用', async () => {
	const { getApiKey } = loadConfig();
	const previous = process.env.AICOMMIT_API_KEY;
	process.env.AICOMMIT_API_KEY = 'sk-from-env';
	try {
		const key = await getApiKey(contextWith(1, 'sk-from-secret'));
		assert.equal(key, 'sk-from-secret');
	} finally {
		if (previous === undefined) {
			delete process.env.AICOMMIT_API_KEY;
		} else {
			process.env.AICOMMIT_API_KEY = previous;
		}
	}
});

test('getApiKey：生产模式下忽略 AICOMMIT_API_KEY 环境变量', async () => {
	const { getApiKey } = loadConfig();
	const previous = process.env.AICOMMIT_API_KEY;
	process.env.AICOMMIT_API_KEY = 'sk-from-env';
	try {
		const key = await getApiKey(contextWith(1));
		assert.equal(key, undefined);
	} finally {
		if (previous === undefined) {
			delete process.env.AICOMMIT_API_KEY;
		} else {
			process.env.AICOMMIT_API_KEY = previous;
		}
	}
});

test('getApiKey：开发/测试模式下允许环境变量兜底', async () => {
	const { getApiKey } = loadConfig();
	const previous = process.env.AICOMMIT_API_KEY;
	process.env.AICOMMIT_API_KEY = 'sk-from-env';
	try {
		assert.equal(await getApiKey(contextWith(2)), 'sk-from-env');
		assert.equal(await getApiKey(contextWith(3)), 'sk-from-env');
	} finally {
		if (previous === undefined) {
			delete process.env.AICOMMIT_API_KEY;
		} else {
			process.env.AICOMMIT_API_KEY = previous;
		}
	}
});
