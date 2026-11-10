import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API, Change, GitExtension, Repository } from './gitApi';

const execFileAsync = promisify(execFile) as (
	file: string,
	args: readonly string[],
	options: { cwd?: string; maxBuffer?: number; timeout?: number; windowsHide?: boolean }
) => Promise<{ stdout: string; stderr: string }>;

export interface StagedSnapshot {
	repo: Repository;
	gitPath: string;
	changes: Change[];
	diff: string;
	isInitialCommit: boolean;
}

export async function getGitApi(): Promise<API> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		throw new Error('内置 Git 扩展不可用，请确认 VS Code 自带的 Git 扩展已启用');
	}

	if (!extension.isActive) {
		await extension.activate();
	}

	const api = extension.exports.getAPI(1);
	if (api.state === 'initialized') {
		return api;
	}

	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const dispose = api.onDidChangeState(state => {
			if (state === 'initialized') {
				if (timer) {
					clearTimeout(timer);
				}
				dispose.dispose();
				resolve();
			}
		});

		timer = setTimeout(() => {
			dispose.dispose();
			reject(new Error('Git 扩展尚未初始化（等待 5 秒超时）'));
		}, 5000);

		if (api.state === 'initialized') {
			clearTimeout(timer);
			dispose.dispose();
			resolve();
		}
	});

	return api;
}

export function pickRepository(api: API, activeUri?: vscode.Uri): Repository | undefined {
	const repositories = api.repositories;
	if (repositories.length === 0) {
		return undefined;
	}

	const selected = repositories.find(repo => repo.ui.selected);
	if (selected) {
		return selected;
	}

	if (activeUri) {
		const fromEditor = api.getRepository(activeUri);
		if (fromEditor) {
			return fromEditor;
		}
	}

	const withStaged = repositories.find(repo => repo.state.indexChanges.length > 0);
	return withStaged ?? repositories[0];
}

export async function readStagedSnapshot(repo: Repository, gitPath: string): Promise<StagedSnapshot> {
	const changes = repo.state.indexChanges;
	const isInitialCommit = !repo.state.HEAD?.commit;

	if (repo.rootUri.scheme !== 'file') {
		throw new Error('暂不支持虚拟工作区中的 Git 仓库');
	}

	if (changes.length === 0) {
		return { repo, gitPath, changes, diff: '', isInitialCommit };
	}

	let diff = '';
	if (typeof repo.diff === 'function') {
		try {
			diff = await repo.diff(true);
		} catch {
			diff = '';
		}
	}

	if (!diff) {
		diff = await runGitDiffCached(repo.rootUri.fsPath, gitPath);
	}

	return { repo, gitPath, changes, diff, isInitialCommit };
}

export function describeChange(change: Change): string {
	const letter = statusLetter(change.status);
	const currentPath = displayPath(change.uri);

	if (letter === 'R' || letter === 'C') {
		const originalPath = displayPath(change.originalUri);
		return `${letter}  ${originalPath} -> ${currentPath}`;
	}

	return `${letter}  ${currentPath}`;
}

async function runGitDiffCached(cwd: string, gitPath: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			gitPath,
			['diff', '--cached', '--no-color', '--no-ext-diff'],
			{
				cwd,
				maxBuffer: 20 * 1024 * 1024,
				timeout: 30000,
				windowsHide: true
			}
		);
		return stdout;
	} catch (error) {
		const stderr = String((error as { stderr?: string }).stderr ?? '').slice(0, 300);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`读取暂存区 diff 失败：${message}${stderr ? `\n${stderr}` : ''}`);
	}
}

function statusLetter(status: number): string {
	switch (status) {
		case 1:
			return 'A';
		case 2:
			return 'D';
		case 3:
			return 'R';
		case 4:
			return 'C';
		case 7:
			return 'U';
		default:
			return 'M';
	}
}

function displayPath(uri: vscode.Uri): string {
	try {
		return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
	} catch {
		return uri.fsPath.replace(/\\/g, '/');
	}
}
