import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface FakeUri {
	scheme: string;
	fsPath: string;
	path: string;
}

function uri(fsPath: string, scheme = 'file'): FakeUri {
	return { scheme, fsPath, path: fsPath.replace(/\\/g, '/') };
}

const vscodeMock = {
	Uri: { file: (value: string) => uri(value) },
	workspace: {
		asRelativePath: (value: FakeUri) => value.fsPath.replace(/\\/g, '/').split('/').pop() ?? value.fsPath
	},
	extensions: {
		getExtension: () => undefined
	},
	window: {}
};

/** 加载 ../git，同时把 vscode 模块替换成最小 mock */
function loadGit(): typeof import('../git') {
	const Module = require('module') as any;
	const originalLoad = Module._load;
	Module._load = function (request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return vscodeMock;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		for (const key of Object.keys(require.cache)) {
			if (/[\\/]out[\\/]git\.js$/.test(key)) {
				delete require.cache[key];
			}
		}
		return require('../git');
	} finally {
		Module._load = originalLoad;
	}
}

interface FakeRepoOptions {
	root?: string;
	scheme?: string;
	selected?: boolean;
	staged?: number;
	headCommit?: string | undefined;
	diff?: (cached?: boolean) => Promise<string>;
}

function fakeRepo(options: FakeRepoOptions = {}): any {
	const root = options.root ?? path.join(os.tmpdir(), 'repo');
	return {
		rootUri: uri(root, options.scheme ?? 'file'),
		ui: { selected: options.selected ?? false },
		state: {
			HEAD: options.headCommit === undefined ? undefined : { name: 'main', commit: options.headCommit },
			indexChanges: Array.from({ length: options.staged ?? 0 }, (_, index) => ({
				uri: uri(path.join(root, `file${index}.ts`)),
				originalUri: uri(path.join(root, `file${index}.ts`)),
				renameUri: undefined,
				status: 0
			})),
			workingTreeChanges: []
		},
		diff: options.diff ?? (async () => '')
	};
}

function fakeApi(repositories: any[], resolve?: (uri: FakeUri) => any): any {
	return {
		state: 'initialized',
		git: { path: 'git' },
		repositories,
		getRepository: (value: FakeUri) => (resolve ? resolve(value) : null)
	};
}

function makeGitRepo(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-commit-git-'));
	const run = (args: string[]): void => {
		execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
	};
	run(['init']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test']);
	fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
	run(['add', 'base.txt']);
	run(['commit', '-m', 'chore: init']);
	fs.writeFileSync(path.join(dir, 'added.ts'), 'export const value = 1;\n');
	run(['add', 'added.ts']);
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
	};
}

test('pickRepository：没有仓库时返回 undefined', () => {
	const { pickRepository } = loadGit();
	assert.equal(pickRepository(fakeApi([])), undefined);
});

test('pickRepository：优先使用 SCM 视图中选中的仓库', () => {
	const { pickRepository } = loadGit();
	const first = fakeRepo({ root: 'C:\\a' });
	const second = fakeRepo({ root: 'C:\\b', selected: true });
	const picked1 = pickRepository(fakeApi([first, second]), uri('C:\\a\\file.ts') as any);
	assert.equal(picked1, second);
});

test('pickRepository：未选中时按当前编辑器所属仓库选取', () => {
	const { pickRepository } = loadGit();
	const first = fakeRepo({ root: 'C:\\a' });
	const second = fakeRepo({ root: 'C:\\b', staged: 2 });
	const picked = pickRepository(fakeApi([first, second], () => second), uri('C:\\b\\file.ts') as any);
	assert.equal(picked, second);
});

test('pickRepository：都未命中时优先有暂存改动的仓库', () => {
	const { pickRepository } = loadGit();
	const first = fakeRepo({ root: 'C:\\a' });
	const second = fakeRepo({ root: 'C:\\b', staged: 1 });
	assert.equal(pickRepository(fakeApi([first, second])), second);
});

