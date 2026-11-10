export class SsePayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SsePayloadError';
	}
}

export class SseParser {
	private buffer = '';
	private dataLines: string[] = [];

	constructor(private readonly onData: (payload: string) => void) { }

	feed(chunk: string): void {
		this.buffer += chunk;

		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.consumeLine(line);
		}
	}

	end(): void {
		if (this.buffer) {
			const line = this.buffer.replace(/\r$/, '');
			this.buffer = '';
			this.consumeLine(line);
		}
		this.dispatch();
	}

	private consumeLine(line: string): void {
		if (line === '') {
			this.dispatch();
			return;
		}
		if (line.startsWith(':')) {
			return;
		}
		if (line.startsWith('data:')) {
			let value = line.slice(5);
			if (value.startsWith(' ')) {
				value = value.slice(1);
			}
			this.dataLines.push(value);
		}
	}

	private dispatch(): void {
		if (this.dataLines.length === 0) {
			return;
		}
		const payload = this.dataLines.join('\n');
		this.dataLines = [];
		this.onData(payload);
	}
}

export function extractFinishReason(payload: string): string | undefined {
	const trimmed = payload.trim();
	if (!trimmed || trimmed === '[DONE]') {
		return undefined;
	}

	try {
		const reason = JSON.parse(trimmed)?.choices?.[0]?.finish_reason;
		return typeof reason === 'string' ? reason : undefined;
	} catch {
		return undefined;
	}
}

export function parseSsePayload(payload: string): string | 'DONE' | null {
	const trimmed = payload.trim();
	if (trimmed === '[DONE]') {
		return 'DONE';
	}

	let parsed: any;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	const errorMessage = parsed?.error?.message;
	if (typeof errorMessage === 'string' && errorMessage) {
		throw new SsePayloadError(errorMessage);
	}

	const choice = parsed?.choices?.[0];
	const deltaContent = choice?.delta?.content;
	if (typeof deltaContent === 'string') {
		return deltaContent;
	}
	if (typeof choice?.message?.content === 'string') {
		return choice.message.content;
	}
	if (typeof choice?.text === 'string') {
		return choice.text;
	}

	return null;
}
