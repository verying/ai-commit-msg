export interface TruncatedDiff {
	text: string;
	truncated: boolean;
	omittedFiles: string[];
}

export function normalizeNewlines(input: string): string {
	return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitDiffByFile(diff: string): Array<{ header: string; body: string }> {
	const lines = diff.split('\n');
	const blocks: Array<{ header: string; body: string[] }> = [];

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			blocks.push({ header: line, body: [] });
		} else if (blocks.length === 0) {
			blocks.push({ header: line, body: [] });
		} else {
			blocks[blocks.length - 1].body.push(line);
		}
	}

	return blocks.map(block => ({
		header: block.header,
		body: block.body.join('\n')
	}));
}

export function truncateDiff(diff: string, maxChars: number): TruncatedDiff {
	const text = normalizeNewlines(diff);
	if (text.length <= maxChars) {
		return { text, truncated: false, omittedFiles: [] };
	}

	if (!/^diff --git /m.test(text)) {
		let cut = text.slice(0, maxChars);
		const newlineIndex = cut.lastIndexOf('\n');
		if (newlineIndex > 0) {
			cut = cut.slice(0, newlineIndex);
		}
		return { text: `${cut}\n…[diff 已截断]`, truncated: true, omittedFiles: [] };
	}

	const blocks = splitDiffByFile(text);
	const perFile = Math.max(1500, Math.floor((maxChars - 300) / Math.max(1, blocks.length)));
	const output: string[] = [];
	const omittedFiles: string[] = [];
	let used = 0;
	let truncated = false;

	for (const block of blocks) {
		const filePath = extractPath(block.header);
		const full = block.body ? `${block.header}\n${block.body}` : block.header;
		const limit = maxChars * 1.15;

		if (full.length <= perFile && used + full.length + 1 <= limit) {
			output.push(full);
			used += full.length + 1;
			continue;
		}

		if (used + block.header.length + 40 <= limit) {
			let cut = full.slice(0, perFile);
			const newlineIndex = cut.lastIndexOf('\n');
			if (newlineIndex > perFile * 0.5) {
				cut = cut.slice(0, newlineIndex);
			}
			output.push(`${cut}\n…[本文件 diff 已截断]`);
			used += cut.length + 40;
			truncated = true;
			continue;
		}

		output.push(`${block.header}\n…[内容已省略]`);
		used += block.header.length + 20;
		omittedFiles.push(filePath);
		truncated = true;
	}

	return { text: output.join('\n'), truncated, omittedFiles };
}

function extractPath(header: string): string {
	const match = header.match(/\sb\/(.+)$/);
	if (match) {
		return match[1].trim();
	}
	return header.replace(/^diff --git\s+/, '').trim();
}
