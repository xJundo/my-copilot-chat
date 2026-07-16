import * as vscode from 'vscode';
import * as path from 'path';
import { AntigravityChatContribution } from './antigravityChatContribution';

export interface WalkthroughStep {
	title: string;
	action: 'read' | 'write' | 'command' | 'other';
	file?: string;
	cmd?: string;
	description: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	comments?: string[];
}

export class AgentRunner {
	private _currentSteps: WalkthroughStep[] = [];
	private _currentStepIndex = 0;
	private _sessionData: any = null;
	private _settings: any = null;
	private _history: any[] = [];
	private _proposedChanges = new Map<string, { filePath: string; original: string; proposed: string }>();

	constructor(private readonly _contribution: AntigravityChatContribution) {}

	public reset() {
		this._currentSteps = [];
		this._currentStepIndex = 0;
		this._proposedChanges.clear();
	}

	public async run(userPrompt: string, session: any, settings: any) {
		this.reset();
		this._sessionData = session || { id: Date.now().toString(), messages: [] };
		this._settings = settings || {};
		this._history = this._sessionData.messages || [];

		// Add user prompt to history if not already there
		if (this._history.length === 0 || this._history[this._history.length - 1].role !== 'user') {
			this._history.push({ role: 'user', content: userPrompt });
		}

		this._contribution.postMessage({ command: 'agentThinking', message: 'Generating walkthrough and implementation plan...' });

		try {
			// Generate walkthrough steps from the LLM
			const planResult = await this._generateImplementationPlan(userPrompt);
			this._currentSteps = planResult.steps.map(s => ({
				...s,
				status: 'pending',
				comments: []
			}));
			this._currentStepIndex = 0;

			// Send to Webview UI
			this._contribution.postMessage({
				command: 'walkthroughGenerated',
				plan: planResult.plan,
				steps: this._currentSteps
			});

			this._contribution.postMessage({ command: 'agentIdle' });
		} catch (err: any) {
			this._contribution.postMessage({ command: 'agentError', error: err.message });
		}
	}

	public async proceed() {
		if (this._currentStepIndex >= this._currentSteps.length) {
			this._contribution.postMessage({ command: 'agentThinking', message: 'All steps completed. Summarizing changes...' });
			try {
				const summary = await this._summarizeTask();
				this._history.push({ role: 'assistant', content: summary });
				this._contribution.postMessage({ command: 'agentFinished', summary });
			} catch (err: any) {
				this._contribution.postMessage({ command: 'agentFinished', summary: 'Work completed, but failed to generate summary: ' + err.message });
			}
			return;
		}

		const step = this._currentSteps[this._currentStepIndex];
		step.status = 'running';
		this._contribution.postMessage({ command: 'stepUpdated', stepIndex: this._currentStepIndex, step });

		try {
			switch (step.action) {
				case 'read':
					await this._executeReadStep(step);
					break;
				case 'write':
					await this._executeWriteStep(step);
					break;
				case 'command':
					await this._executeCommandStep(step);
					break;
				default:
					// Custom/other steps
					step.status = 'completed';
					break;
			}
		} catch (err: any) {
			step.status = 'failed';
			this._contribution.postMessage({ command: 'stepUpdated', stepIndex: this._currentStepIndex, step });
			this._contribution.postMessage({ command: 'agentError', error: `Step failed: ${err.message}` });
			return;
		}

		// Update UI
		if (step.status === 'completed') {
			this._contribution.postMessage({ command: 'stepUpdated', stepIndex: this._currentStepIndex, step });
			this._currentStepIndex++;
			// Auto-proceed if not requiring user approval (e.g. if approval settings allow)
			const shouldAutoProceed = this._settings.approvalMode === 'Default Approvals' || this._settings.approvalMode === 'Never ask';
			if (shouldAutoProceed && step.action !== 'write') {
				setTimeout(() => this.proceed(), 500);
			} else {
				this._contribution.postMessage({ command: 'agentIdle' });
			}
		}
	}

	public addComment(stepIndex: number, comment: string) {
		if (stepIndex >= 0 && stepIndex < this._currentSteps.length) {
			const step = this._currentSteps[stepIndex];
			if (!step.comments) {
				step.comments = [];
			}
			step.comments.push(comment);
			this._contribution.postMessage({ command: 'stepUpdated', stepIndex, step });
		}
	}

