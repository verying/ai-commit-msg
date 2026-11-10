import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatCompletionsUrl } from '../core/endpoint';
import { parseSsePayload, SseParser } from '../core/sse';

test('baseUrl 归一化', () => {
	assert.equal(buildChatCompletionsUrl('https://relay.example.com/v1'), 'https://relay.example.com/v1/chat/completions');
	assert.equal(buildChatCompletionsUrl('https://relay.example.com/v1/'), 'https://relay.example.com/v1/chat/completions');
	assert.equal(
		buildChatCompletionsUrl('https://relay.example.com/v1/chat/completions'),
		'https://relay.example.com/v1/chat/completions'
	);
});

test('非法 baseUrl 抛错', () => {
	assert.throws(() => buildChatCompletionsUrl(''), /配置/);
	assert.throws(() => buildChatCompletionsUrl('ftp://example.com/v1'), /http/);
});

test('SSE 帧跨块拆分仍能正确派发', () => {
	const payloads: string[] = [];
	const parser = new SseParser(payload => payloads.push(payload));
	const frame = 'data: {"choices":[{"delta":{"content":"feat"}}]}\n\n';
	parser.feed(frame.slice(0, 12));
	parser.feed(frame.slice(12, 35));
	parser.feed(frame.slice(35));
	parser.end();
	assert.equal(payloads.length, 1);
	assert.equal(parseSsePayload(payloads[0]), 'feat');
});

test('多帧与 [DONE] 都会派发', () => {
	const payloads: string[] = [];
	const parser = new SseParser(payload => payloads.push(payload));
	parser.feed('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
	parser.feed('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
	parser.feed('data: [DONE]\n\n');
	parser.end();
	assert.equal(payloads.length, 3);
	assert.equal(parseSsePayload(payloads[2]), 'DONE');
});

test('CRLF 帧正常解析', () => {
	const payloads: string[] = [];
	const parser = new SseParser(payload => payloads.push(payload));
	parser.feed('data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\n');
	parser.end();
	assert.equal(payloads.length, 1);
	assert.equal(parseSsePayload(payloads[0]), 'x');
});

test('parseSsePayload 支持 delta/message/text/无效 JSON', () => {
	assert.equal(parseSsePayload('{"choices":[{"delta":{"content":"a"}}]}'), 'a');
	assert.equal(parseSsePayload('{"choices":[{"message":{"content":"b"}}]}'), 'b');
	assert.equal(parseSsePayload('{"choices":[{"text":"c"}]}'), 'c');
	assert.equal(parseSsePayload('not-json'), null);
	assert.equal(parseSsePayload('{"choices":[]}'), null);
});

test('parseSsePayload 抛出发起方错误', () => {
	assert.throws(() => parseSsePayload('{"error":{"message":"quota"}}'), /quota/);
});