test('pickRepository：都没有暂存改动时退回第一个仓库', () => {
	const { pickRepository } = loadGit();
	const first = fakeRepo({ root: 'C:\\a' });
	const second = fakeRepo({ root: 'C:\\b' });
	assert.equal(pickRepository(fakeApi([first, second])), first);
});

test('readStagedSnapshot：无 HEAD 时标记为首次提交', async () => {
	const { readStagedSnapshot } = loadGit();
	const repo = fakeRepo({ staged: 1, diff: async () => 'diff --git a/x b/x' });
	const snapshot = await readStagedSnapshot(repo, 'git');
	assert.equal(snapshot.isInitialCommit, true);
	assert.equal(snapshot.diff, 'diff --git a/x b/x');
});

test('readStagedSnapshot：有 HEAD 时不标记为首次提交', async () => {
	const { readStagedSnapshot } = loadGit();
	const repo = fakeRepo({ staged: 1, headCommit: 'abc123', diff: async () => 'diff' });
	const snapshot = await readStagedSnapshot(repo, 'git');
	assert.equal(snapshot.isInitialCommit, false);
});

test('readStagedSnapshot：暂存区为空时不读取 diff', async () => {
	const { readStagedSnapshot } = loadGit();
	let called = false;
	const repo = fakeRepo({
		staged: 0,
		headCommit: 'abc123',
		diff: async () => {
			called = true;
			return 'should not be used';
		}
	});
	const snapshot = await readStagedSnapshot(repo, 'git');
	assert.equal(snapshot.diff, '');
	assert.equal(called, false);
});

test('readStagedSnapshot：repo.diff 失败时回落到 git CLI', async () => {
	const { readStagedSnapshot } = loadGit();
	const repoDir = makeGitRepo();
	try {
		const repo = fakeRepo({
			root: repoDir.dir,
			staged: 1,
			headCommit: 'abc123',
			diff: async () => {
				throw new Error('diff api broken');
			}
		});
		const snapshot = await readStagedSnapshot(repo, 'git');
		assert.ok(snapshot.diff.includes('added.ts'), `回落 CLI 的 diff 应包含改动文件，实际=${snapshot.diff.slice(0, 200)}`);
		assert.ok(snapshot.diff.includes('+export const value = 1;'), '应包含新增行');
	} finally {
		repoDir.cleanup();
	}
});

test('readStagedSnapshot：repo.diff 返回空串时也回落到 git CLI', async () => {
	const { readStagedSnapshot } = loadGit();
	const repoDir = makeGitRepo();
	try {
		const repo = fakeRepo({ root: repoDir.dir, staged: 1, headCommit: 'abc123', diff: async () => '' });
		const snapshot = await readStagedSnapshot(repo, 'git');
		assert.ok(snapshot.diff.includes('added.ts'));
	} finally {
		repoDir.cleanup();
	}
});

test('readStagedSnapshot：虚拟工作区直接报错', async () => {
	const { readStagedSnapshot } = loadGit();
	const repo = fakeRepo({ scheme: 'vscode-vfs', staged: 1, headCommit: 'abc123' });
	await assert.rejects(() => readStagedSnapshot(repo, 'git'), /暂不支持虚拟工作区/);
});

test('getGitApi：内置 Git 扩展不可用时抛出明确错误（非 git 工作区）', async () => {
	const { getGitApi } = loadGit();
	await assert.rejects(() => getGitApi(), /内置 Git 扩展不可用/);
});

test('describeChange：重命名显示为 old -> new', () => {
	const { describeChange } = loadGit();
	const change = {
		uri: uri('/repo/new-name.ts'),
		originalUri: uri('/repo/old-name.ts'),
		renameUri: undefined,
		status: 3
	};
	assert.equal(describeChange(change as any), 'R  old-name.ts -> new-name.ts');
});
