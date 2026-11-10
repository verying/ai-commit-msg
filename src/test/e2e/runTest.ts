import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * 真正的端到端验证：起一个 VS Code 实例（复用本机安装的 VS Code，不下载），
 * 打开一个临时 git 仓库，暂存文件，执行 aiCommit.generate，
 * 然后读回 SCM 输入框的真实值，确认生成结果被完整写入。
 *
 * 运行：npm run test:e2e
 */
async function main(): Promise<void> {
	const extensionRoot = path.resolve(__dirname, '../../..');
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-commit-e2e-'));

	const git = (args: string[]): void => {
		childProcess.execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
	};

	git(['init']);
	git(['config', 'user.email', 'e2e@example.com']);
	git(['config', 'user.name', 'E2E']);
	fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
	git(['add', 'base.txt']);
	git(['commit', '-m', 'chore: init']);
	fs.writeFileSync(
		path.join(repoDir, 'feature.ts'),
		'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n'
	);
	git(['add', 'feature.ts']);

	const vscodeExecutablePath = resolveVSCodeExecutable();
	if (!fs.existsSync(vscodeExecutablePath)) {
		throw new Error(`找不到 VS Code：${vscodeExecutablePath}，可用环境变量 VSCODE_EXE 指定`);
	}

	await runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: extensionRoot,
		extensionTestsPath: path.resolve(__dirname, './suite/run.js'),
		launchArgs: [repoDir],
		extensionTestsEnv: { AICOMMIT_API_KEY: 'sk-e2e' }
	});
}

/**
 * 解析 VS Code 可执行文件：优先环境变量 VSCODE_EXE，其次按各平台常见安装位置查找。
 * 不写死本机路径，避免把个人目录带进仓库。
 */
function resolveVSCodeExecutable(): string {
	const fromEnv = process.env.VSCODE_EXE?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	const candidates: string[] = [];
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			candidates.push(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'));
		}
		for (const key of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
			const base = process.env[key];
			if (base) {
				candidates.push(path.join(base, 'Microsoft VS Code', 'Code.exe'));
			}
		}
	} else if (process.platform === 'darwin') {
		candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
	} else {
		candidates.push('/usr/share/code/code', '/usr/bin/code');
	}

	const found = candidates.find(candidate => fs.existsSync(candidate));
	if (!found) {
		throw new Error('找不到本机安装的 VS Code，请用环境变量 VSCODE_EXE 指定可执行文件路径');
	}
	return found;
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
