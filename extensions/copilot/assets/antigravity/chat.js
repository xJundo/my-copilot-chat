const vscode = acquireVsCodeApi();

// UI State
let sessions = [];
let currentSession = null;
let tasks = [];
let artefacts = [];
let proposedChanges = [];
let autocompleteActive = false;
let autocompleteSelectionIndex = 0;
let autocompleteQuery = '';

// DOM Elements
const providerSelect = document.getElementById('provider-select');
const apiKeyContainer = document.getElementById('api-key-container');
const apiKeyInput = document.getElementById('api-key-input');
const modelSelect = document.getElementById('model-select');
const approvalSelect = document.getElementById('approval-select');
const thinkingSelect = document.getElementById('thinking-select');
const sessionsToggleBtn = document.getElementById('sessions-toggle-btn');
const sessionsSidebar = document.getElementById('sessions-sidebar');
const newSessionBtn = document.getElementById('new-session-btn');
const sessionListUl = document.getElementById('session-list-ul');
const chatHistory = document.getElementById('chat-history');
const walkthroughContainer = document.getElementById('walkthrough-container');
const walkthroughPlanDesc = document.getElementById('walkthrough-plan-desc');
const walkthroughStepsList = document.getElementById('walkthrough-steps-list');
const proceedBtn = document.getElementById('proceed-btn');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const autocompleteBox = document.getElementById('autocomplete-box');

// Bottom panel tabs
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const tasksBadge = document.getElementById('tasks-badge');
const artefactsBadge = document.getElementById('artefacts-badge');
const changesBadge = document.getElementById('changes-badge');
const tasksListDiv = document.getElementById('tasks-list-div');
const artefactsListDiv = document.getElementById('artefacts-list-div');
const changesDiffContainer = document.getElementById('changes-diff-container');

// Settings management
function getSettings() {
	return {
		provider: providerSelect.value,
		apiKey: apiKeyInput.value,
		modelName: modelSelect.value,
		approvalMode: approvalSelect.value,
		thinkingEffort: thinkingSelect.value
	};
}

// Initial Events
providerSelect.addEventListener('change', () => {
	const provider = providerSelect.value;
	if (provider === 'VS Code Native') {
		apiKeyContainer.style.display = 'none';
		modelSelect.innerHTML = `
			<option value="gpt-4o">gpt-4o (Copilot)</option>
			<option value="claude-3-5-sonnet">claude-3.5 (Copilot)</option>
			<option value="gemini-1.5-pro">gemini-1.5-pro (Copilot)</option>
		`;
	} else {
		apiKeyContainer.style.display = 'flex';
		if (provider === 'OpenAI') {
			modelSelect.innerHTML = `
				<option value="gpt-4o">gpt-4o</option>
				<option value="o1">o1</option>
				<option value="o3-mini">o3-mini</option>
			`;
		} else if (provider === 'Anthropic') {
			modelSelect.innerHTML = `
				<option value="claude-3-5-sonnet-latest">claude-3.5-sonnet</option>
				<option value="claude-3-5-haiku-latest">claude-3.5-haiku</option>
			`;
		} else if (provider === 'Gemini') {
			modelSelect.innerHTML = `
				<option value="gemini-1.5-pro">gemini-1.5-pro</option>
				<option value="gemini-1.5-flash">gemini-1.5-flash</option>
			`;
		}
	}
});

sessionsToggleBtn.addEventListener('click', () => {
	sessionsSidebar.style.display = sessionsSidebar.style.display === 'none' ? 'flex' : 'none';
});

newSessionBtn.addEventListener('click', () => {
	const newSession = {
		id: Date.now().toString(),
		name: 'Session ' + (sessions.length + 1),
		messages: []
	};
	sessions.push(newSession);
	currentSession = newSession;
	saveSessions();
	renderSessions();
	renderChat();
	resetState();
});

// Autocomplete logic for @ referencing
chatInput.addEventListener('keydown', (e) => {
	if (autocompleteActive) {
		const items = autocompleteBox.querySelectorAll('.autocomplete-item');
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			items[autocompleteSelectionIndex]?.classList.remove('selected');
			autocompleteSelectionIndex = (autocompleteSelectionIndex + 1) % items.length;
			items[autocompleteSelectionIndex]?.classList.add('selected');
			items[autocompleteSelectionIndex]?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			items[autocompleteSelectionIndex]?.classList.remove('selected');
			autocompleteSelectionIndex = (autocompleteSelectionIndex - 1 + items.length) % items.length;
			items[autocompleteSelectionIndex]?.classList.add('selected');
			items[autocompleteSelectionIndex]?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const selected = items[autocompleteSelectionIndex];
			if (selected) {
				insertAutocomplete(selected.dataset.path, selected.dataset.type);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			hideAutocomplete();
		}
	} else {
		// Normal send message on Enter without Shift
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			triggerSendMessage();
		}
	}
});

