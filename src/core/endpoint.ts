export interface EndpointInfo {
	/** 最终请求地址 */
	url: string;
	/** 是否自动补了 /v1 后缀，用于日志提示 */
	addedVersion: boolean;
}

function parseBase(baseUrl: string): URL {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		throw new Error('请先在设置中配置 aiCommit.baseUrl');
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new Error('aiCommit.baseUrl 必须是 http(s) 地址');
	}
	try {
		return new URL(trimmed);
	} catch {
		throw new Error(`aiCommit.baseUrl 不是合法地址：${trimmed}`);
	}
}

/**
 * 把用户填的 baseUrl 归一化成某个接口的完整地址。
 * 规则：
 * - 末尾斜杠、查询串、锚点一律丢弃；
 * - 已经以 /chat/completions 或 /models 结尾时原样使用（避免拼成 /chat/completions/chat/completions）；
 * - 路径为空（只填了域名）时自动补 /v1；
 * - 其余情况在已有路径后追加接口名。
 */
function buildEndpoint(baseUrl: string, suffix: '/chat/completions' | '/models'): EndpointInfo {
	const parsed = parseBase(baseUrl);
	let path = parsed.pathname.replace(/\/+$/, '');

	for (const known of ['/chat/completions', '/models']) {
		if (path.endsWith(known)) {
			path = path.slice(0, -known.length);
			break;
		}
	}

	let addedVersion = false;
	if (!path) {
		path = '/v1';
		addedVersion = true;
	}

	return { url: `${parsed.origin}${path}${suffix}`, addedVersion };
}

export function describeChatEndpoint(baseUrl: string): EndpointInfo {
	return buildEndpoint(baseUrl, '/chat/completions');
}

export function buildChatCompletionsUrl(baseUrl: string): string {
	return describeChatEndpoint(baseUrl).url;
}

export function buildModelsUrl(baseUrl: string): string {
	return buildEndpoint(baseUrl, '/models').url;
}
