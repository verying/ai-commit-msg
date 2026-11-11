import type { Dispatcher } from 'undici';
import { buildModelsUrl, describeChatEndpoint } from './core/endpoint';
import { classifyNetworkError, formatCauseChain, isRetryableNetworkError } from './core/netError';
import { redactProxyUrl } from './core/proxy';
import { ChatMessage } from './core/prompt';
import { extractFinishReason, parseSsePayload, SseParser, SsePayloadError } from './core/sse';

type UndiciModule = typeof import('undici');
type UndiciResponse = Awaited<ReturnType<UndiciModule['fetch']>>;

let undiciModule: UndiciModule | undefined;

/**
 * 延迟加载 undici：它的入口会把 mock/websocket/eventsource/cache 一起 require 进来，
 * 实测首次约 0.6–0.8s。放在真正发请求前加载，避免拖慢每次点击生成（激活阶段）。
 */
function loadUndici(): UndiciModule {
	if (!undiciModule) {
		undiciModule = require('undici') as UndiciModule;
	}
	return undiciModule;
}

export type ApiErrorKind =
	| 'config'
	| 'auth'
	| 'rate-limit'
	| 'server'
	| 'network'
	| 'timeout'
	| 'aborted'
	| 'empty'
	| 'truncated'
	| 'model';

export class ApiError extends Error {
	readonly kind: ApiErrorKind;
	readonly status?: number;

	constructor(message: string, kind: ApiErrorKind, status?: number) {
		super(message);
		this.name = 'ApiError';
		this.kind = kind;
		this.status = status;
	}
}

export interface CompletionMeta {
	/** 是否读到 [DONE] 结束帧 */
	sawDone: boolean;
	/** 最后一帧的 finish_reason（stop / length / …） */
	finishReason?: string;
}

export interface ChatRequest {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** http(s) 代理地址；为空表示直连 */
	proxyUrl?: string;
	messages: ChatMessage[];
	temperature: number;
	/** 0 表示不发送 max_tokens，由接口默认上限决定 */
	maxTokens: number;
	stream: boolean;
	timeoutMs: number;
	signal?: AbortSignal;
	onDelta?: (accumulated: string) => void;
	onCompletion?: (meta: CompletionMeta) => void;
	onLog?: (message: string) => void;
}

interface ReadResult {
	content: string;
	meta: CompletionMeta;
}

type LogFn = (message: string) => void;

