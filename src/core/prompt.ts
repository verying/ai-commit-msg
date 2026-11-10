export interface ChatMessage {
	role: 'system' | 'user';
	content: string;
}

export interface CommitContext {
	repoName: string;
	branch: string | undefined;
	isInitialCommit: boolean;
	files: string[];
	diff: string;
	truncated: boolean;
	language: 'zh-CN' | 'en' | 'auto';
	style: 'conventional' | 'plain';
	extraInstructions: string;
}

const SYSTEM_BASE = `你是一名严格的资深软件工程师，负责为 Git 暂存区改动撰写提交信息。
硬性要求：
1. 只输出提交信息本身，不要任何解释、前缀、标题、Markdown 代码块或引号。
2. 采用 Conventional Commits：<type>(<scope>): <subject>，type 只能取 feat/fix/refactor/perf/docs/test/build/ci/chore/style/revert。
3. subject 用祈使句，不超过 72 个字符；中文时不超过 50 个汉字；结尾不加句号。
4. 若改动包含多个逻辑单元，可空一行后写 body，用 "- " 开头的要点说明「为什么改」，不要逐行复述 diff。
5. 不要编造 diff 中不存在的内容；信息不足时宁可写得更概括。
6. 破坏性变更才写 BREAKING CHANGE 脚注。`;

export function resolveLanguage(ctx: CommitContext): 'zh-CN' | 'en' {
	if (ctx.language !== 'auto') {
		return ctx.language;
	}
	const sample = `${ctx.diff}\n${ctx.files.join('\n')}`;
	return /[\u4e00-\u9fff]/.test(sample) ? 'zh-CN' : 'en';
}

export function buildPrompt(ctx: CommitContext): ChatMessage[] {
	const language = resolveLanguage(ctx);
	const systemParts = [SYSTEM_BASE];

	systemParts.push(
		language === 'zh-CN'
			? '使用简体中文撰写提交信息。'
			: 'Write the commit message in English.'
	);

	if (ctx.style === 'plain') {
		systemParts.push('不要使用 type(scope) 前缀，直接写一句概括性的提交描述。');
	}

	const extra = ctx.extraInstructions.trim();
	if (extra) {
		systemParts.push(extra);
	}

	const filesText = ctx.files.length > 0 ? ctx.files.join('\n') : '(无)';
	const branchText = ctx.isInitialCommit
		? `${ctx.branch ?? 'HEAD'}（初始提交，仓库尚无 HEAD）`
		: (ctx.branch ?? '(未知分支)');
	const truncatedNote = ctx.truncated
		? '注意：以下 diff 已截断，只包含部分文件或部分内容。'
		: '';

	const userLines = [
		`仓库：${ctx.repoName}`,
		`分支：${branchText}`,
		`暂存文件（${ctx.files.length} 个）：`,
		filesText
	];

	if (truncatedNote) {
		userLines.push(truncatedNote);
	}

	userLines.push('以下为暂存区 diff：', ctx.diff, '请只输出提交信息。');

	return [
		{ role: 'system', content: systemParts.join('\n') },
		{ role: 'user', content: userLines.join('\n') }
	];
}
