export interface ProxyDecision {
	/** 需要走代理时给出代理地址；直连时为空 */
	proxyUrl?: string;
	/** 决策来源，便于在日志里说明"为什么用了/没用代理" */
	source: 'none' | 'setting' | 'env' | 'bypass';
	detail: string;
}

export interface ProxyInputs {
	/** VS Code 的 http.proxy 设置 */
	setting?: string;
	/** VS Code 的 http.proxySupport 设置：off / on / override / fallback */
	support?: string;
	/** 默认取 process.env */
	env?: NodeJS.ProcessEnv;
}

function normalizeProxy(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	if (!/^https?:\/\//i.test(trimmed)) {
		return undefined;
	}
	try {
		// 统一成规范形式：去掉末尾斜杠，顺带验证 URL 合法（非法代理地址在这里就会暴露）
		const parsed = new URL(trimmed);
		return parsed.toString().replace(/\/+$/, '');
	} catch {
		return undefined;
	}
}

/** 代理地址里常带账号密码，日志和弹窗里必须打码，避免用户贴日志时泄露凭据 */
export function redactProxyUrl(value: string): string {
	if (!value) {
		return value;
	}
	try {
		const parsed = new URL(value);
		if (parsed.password) {
			parsed.password = '***';
		}
		return parsed.toString().replace(/\/+$/, '');
	} catch {
		return value;
	}
}

function normalizeHost(host: string): string {
	const lower = host.toLowerCase();
	return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

interface NoProxyEntry {
	host: string;
	port?: number;
}

/**
 * 解析单条 NO_PROXY：支持
 * - `*`
 * - `example.com` / `.example.com` / `*.example.com`（含子域）
 * - `example.com:8080` / `.example.com:8080`
 * - `[::1]` / `[::1]:8080`
 * 不支持 CIDR（如 10.0.0.0/8），这类条目会被忽略而不是误命中。
 */
function parseNoProxyEntry(raw: string): NoProxyEntry | undefined {
	let value = raw.trim().toLowerCase();
	if (!value || value === '*') {
		return undefined;
	}
	if (value.startsWith('*.')) {
		value = value.slice(1);
	}
	value = value.replace(/^\.+/, '').replace(/\.+$/, '');
	if (!value) {
		return undefined;
	}

	let host = value;
	let port: number | undefined;
	const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
	if (bracketed) {
		host = bracketed[1];
		if (bracketed[2]) {
			port = Number(bracketed[2]);
		}
	} else {
		const colon = value.lastIndexOf(':');
		if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
			host = value.slice(0, colon);
			port = Number(value.slice(colon + 1));
		}
	}
	if (!host || host.includes('/')) {
		// 含 "/" 的是 CIDR 之类的写法，当前不支持，直接忽略
		return undefined;
	}
	return { host: normalizeHost(host), port };
}

export function matchesNoProxy(hostname: string, port: number, noProxy: string | undefined): boolean {
	if (!noProxy) {
		return false;
	}
	const host = normalizeHost(hostname);
	for (const raw of noProxy.split(',')) {
		if (raw.trim() === '*') {
			return true;
		}
		const entry = parseNoProxyEntry(raw);
		if (!entry) {
			continue;
		}
		if (entry.port !== undefined && entry.port !== port) {
			continue;
		}
		if (host === entry.host || host.endsWith(`.${entry.host}`)) {
			return true;
		}
	}
	return false;
}

function envProxyFor(target: URL, env: NodeJS.ProcessEnv): { url?: string; key?: string } {
	const isHttps = target.protocol === 'https:';
	const keys = isHttps
		? ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
		: ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];
	for (const key of keys) {
		const value = normalizeProxy(env[key] ?? '');
		if (value) {
			return { url: value, key };
		}
	}
	return {};
}

/**
 * 决定一次请求是否走代理。
 * 优先级与 VS Code 一致：http.proxy 设置 > 环境变量；http.proxySupport=off 时一律直连；
 * 命中 NO_PROXY 时直连。
 */
export function decideProxy(targetUrl: string, inputs: ProxyInputs = {}): ProxyDecision {
	const env = inputs.env ?? process.env;
	const support = (inputs.support ?? '').trim().toLowerCase();
	if (support === 'off') {
		return { source: 'none', detail: 'http.proxySupport=off，强制直连' };
	}

	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return { source: 'none', detail: '目标地址无法解析，跳过代理判断' };
	}

	const setting = (inputs.setting ?? '').trim();
	if (/^direct$/i.test(setting)) {
		return { source: 'none', detail: 'http.proxy=direct，强制直连' };
	}

	let proxyUrl: string | undefined;
	let origin = '';
	let unsupportedSetting = '';
	if (setting) {
		const normalized = normalizeProxy(setting);
		if (normalized) {
			proxyUrl = normalized;
			origin = 'http.proxy';
		} else {
			// socks / pac / 缺协议头的地址当前不支持，退回环境变量，避免误以为已经套上代理
			unsupportedSetting = setting;
		}
	}

	if (!proxyUrl) {
		const fromEnv = envProxyFor(target, env);
		proxyUrl = fromEnv.url;
		if (fromEnv.key) {
			origin = fromEnv.key;
		}
	}

	const ignored = unsupportedSetting
		? `（http.proxy=${unsupportedSetting} 暂不支持，仅识别 http(s):// 形式的代理地址）`
		: '';

	if (!proxyUrl) {
		return { source: 'none', detail: `未配置代理，直连${ignored || '（也未读到 HTTPS_PROXY/HTTP_PROXY）'}` };
	}

	const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
	const noProxy = env.no_proxy ?? env.NO_PROXY;
	const shown = redactProxyUrl(proxyUrl);
	if (matchesNoProxy(target.hostname, port, noProxy)) {
		return { source: 'bypass', detail: `${origin}=${shown} 但命中 NO_PROXY=${noProxy}，直连${ignored}` };
	}

	return {
		source: origin === 'http.proxy' ? 'setting' : 'env',
		proxyUrl,
		detail: `${origin}=${shown}${ignored}`
	};
}
