import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNewlines, splitDiffByFile, truncateDiff } from '../core/truncate';

function fileBlock(path: string, bodyLength: number): string {
	const body = 'x'.repeat(bodyLength);
	return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
}

test('短 diff 原样返回', () => {
	const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n';
	assert.equal(truncateDiff(diff, diff.length).text, diff);
	assert.equal(truncateDiff(diff, diff.length).truncated, false);
});

test('多文件超长时保留所有文件头并截断', () => {
	const diff = [fileBlock('a.txt', 3000), fileBlock('b.txt', 3000), fileBlock('c.txt', 3000)].join('\n');
	const result = truncateDiff(diff, 6000);
	const headers = result.text.split('\n').filter(line => line.startsWith('diff --git '));
	assert.equal(headers.length, 3);
	assert.equal(result.truncated, true);
	assert.ok(result.text.length <= 6000 * 1.2);
});

test('单文件超长时追加截断标记且保留文件头', () => {
	const diff = fileBlock('big.txt', 5000);
	const result = truncateDiff(diff, 2000);
	assert.ok(result.text.includes('diff --git a/big.txt b/big.txt'));
	assert.ok(result.text.includes('[本文件 diff 已截断]'));
	assert.equal(result.truncated, true);
});

test('CRLF 输入被归一化', () => {
	const diff = fileBlock('a.txt', 50).replace(/\n/g, '\r\n');
	const result = truncateDiff(diff, 1000);
	assert.ok(!result.text.includes('\r'));
});

test('无 diff 文件头时硬截断', () => {
	const text = 'y'.repeat(3000);
	const result = truncateDiff(text, 1000);
	assert.ok(result.text.endsWith('[diff 已截断]'));
	assert.ok(result.text.length <= 1100);
});

test('预算不足的文件进入 omittedFiles', () => {
	const diff = [1, 2, 3, 4, 5, 6]
		.map(index => fileBlock(`file${index}.txt`, 2200))
		.join('\n');
	const result = truncateDiff(diff, 3000);
	assert.ok(result.omittedFiles.length > 0);
	assert.ok(result.omittedFiles.some(path => path.includes('file6.txt')));
});

test('splitDiffByFile 以每个 diff --git 为一块', () => {
	const blocks = splitDiffByFile(fileBlock('a.txt', 10) + '\n' + fileBlock('b.txt', 10));
	assert.equal(blocks.length, 2);
	assert.ok(blocks[0].header.includes('a.txt'));
	assert.ok(blocks[1].header.includes('b.txt'));
});

test('normalizeNewlines 处理 CRLF 与 CR', () => {
	assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
});