chatInput.addEventListener('input', () => {
	const text = chatInput.value;
	const cursor = chatInput.selectionStart;
	const textBeforeCursor = text.slice(0, cursor);
	
	// Check if cursor is just after '@' or typing after '@'
	const match = textBeforeCursor.match(/@([^\s]*)$/);
	if (match) {
		autocompleteActive = true;
		autocompleteQuery = match[1];
		vscode.postMessage({ command: 'searchAutocomplete', query: autocompleteQuery });
	} else {
		hideAutocomplete();
	}
});

function hideAutocomplete() {
	autocompleteActive = false;
	autocompleteBox.style.display = 'none';
	autocompleteSelectionIndex = 0;
}

function insertAutocomplete(path, type) {
	const text = chatInput.value;
	const cursor = chatInput.selectionStart;
	const textBeforeCursor = text.slice(0, cursor);
	const textAfterCursor = text.slice(cursor);
	
	// Replace @something with the reference
	const refText = type === 'directory' ? `@directory:${path} ` : `@${path} `;
	const updatedBefore = textBeforeCursor.replace(/@([^\s]*)$/, refText);
	chatInput.value = updatedBefore + textAfterCursor;
	
	hideAutocomplete();
	chatInput.focus();

	// Read file contents if it's a file to include it in the context later
	if (type === 'file') {
		vscode.postMessage({ command: 'readFileContent', filePath: path });
	}
}

// Bottom panel tabs
tabButtons.forEach(btn => {
	btn.addEventListener('click', () => {
		tabButtons.forEach(b => b.classList.remove('active'));
		tabContents.forEach(c => c.classList.remove('active'));
		
		btn.classList.add('active');
		document.getElementById(btn.dataset.tab).classList.add('active');
	});
});

// Stepper Proceed
proceedBtn.addEventListener('click', () => {
	vscode.postMessage({ command: 'proceedStep' });
});

// Send Message
sendBtn.addEventListener('click', triggerSendMessage);

function triggerSendMessage() {
	const text = chatInput.value.trim();
	if (!text) return;

	if (!currentSession) {
		currentSession = {
			id: Date.now().toString(),
			name: text.substring(0, 15) + '...',
			messages: []
		};
		sessions.push(currentSession);
		saveSessions();
		renderSessions();
	}

	// Add to UI
	currentSession.messages.push({ role: 'user', content: text });
	renderChat();
	chatInput.value = '';
	hideAutocomplete();

	// Post message to backend
	vscode.postMessage({
		command: 'sendMessage',
		text,
		session: currentSession,
		settings: getSettings()
	});
}

function resetState() {
	tasks = [];
	artefacts = [];
	proposedChanges = [];
	walkthroughContainer.style.display = 'none';
	renderTasks();
	renderArtefacts();
	renderProposedChanges();
}

// Session CRUD and rendering
function saveSessions() {
	vscode.postMessage({ command: 'saveSessions', sessions });
}

function renderSessions() {
	sessionListUl.innerHTML = '';
	sessions.forEach(sess => {
		const li = document.createElement('li');
		li.className = 'session-item' + (currentSession && currentSession.id === sess.id ? ' active' : '');
		
		const nameSpan = document.createElement('span');
		nameSpan.className = 'session-name';
		nameSpan.textContent = sess.name;
		nameSpan.addEventListener('click', () => {
			currentSession = sess;
			renderSessions();
			renderChat();
			resetState();
		});

		const deleteBtn = document.createElement('button');
		deleteBtn.className = 'session-delete-btn';
		deleteBtn.innerHTML = '&times;';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			sessions = sessions.filter(s => s.id !== sess.id);
			if (currentSession && currentSession.id === sess.id) {
				currentSession = sessions[0] || null;
			}
			saveSessions();
			renderSessions();
			renderChat();
			resetState();
		});

		li.appendChild(nameSpan);
		li.appendChild(deleteBtn);
		sessionListUl.appendChild(li);
	});
}

