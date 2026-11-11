import { redactProxyUrl } from './proxy';

export interface NetErrorInfo {
	/** 归一化后的错误码，例如 ENOTFOUND / ECONNREFUSED */
	code: string;
	/** 中文原因 */
	reason: string;
	/** 排查建议 */
	hint: string;
}

interface CauseItem {
	code?: string;
	message?: string;
	errno?: string | number;
	syscall?: string;
	hostname?: string;
	name?: string;
}

function pick(current: any): CauseItem {
	return {
		name: typeof current.name === 'string' ? current.name : undefined,
		code: typeof current.code === 'string' ? current.code : undefined,
		message: typeof current.message === 'string' ? current.message : undefined,
		errno: typeof current.errno === 'string' || typeof current.errno === 'number' ? current.errno : undefined,
		syscall: typeof current.syscall === 'string' ? current.syscall : undefined,
		hostname: typeof current.hostname === 'string' ? current.hostname : undefined
	};
}

/** 展开 error.cause 链，undici 会把真实原因塞在 cause（有时是 AggregateError）里 */
export function collectCauses(error: unknown): CauseItem[] {
	const items: CauseItem[] = [];
	const seen = new Set<unknown>();
	let current: any = error;
	let depth = 0;
	while (current && typeof current === 'object' && depth < 6 && !seen.has(current)) {
		seen.add(current);
		items.push(pick(current));
		if (Array.isArray(current.errors)) {
			for (const inner of current.errors) {
				if (inner && typeof inner === 'object') {
					items.push(pick(inner));
				}
			}
		}
		current = current.cause;
		depth++;
	}
	return items;
}

/** 把完整 cause 链压成一行，用于日志定位 */
export function formatCauseChain(error: unknown): string {
	const parts = collectCauses(error).map(item => {
		const fields = [
			item.name,
			item.code && `code=${item.code}`,
			item.errno !== undefined && `errno=${item.errno}`,
			item.syscall && `syscall=${item.syscall}`,
			item.hostname && `hostname=${item.hostname}`,
			item.message
		].filter(Boolean);
		return fields.join(' ');
	});
	return parts.join(' <- ') || String(error);
}

const RETRYABLE_CODES = new Set([
	'EAI_AGAIN',
	'ECONNRESET',
	'ECONNREFUSED',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_HEADERS_TIMEOUT',
	'ETIMEDOUT',
	'EPIPE'
]);

/** 是否值得立即重试（连接阶段的瞬时故障） */
export function isRetryableNetworkError(error: unknown): boolean {
	return collectCauses(error).some(item => !!item.code && RETRYABLE_CODES.has(item.code));
}

const CODE_TABLE: Record<string, { reason: string; hint: string }> = {
	ENOTFOUND: { reason: '域名解析失败', hint: '检查 baseUrl 是否拼错、本机 DNS 是否可用；公司网络可能需要代理' },
	EAI_AGAIN: { reason: 'DNS 临时解析失败', hint: '多半是 DNS 或代理不稳，稍后重试；若配置了代理，确认代理服务在运行' },
	ENODATA: { reason: '域名没有可用记录', hint: '确认域名拼写正确' },
	ECONNREFUSED: { reason: '连接被拒绝', hint: '目标端口没有服务在监听：确认中转站地址/端口正确，配置了代理则确认代理软件已启动' },
	ECONNRESET: { reason: '连接被对端重置', hint: '常见于代理或防火墙掐断连接，可重试或换网络' },
	EPIPE: { reason: '连接被提前关闭', hint: '可重试；持续失败请检查代理或中转站' },
	EHOSTUNREACH: { reason: '主机不可达', hint: '检查网络路由、VPN 是否正常' },
	ENETUNREACH: { reason: '网络不可达', hint: '检查本机网络连接' },
	ETIMEDOUT: { reason: '连接超时', hint: '目标或代理长时间无响应，可调大 aiCommit.requestTimeoutMs 或检查代理' },
	ECONNABORTED: { reason: '连接被中止', hint: '可重试；持续失败请检查网络设备' },
	EPROTO: { reason: 'TLS 握手失败（协议不匹配）', hint: '很可能把 https 地址填成了 http 端口，或反过来' },
	CERT_HAS_EXPIRED: { reason: 'TLS 证书已过期', hint: '中转站证书过期，或代理在做证书替换（如企业抓包）' },
	DEPTH_ZERO_SELF_SIGNED_CERT: { reason: 'TLS 证书是自签名的', hint: '自建中转站请换正式证书，或把 baseUrl 改回 https 受信任域名' },
	SELF_SIGNED_CERT_IN_CHAIN: { reason: 'TLS 证书链中有自签名证书', hint: '多为企业代理抓包，需安装公司根证书' },
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: { reason: 'TLS 证书无法验证', hint: '证书链不完整或被中间人替换，检查代理' },
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: { reason: '找不到证书签发者', hint: '本机缺少根证书，企业网络请安装公司根证书' },
	ERR_TLS_CERT_ALTNAME_INVALID: { reason: 'TLS 证书与域名不匹配', hint: 'baseUrl 域名与证书不一致，检查是否填错域名' },
	UND_ERR_CONNECT_TIMEOUT: { reason: '建立连接超时', hint: '网络或代理不通，可先直连测试；必要时调大 aiCommit.requestTimeoutMs' },
	UND_ERR_HEADERS_TIMEOUT: { reason: '等待响应头超时', hint: '中转站响应太慢或代理卡住，可调大 aiCommit.requestTimeoutMs' },
	UND_ERR_BODY_TIMEOUT: { reason: '读取响应体超时', hint: '中转站返回过慢，可调大 aiCommit.requestTimeoutMs' },
	UND_ERR_SOCKET: { reason: '连接套接字异常关闭', hint: '多为代理或中转站中途断开，可重试' }
};

export function classifyNetworkError(error: unknown, context: { proxyUrl?: string } = {}): NetErrorInfo {
	const causes = collectCauses(error);
	const codes = causes.map(item => item.code).filter((code): code is string => !!code);
	const code = codes.find(candidate => CODE_TABLE[candidate]) ?? codes[0] ?? 'UNKNOWN';
	const known = CODE_TABLE[code];

	const rawMessage = causes.map(item => item.message).filter(Boolean).join(' | ') || String(error);

	let hint = known?.hint ?? `原始错误：${rawMessage}`;
	if (context.proxyUrl && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNRESET/.test(code)) {
		// 代理地址可能带账号密码：写进提示和日志前先打码
		hint = `当前经过代理 ${redactProxyUrl(context.proxyUrl)}。${hint}；也可把 http.proxy 设为 direct 直连对比排查`;
	}

	return {
		code,
		reason: known?.reason ?? '未知网络错误',
		hint
	};
}
