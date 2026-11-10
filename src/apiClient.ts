import { buildChatCompletionsUrl } from './core/endpoint';
import { ChatMessage } from './core/prompt';
import { extractFinishReason, parseSsePayload, SseParser, SsePayloadError } from './core/sse';

export type ApiErrorKind =
	| 'config'
	| 'auth'
	| 'rate-limit'
	| 'server'
	| 'network'
	| 'timeout'
	| 'aborted'
	| 'empty'
	| 'truncated';

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
		url = buildChatCompletionsUrl(req.baseUrl);
	} catch (error) {
		throw new ApiError(errorMessage(error), 'config');
	}

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
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${req.apiKey}`,
				'Accept': req.stream ? 'text/event-stream' : 'application/json'
			},
			body: JSON.stringify(payload),
			signal: controller.signal
		});

		log(`[响应] HTTP ${response.status} content-type=${response.headers.get('content-type') ?? '(空)'}`);

		if (!response.ok) {
			const body = await safeText(response);
			throw httpError(response.status, body);
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
		throw new ApiError(`请求失败：${errorMessage(error)}`, 'network');
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener('abort', onExternalAbort);
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
	const json: any = await response.json();
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

function httpError(status: number, body: string): ApiError {
	const snippet = body.trim();
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

function isAbortError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
