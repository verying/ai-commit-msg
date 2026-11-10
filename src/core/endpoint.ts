export function buildChatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		throw new Error('请先在设置中配置 aiCommit.baseUrl');
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new Error('aiCommit.baseUrl 必须是 http(s) 地址');
	}

	const normalized = trimmed.replace(/\/+$/, '');
	if (normalized.endsWith('/chat/completions')) {
		return normalized;
	}
	return `${normalized}/chat/completions`;
}