	public async acceptChange(changeId: string) {
		const change = this._proposedChanges.get(changeId);
		if (change) {
			await this._contribution.writeFileContent(change.filePath, change.proposed);
			this._proposedChanges.delete(changeId);

			// Mark current step as completed
			const step = this._currentSteps[this._currentStepIndex];
			step.status = 'completed';
			this._contribution.postMessage({ command: 'stepUpdated', stepIndex: this._currentStepIndex, step });

			// Add to artefacts in UI
			this._contribution.postMessage({
				command: 'addArtefact',
				filePath: change.filePath,
				type: 'file'
			});

			this._currentStepIndex++;
			this._contribution.postMessage({ command: 'agentIdle' });
		}
	}

	public async rejectChange(changeId: string) {
		const change = this._proposedChanges.get(changeId);
		if (change) {
			this._proposedChanges.delete(changeId);

			const step = this._currentSteps[this._currentStepIndex];
			step.status = 'failed';
			this._contribution.postMessage({ command: 'stepUpdated', stepIndex: this._currentStepIndex, step });
			this._contribution.postMessage({ command: 'agentError', error: 'Proposed change was rejected by user.' });
		}
	}

	// Steps implementation
	private async _executeReadStep(step: WalkthroughStep) {
		if (!step.file) throw new Error('File path not specified for read step');

		this._contribution.postMessage({ command: 'agentThinking', message: `Reading file ${step.file}...` });

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) throw new Error('No open workspace');

