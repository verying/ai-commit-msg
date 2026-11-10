import { Uri, Event } from 'vscode';

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}

export interface API {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
	readonly git: { readonly path: string };
	readonly repositories: Repository[];
	getRepository(uri: Uri): Repository | null;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: {
		value: string;
		enabled?: boolean;
		placeholder?: string;
	};
	readonly state: RepositoryState;
	readonly ui: { readonly selected: boolean };
	diff(cached?: boolean): Promise<string>;
}

export interface RepositoryState {
	readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
}

export interface Change {
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: number;
}

export const enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,
	MODIFIED,
	DELETED,
	UNTRACKED
}
