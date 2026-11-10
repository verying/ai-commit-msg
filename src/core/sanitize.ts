const MAX_LENGTH = 4000;

export function sanitizeCommitMessage(raw: string): string {
	let text = raw
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n')
		.trim();

	const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
	if (fenced) {
		text = fenced[1].trim();
	}

	text = text.replace(/^(提交信息|提交说明|Commit message|Message)\s*[:：]\s*/i, '');
	text = stripWrappingQuotes(text);
	text = text.replace(/\n{3,}/g, '\n\n').trim();

	if (text.length > MAX_LENGTH) {
		let cut = text.slice(0, MAX_LENGTH);
		const newlineIndex = cut.lastIndexOf('\n');
		if (newlineIndex > 500) {
			cut = cut.slice(0, newlineIndex);
		}
		text = cut.trim();
	}

	return text;
}

function stripWrappingQuotes(text: string): string {
	const pairs: Array<[string, string]> = [
		['"', '"'],
		["'", "'"],
		['“', '”'],
		['‘', '’']
	];

	for (const [left, right] of pairs) {
		if (text.length >= 2 && text.startsWith(left) && text.endsWith(right)) {
			return text.slice(1, -1).trim();
		}
	}

	return text;
}
