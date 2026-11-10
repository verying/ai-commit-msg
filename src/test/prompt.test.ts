import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, CommitContext, resolveLanguage } from '../core/prompt';
import { sanitizeCommitMessage } from '../core/sanitize';

function baseContext(overrides: Partial<CommitContext> = {}): CommitContext {
	return {
		repoName: 'demo',
		branch: 'main',
		isInitialCommit: false,
		files: ['M  src/a.ts'],
		diff: 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n',
		truncated: false,
		language: 'zh-CN',
		style: 'conventional',
		extraInstructions: '',
		...overrides
	};
}

test('system 包含 Conventional Commits 与中文要求', () => {
	const [system] = buildPrompt(baseContext());
	assert.ok(system.content.includes('Conventional Commits'));
	assert.ok(system.content.includes('简体中文'));
});

test('初始提交在 user 消息中标注', () => {
	const [, user] = buildPrompt(baseContext({ isInitialCommit: true }));
	assert.ok(user.content.includes('初始提交'));
});

test('截断提示出现在 user 消息中', () => {
	const [, user] = buildPrompt(baseContext({ truncated: true }));
	assert.ok(user.content.includes('已截断'));
});

test('extraInstructions 追加到 system 末尾', () => {
	const [system] = buildPrompt(baseContext({ extraInstructions: '不要 body' }));
	assert.ok(system.content.endsWith('不要 body'));
});

test('plain 风格覆盖 type(scope) 要求', () => {
	const [system] = buildPrompt(baseContext({ style: 'plain' }));
	assert.ok(system.content.includes('不要使用 type(scope) 前缀'));
});

test('auto 语言按 CJK 内容判断', () => {
	assert.equal(resolveLanguage(baseContext({ language: 'auto', diff: '// 中文注释' })), 'zh-CN');
	assert.equal(resolveLanguage(baseContext({ language: 'auto', diff: 'const value = 1;' })), 'en');
});

test('sanitize 去除围栏与标签', () => {
	assert.equal(sanitizeCommitMessage('```\nfeat: add x\n```'), 'feat: add x');
	assert.equal(sanitizeCommitMessage('提交信息：feat: add x'), 'feat: add x');
});

test('sanitize 去除包裹引号并压缩空行', () => {
	assert.equal(sanitizeCommitMessage('"feat: add x"'), 'feat: add x');
	assert.equal(sanitizeCommitMessage('feat: add x\n\n\n\nbody'), 'feat: add x\n\nbody');
});

test('sanitize 超长截断且空输入返回空串', () => {
	const longText = 'a'.repeat(5000);
	assert.ok(sanitizeCommitMessage(longText).length <= 4000);
	assert.equal(sanitizeCommitMessage('   \n  '), '');
});
