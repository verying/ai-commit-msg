import * as vscode from 'vscode';

export const API_KEY_SECRET = 'aiCommit.apiKey';

export interface AiConfig {
	baseUrl: string;
	model: string;
	language: 'zh-CN' | 'en' | 'auto';
	style: 'conventional' | 'plain';
	maxDiffChars: number;
	requestTimeoutMs: number;
	temperature: number;
	maxTokens: number;
	stream: boolean;
	extraInstructions: string;
}

export function readConfig(): AiConfig {
	const config = vscode.workspace.getConfiguration('aiCommit');
	const model = (config.get<string>('model') ?? '').trim();

	return {
		baseUrl: (config.get<string>('baseUrl') ?? '').trim(),
		model: model || 'gpt-4o-mini',
		language: config.get<'zh-CN' | 'en' | 'auto'>('language') ?? 'zh-CN',
		style: config.get<'conventional' | 'plain'>('style') ?? 'conventional',
		maxDiffChars: Math.max(2000, config.get<number>('maxDiffChars') ?? 120000),
		requestTimeoutMs: Math.max(5000, config.get<number>('requestTimeoutMs') ?? 60000),
		temperature: config.get<number>('temperature') ?? 0.2,
		maxTokens: Math.max(0, config.get<number>('maxTokens') ?? 0),
		stream: config.get<boolean>('stream') ?? true,
		extraInstructions: config.get<string>('extraInstructions') ?? ''
	};
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const value = await context.secrets.get(API_KEY_SECRET);
	const trimmed = value?.trim();
	if (trimmed) {
		return trimmed;
	}
	// 环境变量兜底只用于自动化端到端验证；生产构建里一律忽略，避免静默使用外部注入的 Key
	const mode = (context as { extensionMode?: number }).extensionMode;
	if (mode === vscode.ExtensionMode?.Production) {
		return undefined;
	}
	const fromEnv = process.env.AICOMMIT_API_KEY?.trim();
	return fromEnv ? fromEnv : undefined;
}

/**
 * 判断 baseUrl 是否会以明文传输密钥。
 * localhost / 127.0.0.1 / [::1] 视为本机调试，不算风险。
 */
export function isInsecureBaseUrl(baseUrl: string): boolean {
	if (!/^http:\/\//i.test(baseUrl)) {
		return false;
	}
	return !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl);
}

export async function promptAndStoreApiKey(context: vscode.ExtensionContext): Promise<boolean> {
	const value = await vscode.window.showInputBox({
		password: true,
		ignoreFocusOut: true,
		prompt: '输入中转站 API Key（只保存在 VS Code 本地 SecretStorage）',
		placeHolder: 'sk-...'
	});

	if (value === undefined) {
		return false;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		void vscode.window.showWarningMessage('API Key 不能为空');
		return false;
	}

	await context.secrets.store(API_KEY_SECRET, trimmed);
	void vscode.window.showInformationMessage('API Key 已保存到本地 SecretStorage');
	return true;
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(API_KEY_SECRET);
	void vscode.window.showInformationMessage('API Key 已清除');
}