function renderChat() {
	chatHistory.innerHTML = '';
	if (!currentSession || currentSession.messages.length === 0) {
		chatHistory.innerHTML = `
			<div class="message system-message">
				<div class="message-content">
					Welcome to <strong>Antigravity Copilot Chat</strong>. Type a message or use <code>@</code> to reference files and directories to begin.
				</div>
			</div>
		`;
		return;
	}

	currentSession.messages.forEach((msg, idx) => {
		const div = document.createElement('div');
		div.className = `message ${msg.role}-message`;

		const contentDiv = document.createElement('div');
		contentDiv.className = 'message-content';
		
		// Parse simple styling / code blocks for user interface
		let htmlContent = msg.content
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/\n/g, '<br>')
			.replace(/`([^`]+)`/g, '<code>$1</code>');
		contentDiv.innerHTML = htmlContent;

		// Add Checkpoint rollback support
		const rollback = document.createElement('span');
		rollback.className = 'message-checkpoint';
		rollback.textContent = 'Rollback';
		rollback.addEventListener('click', () => {
			vscode.postMessage({ command: 'rollbackCheckpoint', index: idx, session: currentSession });
		});

		div.appendChild(contentDiv);
		div.appendChild(rollback);
		chatHistory.appendChild(div);
	});

	chatHistory.scrollTop = chatHistory.scrollHeight;
}

// Background Tasks List
function renderTasks() {
	tasksBadge.textContent = tasks.length;
	if (tasks.length === 0) {
		tasksListDiv.innerHTML = '<div class="empty-tab-message">No running background tasks.</div>';
		return;
	}

	tasksListDiv.innerHTML = '';
	tasks.forEach(t => {
		const div = document.createElement('div');
		div.className = 'task-item';

		const header = document.createElement('div');
		header.className = 'task-header';

		const cmd = document.createElement('span');
		cmd.className = 'task-cmd';
		cmd.textContent = t.commandLine;

		const badge = document.createElement('span');
		badge.className = `task-status-badge ${t.status}`;
		badge.textContent = t.status;

		header.appendChild(cmd);
		header.appendChild(badge);

		// Abort button for running tasks
		if (t.status === 'running') {
			const abortBtn = document.createElement('button');
			abortBtn.className = 'danger-btn';
			abortBtn.style.padding = '2px 6px';
			abortBtn.style.fontSize = '10px';
			abortBtn.textContent = 'Abort';
			abortBtn.addEventListener('click', () => {
				vscode.postMessage({ command: 'abortTask', taskId: t.id });
			});
			header.appendChild(abortBtn);
		}

		const log = document.createElement('div');
		log.className = 'task-log';
		log.textContent = t.output || '';

		div.appendChild(header);
		div.appendChild(log);
		tasksListDiv.appendChild(div);

		// Keep log scrolled to bottom
		log.scrollTop = log.scrollHeight;
	});
}

// Artefacts list
function renderArtefacts() {
	artefactsBadge.textContent = artefacts.length;
	if (artefacts.length === 0) {
		artefactsListDiv.innerHTML = '<div class="empty-tab-message">No artefacts generated yet.</div>';
		return;
	}

	artefactsListDiv.innerHTML = '';
	artefacts.forEach(a => {
		const div = document.createElement('div');
		div.className = 'artefact-item';

		const link = document.createElement('span');
		link.className = 'artefact-link';
		link.textContent = a.filePath;
		link.addEventListener('click', () => {
			// Trigger file open in VS Code editor
			vscode.postMessage({ command: 'readFileContent', filePath: a.filePath });
		});

		const type = document.createElement('span');
		type.className = 'step-badge';
		type.textContent = a.type;

		div.appendChild(link);
		div.appendChild(type);
		artefactsListDiv.appendChild(div);
	});
}

// Proposed Changes diff viewer
function renderProposedChanges() {
	changesBadge.textContent = proposedChanges.length;
	if (proposedChanges.length === 0) {
		changesDiffContainer.innerHTML = '<div class="empty-tab-message">No pending code changes to review.</div>';
		return;
	}

	changesDiffContainer.innerHTML = '';
	proposedChanges.forEach(ch => {
		const header = document.createElement('div');
		header.className = 'diff-header';
		
		const pathSpan = document.createElement('span');
		pathSpan.className = 'diff-path';
		pathSpan.textContent = ch.filePath;

		const actions = document.createElement('div');
		actions.style.display = 'flex';
		actions.style.gap = '6px';

		const acceptBtn = document.createElement('button');
		acceptBtn.className = 'primary-btn';
		acceptBtn.style.padding = '4px 8px';
		acceptBtn.textContent = 'Accept';
		acceptBtn.addEventListener('click', () => {
			vscode.postMessage({ command: 'acceptChange', changeId: ch.id });
		});

		const rejectBtn = document.createElement('button');
		rejectBtn.className = 'danger-btn';
		rejectBtn.style.padding = '4px 8px';
		rejectBtn.textContent = 'Reject';
		rejectBtn.addEventListener('click', () => {
			vscode.postMessage({ command: 'rejectChange', changeId: ch.id });
		});

		actions.appendChild(acceptBtn);
		actions.appendChild(rejectBtn);
		header.appendChild(pathSpan);
		header.appendChild(actions);

		const viewport = document.createElement('div');
		viewport.className = 'diff-viewport';

		// Generate a very basic side-by-side or line diff view
		const originalLines = ch.originalContent.split('\n');
		const proposedLines = ch.proposedContent.split('\n');
		
		if (originalLines.length === 1 && originalLines[0] === '') {
			// Entire file is new
			proposedLines.forEach(line => {
				const lineDiv = document.createElement('div');
				lineDiv.className = 'diff-line addition';
				lineDiv.textContent = '+ ' + line;
				viewport.appendChild(lineDiv);
			});
		} else {
			// Simple unified line diff
			originalLines.forEach(line => {
				if (!proposedLines.includes(line)) {
					const lineDiv = document.createElement('div');
					lineDiv.className = 'diff-line deletion';
					lineDiv.textContent = '- ' + line;
					viewport.appendChild(lineDiv);
				}
			});
			proposedLines.forEach(line => {
				if (!originalLines.includes(line)) {
					const lineDiv = document.createElement('div');
					lineDiv.className = 'diff-line addition';
					lineDiv.textContent = '+ ' + line;
					viewport.appendChild(lineDiv);
				} else {
					const lineDiv = document.createElement('div');
					lineDiv.className = 'diff-line';
					lineDiv.textContent = '  ' + line;
					viewport.appendChild(lineDiv);
				}
			});
		}

		changesDiffContainer.appendChild(header);
		changesDiffContainer.appendChild(viewport);
	});
}

// Stepper rendering
function renderWalkthrough(plan, steps) {
	walkthroughContainer.style.display = 'flex';
	walkthroughPlanDesc.innerHTML = plan;
	walkthroughStepsList.innerHTML = '';
	
	steps.forEach((step, idx) => {
		const stepDiv = document.createElement('div');
		stepDiv.className = 'walkthrough-step';

		const row = document.createElement('div');
		row.className = 'walkthrough-step-row';

		const statusIcon = document.createElement('span');
		statusIcon.className = `step-status ${step.status}`;

		const title = document.createElement('span');
		title.className = 'step-title';
		title.textContent = step.title;

		const badge = document.createElement('span');
		badge.className = 'step-badge';
		badge.textContent = step.action;

		row.appendChild(statusIcon);
		row.appendChild(title);
		row.appendChild(badge);
		stepDiv.appendChild(row);

		// Render comments
		if (step.comments && step.comments.length > 0) {
			const commentsDiv = document.createElement('div');
			commentsDiv.className = 'step-comments';
			step.comments.forEach(c => {
				const cDiv = document.createElement('div');
				cDiv.className = 'step-comment';
				cDiv.textContent = c;
				commentsDiv.appendChild(cDiv);
			});
			stepDiv.appendChild(commentsDiv);
		}

		// Comment input box
		const commentRow = document.createElement('div');
		commentRow.className = 'comment-input-row';

		const cInput = document.createElement('input');
		cInput.type = 'text';
		cInput.placeholder = 'Add step feedback...';

		const cBtn = document.createElement('button');
		cBtn.className = 'secondary-btn';
		cBtn.textContent = 'Add';
		cBtn.addEventListener('click', () => {
			const comment = cInput.value.trim();
			if (comment) {
				vscode.postMessage({ command: 'commentStep', stepIndex: idx, comment });
				cInput.value = '';
			}
		});

		commentRow.appendChild(cInput);
		commentRow.appendChild(cBtn);
		stepDiv.appendChild(commentRow);

		walkthroughStepsList.appendChild(stepDiv);
	});
}

// Receive messages from backend
window.addEventListener('message', event => {
	const message = event.data;
	switch (message.command) {
		case 'sessionsLoaded':
			sessions = message.sessions;
			if (sessions.length > 0) {
				currentSession = sessions[sessions.length - 1];
			}
			renderSessions();
			renderChat();
			break;
		case 'rollbackSuccess':
			currentSession = message.session;
			currentSession.messages = currentSession.messages.slice(0, message.index + 1);
			saveSessions();
			renderChat();
			resetState();
			break;
		case 'autocompleteResults':
			renderAutocomplete(message.results);
			break;
		case 'fileContentLoaded':
			// File open simulation or content load confirmation
			break;
		case 'agentThinking':
			// Show running overlay/spinner
			sendBtn.disabled = true;
			sendBtn.textContent = 'Thinking...';
			break;
		case 'agentIdle':
			sendBtn.disabled = false;
			sendBtn.textContent = 'Send';
			break;
		case 'walkthroughGenerated':
			renderWalkthrough(message.plan, message.steps);
			break;
		case 'stepUpdated':
			// Update single step status or comment in walkthrough list
			const stepDivs = walkthroughStepsList.querySelectorAll('.walkthrough-step');
			const step = message.step;
			const idx = message.stepIndex;
			
			// Update status light
			const light = stepDivs[idx]?.querySelector('.step-status');
			if (light) {
				light.className = `step-status ${step.status}`;
			}
			
			// Re-render comments if they changed
			let commentsDiv = stepDivs[idx]?.querySelector('.step-comments');
			if (commentsDiv) {
				commentsDiv.remove();
			}
			if (step.comments && step.comments.length > 0) {
				commentsDiv = document.createElement('div');
				commentsDiv.className = 'step-comments';
				step.comments.forEach(c => {
					const cDiv = document.createElement('div');
					cDiv.className = 'step-comment';
					cDiv.textContent = c;
					commentsDiv.appendChild(cDiv);
				});
				stepDivs[idx]?.insertBefore(commentsDiv, stepDivs[idx].querySelector('.comment-input-row'));
			}
			break;
		case 'showDiff':
			// Switch tab to Code Changes
			tabButtons.forEach(b => b.classList.remove('active'));
			tabContents.forEach(c => c.classList.remove('active'));
			const changesTabBtn = document.querySelector('[data-tab="tab-changes"]');
			changesTabBtn.classList.add('active');
			document.getElementById('tab-changes').classList.add('active');

			proposedChanges = [{
				id: message.changeId,
				filePath: message.filePath,
				originalContent: message.originalContent,
				proposedContent: message.proposedContent
			}];
			renderProposedChanges();
			break;
		case 'addArtefact':
			artefacts.push({
				filePath: message.filePath,
				type: message.type
			});
			renderArtefacts();
			break;
		case 'taskStarted':
			tasks.push({
				id: message.taskId,
				commandLine: message.commandLine,
				status: 'running',
				output: ''
			});
			renderTasks();
			break;
		case 'taskOutput':
			const tOut = tasks.find(t => t.id === message.taskId);
			if (tOut) {
				tOut.output += message.output;
				renderTasks();
			}
			break;
		case 'taskCompleted':
			const tComp = tasks.find(t => t.id === message.taskId);
			if (tComp) {
				tComp.status = message.exitCode === 0 ? 'completed' : 'failed';
				renderTasks();
			}
			break;
		case 'taskFailed':
			const tFail = tasks.find(t => t.id === message.taskId);
			if (tFail) {
				tFail.status = 'failed';
				tFail.output += '\nError: ' + message.error;
				renderTasks();
			}
			break;
		case 'taskAborted':
			const tAbort = tasks.find(t => t.id === message.taskId);
			if (tAbort) {
				tAbort.status = 'failed';
				tAbort.output += '\nTask aborted by user.';
				renderTasks();
			}
			break;
		case 'agentFinished':
			// Render assistant summary in chat
			sendBtn.disabled = false;
			sendBtn.textContent = 'Send';
			currentSession.messages.push({ role: 'assistant', content: message.summary });
			saveSessions();
			renderChat();
			walkthroughContainer.style.display = 'none';
			break;
		case 'agentError':
			sendBtn.disabled = false;
			sendBtn.textContent = 'Send';
			currentSession.messages.push({ role: 'system', content: `Error: ${message.error}` });
			renderChat();
			break;
	}
});

function renderAutocomplete(results) {
	if (results.length === 0) {
		autocompleteBox.style.display = 'none';
		return;
	}

	autocompleteBox.innerHTML = '';
	autocompleteBox.style.display = 'block';
	autocompleteSelectionIndex = 0;

	results.forEach((item, idx) => {
		const div = document.createElement('div');
		div.className = 'autocomplete-item' + (idx === 0 ? ' selected' : '');
		div.dataset.path = item.path;
		div.dataset.type = item.type;
		
		const icon = document.createElement('span');
		icon.className = 'type-icon';
		icon.textContent = item.type === 'directory' ? '📁' : '📄';

		const name = document.createElement('span');
		name.textContent = item.name;

		const path = document.createElement('span');
		path.className = 'item-path';
		path.textContent = item.path;

		div.appendChild(icon);
		div.appendChild(name);
		div.appendChild(path);

		div.addEventListener('click', () => {
			insertAutocomplete(item.path, item.type);
		});

		autocompleteBox.appendChild(div);
	});
}