export async function requestCommitMessage(req: ChatRequest): Promise<string> {
	const log: LogFn = req.onLog ?? (() => undefined);

	let url: string;
	try {
		const endpoint = describeChatEndpoint(req.baseUrl);
		url = endpoint.url;
		if (endpoint.addedVersion) {
			log(`[地址] baseUrl 没写路径，已自动补 /v1 → ${url}`);
		}
	} catch (error) {
		throw new ApiError(errorMessage(error), 'config');
	}

	log(`[网络] 目标=${safeHost(url)} 代理=${req.proxyUrl ? redactProxyUrl(req.proxyUrl) : '未使用（直连）'}`);
	log(`[超时] 整体=${req.timeoutMs}ms 连接=${CONNECT_TIMEOUT_MS}ms（IPv4/IPv6 自动择优 autoSelectFamily=true）`);
	const dispatcher = createDispatcherOrThrow(req.proxyUrl);
	const agent = dispatcher;

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		log(`[超时] 超过 ${req.timeoutMs}ms 仍未完成，主动中止请求`);
		controller.abort();
	}, Math.max(1, req.timeoutMs));

	const externalSignal = req.signal;
	const onExternalAbort = () => {
		log('[取消] 外部取消信号，中止请求');
		controller.abort();
	};
	if (externalSignal) {
		if (externalSignal.aborted) {
			controller.abort();
		} else {
			externalSignal.addEventListener('abort', onExternalAbort, { once: true });
		}
	}

	const payload: Record<string, unknown> = {
		model: req.model,
		messages: req.messages,
		temperature: req.temperature,
		stream: req.stream
	};
	if (req.maxTokens > 0) {
		payload.max_tokens = req.maxTokens;
	}

	const promptChars = req.messages.reduce((sum, message) => sum + message.content.length, 0);
	log(`[请求] ${req.stream ? '流式' : '非流式'} model=${req.model} maxTokens=${req.maxTokens > 0 ? req.maxTokens : '未发送(0)'} temperature=${req.temperature} timeout=${req.timeoutMs}ms 提示词字符=${promptChars}`);

	try {
		const body = JSON.stringify(payload);
		let response: UndiciResponse | undefined;
		const undiciFetch = loadUndici().fetch;

		// 退避期间被用户取消或整体超时时，立即结束，不再发下一次请求
		const abortReason = (): ApiError => (timedOut
			? new ApiError(`请求超时（${Math.round(req.timeoutMs / 1000)}s）`, 'timeout')
			: new ApiError('请求已取消', 'aborted'));

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				response = await undiciFetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${req.apiKey}`,
						'Accept': req.stream ? 'text/event-stream' : 'application/json'
					},
					body,
					signal: controller.signal,
					dispatcher
				} as Parameters<typeof undiciFetch>[1]);

				log(`[响应] HTTP ${response.status} content-type=${response.headers.get('content-type') ?? '(空)'} 第${attempt}次尝试`);

				if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
					const text = await safeText(response);
					const wait = retryDelay(attempt);
					log(`[重试] 第${attempt}次失败：HTTP ${response.status} ${text.slice(0, 120)}；${wait}ms 后重试`);
					await sleep(wait);
					if (controller.signal.aborted) {
						throw abortReason();
					}
					continue;
				}

				if (!response.ok) {
					const text = await safeText(response);
					throw httpError(response.status, text, req.model);
				}
				break;
			} catch (error) {
				if (error instanceof ApiError || timedOut || controller.signal.aborted) {
					throw error;
				}
				if (attempt >= MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
					throw error;
				}
				const wait = retryDelay(attempt);
				log(`[重试] 第${attempt}次失败：${formatCauseChain(error)}；${wait}ms 后重试`);
				await sleep(wait);
				if (controller.signal.aborted) {
					throw abortReason();
				}
			}
		}

		if (!response) {
			throw new ApiError('请求在重试后仍未发出', 'network');
		}

		const contentType = response.headers.get('content-type') ?? '';
		const result = (req.stream && !contentType.includes('application/json'))
			? await readSseStream(response, req.onDelta, log)
			: await readJsonResponse(response, req.onDelta, log);

		log(`[读取] 完成，内容字符=${result.content.length} 收到[DONE]=${result.meta.sawDone} finish_reason=${result.meta.finishReason ?? '(无)'}`);

		if (!result.content) {
			throw new ApiError('模型返回为空', 'empty');
		}
		req.onCompletion?.(result.meta);
		if (result.meta.finishReason === 'length') {
			throw new ApiError('模型输出达到 max_tokens 上限，内容不完整', 'truncated');
		}
		return result.content;
	} catch (error) {
		if (error instanceof ApiError) {
			log(`[异常] kind=${error.kind} message=${error.message}`);
			throw error;
		}
		if (timedOut) {
			log('[异常] 请求超时');
			throw new ApiError(`请求超时（${Math.round(req.timeoutMs / 1000)}s）`, 'timeout');
		}
		if (externalSignal?.aborted || isAbortError(error)) {
			log('[异常] 请求已取消');
			throw new ApiError('请求已取消', 'aborted');
		}
		log(`[异常] 网络或读取错误：${errorMessage(error)}`);
		log(`[异常] cause 链：${formatCauseChain(error)}`);
		const info = classifyNetworkError(error, { proxyUrl: req.proxyUrl });
		log(`[异常] 归类 code=${info.code} reason=${info.reason} hint=${info.hint}`);
		throw new ApiError(`网络错误 ${info.code}：${info.reason}（${info.hint}）`, 'network');
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener('abort', onExternalAbort);
		if (agent) {
			void agent.close().catch(() => undefined);
		}
	}
}

async function readSseStream(response: Response, onDelta: ((accumulated: string) => void) | undefined, log: LogFn): Promise<ReadResult> {
	const body = response.body;
	if (!body) {
		throw new ApiError('响应没有可读取的流', 'server');
	}

	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let accumulated = '';
	let finished = false;
	let payloadError: Error | undefined;
	let sawDone = false;
	let finishReason: string | undefined;
	let endedBy = 'stream-end';
	let frames = 0;
	let contentFrames = 0;

	const parser = new SseParser(payload => {
		if (finished) {
			return;
		}
		frames++;
		let piece: string | 'DONE' | null;
		try {
			piece = parseSsePayload(payload);
		} catch (error) {
			payloadError = error as Error;
			finished = true;
			endedBy = 'payload-error';
			return;
		}
		const reason = extractFinishReason(payload);
		if (reason) {
			finishReason = reason;
		}
		if (piece === 'DONE') {
			sawDone = true;
			finished = true;
			endedBy = 'DONE';
			return;
		}
		if (piece === null) {
			return;
		}
		contentFrames++;
		accumulated += piece;
		onDelta?.(accumulated);
	});

	try {
		while (!finished) {
			const { done, value } = await reader.read();
			if (done || !value) {
				break;
			}
			parser.feed(decoder.decode(value, { stream: true }));
		}
		parser.feed(decoder.decode());
		parser.end();
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	log(`[SSE] 结束方式=${endedBy} 帧=${frames} 内容帧=${contentFrames} 累计字符=${accumulated.length} 收到[DONE]=${sawDone} finish_reason=${finishReason ?? '(无)'}`);
	log(`[SSE] 末段="${accumulated.slice(-60).replace(/\n/g, '\\n')}"`);

	if (payloadError) {
		throw new ApiError(payloadError.message, 'server');
	}
	return { content: accumulated, meta: { sawDone, finishReason } };
}

async function readJsonResponse(response: Response, onDelta: ((accumulated: string) => void) | undefined, log: LogFn): Promise<ReadResult> {
	let json: any;
	try {
		json = await response.json();
	} catch {
		throw new ApiError(
			`接口返回的不是 JSON（HTTP ${response.status}，content-type=${response.headers.get('content-type') ?? '(空)'}），可能被网关/代理拦截`,
			'server',
			response.status
		);
	}
	const choice = json?.choices?.[0];
	const content = typeof choice?.message?.content === 'string'
		? choice.message.content
		: typeof choice?.text === 'string'
			? choice.text
			: '';
	if (content) {
		onDelta?.(content);
	}
	log(`[JSON] 内容字符=${content.length} finish_reason=${typeof choice?.finish_reason === 'string' ? choice.finish_reason : '(无)'}`);
	return {
		content: typeof content === 'string' ? content : '',
		meta: {
			sawDone: true,
			finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
		}
	};
}

async function safeText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.slice(0, 500);
	} catch {
		return '';
	}
}

const CONNECT_TIMEOUT_MS = 10000;
/** 连接阶段最多尝试次数（首次 + 2 次重试） */
const MAX_ATTEMPTS = 3;

function createDispatcher(proxyUrl?: string): Dispatcher {
	// autoSelectFamily：同时尝试 A/AAAA，避免 IPv6 解析到了却连不通导致的间歇失败。
	// undici 6 的 BuildOptions 类型错误地要求 port（运行时由 dispatcher 补齐），这里只能断言。
	const connect = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300 } as never;
	const { Agent, ProxyAgent } = loadUndici();
	if (proxyUrl) {
		return new ProxyAgent({ uri: proxyUrl, connect, connectTimeout: CONNECT_TIMEOUT_MS });
	}
	return new Agent({ connect, connectTimeout: CONNECT_TIMEOUT_MS });
}

/** 代理地址非法（缺协议头、有未编码的特殊字符等）时给出可读的配置错误，而不是原始英文异常 */
function createDispatcherOrThrow(proxyUrl: string | undefined): Dispatcher {
	try {
		return createDispatcher(proxyUrl);
	} catch (error) {
		throw new ApiError(
			`代理地址无法使用：${redactProxyUrl(proxyUrl ?? '')}（${errorMessage(error)}）。` +
			'请检查 http.proxy 是否为 http://host:port 形式，账号密码中的特殊字符需要 URL 编码',
			'config'
		);
	}
}

function retryDelay(attempt: number): number {
	return 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 150);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function httpError(status: number, body: string, model?: string): ApiError {
	const snippet = body.trim();
	const lower = snippet.toLowerCase();
	// 把「模型不存在」和「网络/地址错误」区分开，避免用户误以为网络坏了
	if (model && (status === 400 || status === 404 || status === 422) && /model|not found|does not exist|不存在/.test(lower)) {
		return new ApiError(`模型 ${model} 不可用（HTTP ${status}）：${snippet}`, 'model', status);
	}
	const kind: ApiErrorKind = status === 401 || status === 403
		? 'auth'
		: status === 429
			? 'rate-limit'
			: status >= 500
				? 'server'
				: 'config';
	const message = snippet ? `HTTP ${status}：${snippet}` : `HTTP ${status}`;
	return new ApiError(message, kind, status);
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export interface ModelsRequest {
	baseUrl: string;
	apiKey: string;
	proxyUrl?: string;
	timeoutMs: number;
	onLog?: (message: string) => void;
}

/** 调用 /v1/models，返回去重排序后的模型 ID；用于让用户直接挑选，而不是猜模型名 */
export async function listModels(req: ModelsRequest): Promise<string[]> {
	const log: LogFn = req.onLog ?? (() => undefined);

	let url: string;
	try {
		url = buildModelsUrl(req.baseUrl);
	} catch (error) {
		throw new ApiError(errorMessage(error), 'config');
	}

	log(`[模型] GET ${remoteForLog(url)} 代理=${req.proxyUrl ? redactProxyUrl(req.proxyUrl) : '未使用（直连）'} 超时=${req.timeoutMs}ms`);
	const agent = createDispatcherOrThrow(req.proxyUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(1, req.timeoutMs));

	try {
		const fetchImpl = loadUndici().fetch;
		const response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${req.apiKey}`,
				'Accept': 'application/json'
			},
			signal: controller.signal,
			dispatcher: agent
		});

		log(`[模型] HTTP ${response.status}`);
		if (!response.ok) {
			throw httpError(response.status, await safeText(response));
		}

		let json: any;
		try {
			json = await response.json();
		} catch {
			throw new ApiError(
				`${remoteForLog(url)} 返回的不是 JSON，可能该地址不是 OpenAI 兼容接口，或中间网关拦截了请求`,
				'server',
				response.status
			);
		}
		const items: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
		const ids = items
			.map(item => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
			.filter((id): id is string => typeof id === 'string' && !!id.trim());
		return Array.from(new Set(ids)).sort();
	} catch (error) {
		if (error instanceof ApiError) {
			throw error;
		}
		if (isAbortError(error)) {
			throw new ApiError(`列出模型超时（${Math.round(req.timeoutMs / 1000)}s）`, 'timeout');
		}
		const info = classifyNetworkError(error, { proxyUrl: req.proxyUrl });
		log(`[模型] 网络错误 code=${info.code} reason=${info.reason} cause=${formatCauseChain(error)}`);
		throw new ApiError(`网络错误 ${info.code}：${info.reason}（${info.hint}）`, 'network');
	} finally {
		clearTimeout(timer);
		if (agent) {
			void agent.close().catch(() => undefined);
		}
	}
}

function remoteForLog(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url;
	}
}

function isAbortError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
