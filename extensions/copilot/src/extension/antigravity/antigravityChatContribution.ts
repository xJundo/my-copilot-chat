import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { AgentRunner } from './agentRunner';

export class AntigravityChatContribution extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = 'antigravity-copilot.chatView';
	private _view?: vscode.WebviewView;
	private _runningProcesses = new Map<string, ChildProcess>();
	private _agentRunner?: AgentRunner;

	constructor(
		private readonly _context: vscode.ExtensionContext
	) {
		super();
		this._agentRunner = new AgentRunner(this);
		this._register(vscode.window.registerWebviewViewProvider(AntigravityChatContribution.viewType, this));
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._context.extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		this._register(webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.command) {
					case 'sendMessage':
						await this._handleSendMessage(message.text, message.session, message.settings);
						break;
					case 'rollbackCheckpoint':
						await this._handleRollback(message.index, message.session);
						break;
					case 'abortTask':
						this._handleAbortTask(message.taskId);
						break;
					case 'proceedStep':
						this._handleProceedStep();
						break;
					case 'commentStep':
						this._handleCommentStep(message.stepIndex, message.comment);
						break;
					case 'acceptChange':
						await this._handleAcceptChange(message.changeId);
						break;
					case 'rejectChange':
						await this._handleRejectChange(message.changeId);
						break;
					case 'loadSessions':
						this._loadSessions();
						break;
					case 'saveSessions':
						this._saveSessions(message.sessions);
						break;
					case 'searchAutocomplete':
						await this._handleSearchAutocomplete(message.query);
						break;
					case 'readFileContent':
						await this._handleReadFileContent(message.filePath);
						break;
				}
			} catch (err: any) {
				vscode.window.showErrorMessage(`Antigravity Error: ${err.message}`);
			}
		}));

		// Initial load of sessions and workspace context
		this._loadSessions();
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const htmlPath = vscode.Uri.joinPath(this._context.extensionUri, 'assets', 'antigravity', 'chat.html');
		const cssPath = vscode.Uri.joinPath(this._context.extensionUri, 'assets', 'antigravity', 'chat.css');
		const jsPath = vscode.Uri.joinPath(this._context.extensionUri, 'assets', 'antigravity', 'chat.js');

		const cssUri = webview.asWebviewUri(cssPath);
		const jsUri = webview.asWebviewUri(jsPath);

		let htmlContent = '';
		try {
			htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
		} catch (e) {
			// Fallback template if file not created yet or fails
			return `<!DOCTYPE html><html><body><h1>Error loading Antigravity Webview HTML</h1></body></html>`;
		}

		// Inject stylesheets and scripts
		htmlContent = htmlContent.replace('${cssUri}', cssUri.toString());
		htmlContent = htmlContent.replace('${jsUri}', jsUri.toString());

		return htmlContent;
	}

	// Messaging Handlers
	private async _handleSendMessage(text: string, session: any, settings: any) {
		if (!this._agentRunner) {
			return;
		}
		// Run Agent Loop
		await this._agentRunner.run(text, session, settings);
	}

	private async _handleRollback(index: number, session: any) {
		// Clean up any remaining steps/agent runners
		if (this._agentRunner) {
			this._agentRunner.reset();
		}
		// Notify UI that rollback succeeded
		this.postMessage({ command: 'rollbackSuccess', index, session });
	}

	private _handleAbortTask(taskId: string) {
		const proc = this._runningProcesses.get(taskId);
		if (proc) {
			proc.kill('SIGINT');
			this._runningProcesses.delete(taskId);
			this.postMessage({ command: 'taskAborted', taskId });
		}
	}

	private _handleProceedStep() {
		if (this._agentRunner) {
			this._agentRunner.proceed();
		}
	}

	private _handleCommentStep(stepIndex: number, comment: string) {
		if (this._agentRunner) {
			this._agentRunner.addComment(stepIndex, comment);
		}
	}

	private async _handleAcceptChange(changeId: string) {
		if (this._agentRunner) {
			await this._agentRunner.acceptChange(changeId);
		}
	}

	private async _handleRejectChange(changeId: string) {
		if (this._agentRunner) {
			await this._agentRunner.rejectChange(changeId);
		}
	}

	private _loadSessions() {
		const sessions = this._context.globalState.get<any[]>('antigravity.sessions', []);
		this.postMessage({ command: 'sessionsLoaded', sessions });
	}

	private _saveSessions(sessions: any[]) {
		this._context.globalState.update('antigravity.sessions', sessions);
	}

	private async _handleSearchAutocomplete(query: string) {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			this.postMessage({ command: 'autocompleteResults', results: [] });
			return;
		}

		// Fetch files using VS Code API
		const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
		const results: any[] = [];
		const queryLower = query.toLowerCase();

		// Keep track of directories to list them too
		const directories = new Set<string>();

		for (const file of files) {
			const relPath = vscode.workspace.asRelativePath(file);
			const dirPath = path.dirname(relPath);

			if (dirPath && dirPath !== '.') {
				directories.add(dirPath);
			}

			if (relPath.toLowerCase().includes(queryLower)) {
				results.push({
					type: 'file',
					name: path.basename(relPath),
					path: relPath
				});
			}
		}

		for (const dir of directories) {
			if (dir.toLowerCase().includes(queryLower)) {
				results.push({
					type: 'directory',
					name: path.basename(dir),
					path: dir
				});
			}
		}

		// Sort results by similarity (e.g. startsWith gets higher priority) and limit to 10
		results.sort((a, b) => {
			const aName = a.name.toLowerCase();
			const bName = b.name.toLowerCase();
			const aStarts = aName.startsWith(queryLower);
			const bStarts = bName.startsWith(queryLower);
			if (aStarts && !bStarts) return -1;
			if (!aStarts && bStarts) return 1;
			return aName.localeCompare(bName);
		});

		this.postMessage({ command: 'autocompleteResults', results: results.slice(0, 15) });
	}

	private async _handleReadFileContent(filePath: string) {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) return;

		const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
		try {
			const contentBytes = await vscode.workspace.fs.readFile(fullUri);
			const content = new TextDecoder('utf-8').decode(contentBytes);
			this.postMessage({ command: 'fileContentLoaded', filePath, content });
		} catch (err: any) {
			vscode.window.showErrorMessage(`Could not read file: ${filePath}`);
		}
	}

	// Execution Helpers
	public runTerminalCommand(taskId: string, commandLine: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

			this.postMessage({ command: 'taskStarted', taskId, commandLine });

			// Use zsh or bash based on platform
			const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh';
			const shellArgs = process.platform === 'win32' ? ['-Command', commandLine] : ['-c', commandLine];

			const proc = spawn(shell, shellArgs, { cwd, env: process.env });
			this._runningProcesses.set(taskId, proc);

			let output = '';

			proc.stdout.on('data', (data) => {
				const chunk = data.toString();
				output += chunk;
				this.postMessage({ command: 'taskOutput', taskId, output: chunk });
			});

			proc.stderr.on('data', (data) => {
				const chunk = data.toString();
				output += chunk;
				this.postMessage({ command: 'taskOutput', taskId, output: chunk });
			});

			proc.on('close', (code) => {
				this._runningProcesses.delete(taskId);
				if (code === 0) {
					this.postMessage({ command: 'taskCompleted', taskId, exitCode: 0 });
					resolve(output);
				} else {
					this.postMessage({ command: 'taskCompleted', taskId, exitCode: code || -1 });
					reject(new Error(`Command exited with code ${code}. Output:\n${output}`));
				}
			});

			proc.on('error', (err) => {
				this._runningProcesses.delete(taskId);
				this.postMessage({ command: 'taskFailed', taskId, error: err.message });
				reject(err);
			});
		});
	}

	public async writeFileContent(filePath: string, content: string): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) throw new Error('No open workspace');

		const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
		const data = new TextEncoder().encode(content);
		await vscode.workspace.fs.writeFile(fullUri, data);
	}

	public postMessage(message: any) {
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}
}