		const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, step.file);
		const contentBytes = await vscode.workspace.fs.readFile(fullUri);
		const content = new TextDecoder('utf-8').decode(contentBytes);

		this._history.push({
			role: 'system',
			content: `Contents of file ${step.file}:\n\`\`\`\n${content}\n\`\`\``
		});

		step.status = 'completed';
	}

	private async _executeWriteStep(step: WalkthroughStep) {
		if (!step.file) throw new Error('File path not specified for write step');

		this._contribution.postMessage({ command: 'agentThinking', message: `Generating content for ${step.file}...` });

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) throw new Error('No open workspace');

		const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, step.file);

		let originalContent = '';
		try {
			const originalBytes = await vscode.workspace.fs.readFile(fullUri);
			originalContent = new TextDecoder('utf-8').decode(originalBytes);
		} catch (e) {
			// File does not exist yet, that's fine
		}

		// Prompt the model to write the code
		const prompt = `Based on our plan, generate the complete code content for the file "${step.file}".
Return ONLY the raw code content. Do not enclose it in markdown blocks. Do not add any introduction or explanations.
User original request: ${this._history[0].content}
Current conversation context:
${this._history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}`;

		const proposedContent = await this._callLLM(prompt);

		// Store proposed change
		const changeId = 'change_' + Date.now().toString();
		this._proposedChanges.set(changeId, {
			filePath: step.file,
			original: originalContent,
			proposed: proposedContent
		});

		// Trigger diff view in Webview
		this._contribution.postMessage({
			command: 'showDiff',
			changeId,
			filePath: step.file,
			originalContent,
			proposedContent
		});
	}

	private async _executeCommandStep(step: WalkthroughStep) {
		if (!step.cmd) throw new Error('Command not specified for execution step');

		this._contribution.postMessage({ command: 'agentThinking', message: `Executing command: ${step.cmd}...` });

		const taskId = 'task_' + Date.now().toString();
		try {
			const output = await this._contribution.runTerminalCommand(taskId, step.cmd);
			this._history.push({
				role: 'system',
				content: `Command "${step.cmd}" completed successfully. Output:\n${output}`
			});
			step.status = 'completed';
		} catch (err: any) {
			this._history.push({
				role: 'system',
				content: `Command "${step.cmd}" failed. Error/Output:\n${err.message}`
			});
			step.status = 'failed';
			throw err;
		}
	}

	// LLM Interface
	private async _generateImplementationPlan(userPrompt: string): Promise<{ plan: string; steps: any[] }> {
		const prompt = `You are an agentic software developer. Analyze the following request: "${userPrompt}"
Generate a structured implementation plan and walkthrough.
Return your response in JSON format (do not wrap in a markdown block, return raw JSON string only) matching the following interface:
{
  "plan": "Detailed markdown explanation of the proposed changes.",
  "steps": [
    {
      "title": "Title of step 1",
      "action": "read" | "write" | "command",
      "file": "path/to/file.ext",  // only for read and write
      "cmd": "npm run build",     // only for command
      "description": "Short explanation of what this step does."
    }
  ]
}
Ensure paths are relative to workspace root.`;

		const response = await this._callLLM(prompt);
		try {
			// Strip any markdown code fence wrappers if the LLM added them
			const cleanResponse = response.replace(/^```json\s*/, '').replace(/```$/, '').trim();
			return JSON.parse(cleanResponse);
		} catch (e) {
			// Fallback parsing if LLM output was slightly malformed
			return {
				plan: response,
				steps: [
					{
						title: "Review changes",
						action: "other",
						description: "Manual verification step."
					}
				]
			};
		}
	}

	private async _summarizeTask(): Promise<string> {
		const prompt = `We have completed all the steps in our plan. Summarize what changes were made and their effects.
Plan: ${JSON.stringify(this._currentSteps)}
User original request: ${this._history[0].content}`;
		return await this._callLLM(prompt);
	}

	private async _callLLM(prompt: string): Promise<string> {
		// Use VS Code Language Model API if possible, otherwise use fallback API key if provided.
		// Check settings for custom keys
		const apiKey = this._settings.apiKey;
		const provider = this._settings.provider || 'VS Code Native';

		if (provider === 'VS Code Native') {
			try {
				// Get available chat models
				// Family can be gpt-4o, claude-3-5-sonnet, etc.
				let family = 'gpt-4o';
				if (this._settings.modelName && this._settings.modelName.toLowerCase().includes('claude')) {
					family = 'claude-3-5-sonnet';
				} else if (this._settings.modelName && this._settings.modelName.toLowerCase().includes('gemini')) {
					family = 'gemini-1.5-pro';
				}

				const models = await vscode.lm.selectChatModels({ family });
				if (models && models.length > 0) {
					const model = models[0];
					const userMsg = new vscode.LanguageModelUserMessage(prompt);
					const response = await model.sendRequest([userMsg], {}, new vscode.CancellationTokenSource().token);
					
					let resultText = '';
					for await (const chunk of response.text) {
						resultText += chunk;
					}
					return resultText;
				}
			} catch (err) {
				console.error('Failed to use VS Code LM API, falling back to mock / config:', err);
			}
		}

		// Fallback APIs using standard HTTP calls if key is provided
		if (provider === 'OpenAI' && apiKey) {
			const model = this._settings.modelName || 'gpt-4o';
			const effort = this._settings.thinkingEffort || 'None';
			const body: any = {
				model,
				messages: [{ role: 'user', content: prompt }]
			};
			if (model.startsWith('o1') || model.startsWith('o3')) {
				if (effort === 'High' || effort === 'Max') {
					body.reasoning_effort = 'high';
				} else if (effort === 'None') {
					body.reasoning_effort = 'low';
				}
			}
			const response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify(body)
			});
			const data: any = await response.json();
			return data.choices[0].message.content;
		}

		if (provider === 'Anthropic' && apiKey) {
			const model = this._settings.modelName || 'claude-3-5-sonnet-latest';
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01'
				},
				body: JSON.stringify({
					model,
					max_tokens: 4000,
					messages: [{ role: 'user', content: prompt }]
				})
			});
			const data: any = await response.json();
			return data.content[0].text;
		}

		// Fallback mock responses if no key or native access available
		return this._getMockResponse(prompt);
	}

	private _getMockResponse(prompt: string): string {
		if (prompt.includes('implementation plan')) {
			return JSON.stringify({
				plan: "# Mock Implementation Plan\nThis is a mock implementation plan as no API provider is configured.",
				steps: [
					{
						title: "Analyze Repository",
						action: "command",
						cmd: "ls -la",
						description: "List the files in the workspace."
					},
					{
						title: "Create Sample Script",
						action: "write",
						file: "sample.js",
						description: "Create a simple test JavaScript file."
					},
					{
						title: "Execute Sample Script",
						action: "command",
						cmd: "node sample.js",
						description: "Run the created script."
					}
				]
			});
		}
		if (prompt.includes('generate the complete code content')) {
			return `// Generated by Antigravity Agentic Chat
console.log("Hello Antigravity IDE!");
`;
		}
		return "Mock assistant response summarizing changes.";
	}
}
