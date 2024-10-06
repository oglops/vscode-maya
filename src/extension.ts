'use strict';

import * as vscode from 'vscode';
import * as data from './completions.json';

import { Socket } from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

var net = require('net');
import TelemetryReporter from '@vscode/extension-telemetry';

let mayaportStatusBar: vscode.StatusBarItem;
let socket_mel: Socket;
let port_mel: string;
let reporter: TelemetryReporter; // telemetry reporter 

// all events will be prefixed with this event name
// extension version will be reported as a property with each event 
const extensionId = 'saviof.mayacode';
const extensionVersion = vscode.extensions.getExtension(extensionId).packageJSON.version;

// the application insights key (also known as instrumentation key)
const key = '9f14526e-33c3-420b-a5ff-2bdab837dc10';

function updateStatusBarItem(langID?: string): void {
	let text: string;
	if (langID == 'python' || langID == 'mel') {
		if (socket_mel instanceof Socket == true && socket_mel.destroyed == false) {
			text = `Maya Port : ${port_mel}`;
			mayaportStatusBar.text = text;
			mayaportStatusBar.show();
		}
	}

	if (!text) {
		mayaportStatusBar.hide();
	}
}

export class TimeUtils {
	public static getTime(): String {
		return new Date()
			.toISOString()
			.replace(/T/, ' ')
			.replace(/\..+/, '')
			.split(' ')[1];
	}
}

export class Logger {
	private static _outputPanel;
	private static _logVisibility: boolean = true; // Control visibility for `info`, `error`, and `success`
	private static _includeTimestamp: boolean = true; // Control whether to include a timestamp

	public static registerOutputPanel(outputPanel: vscode.OutputChannel) {
		this._outputPanel = outputPanel;
	}

	// Set log visibility (can toggle on or off)
	public static setLogVisibility(isVisible: boolean) {
		this._logVisibility = isVisible;
	}

	// Info logs (only shown if visibility is enabled)
	public static info(log: string) {
		if (this._logVisibility) {
			this.typeLog(log, 'INFO');
		}
	}

	// Error logs (only shown if visibility is enabled)
	public static error(log: string) {
		if (this._logVisibility) {
			this.typeLog(log, 'ERROR');
			vscode.window.showErrorMessage(log);
		}
	}

	// Success logs (only shown if visibility is enabled)
	public static success(log: string) {
		if (this._logVisibility) {
			this.typeLog(log, 'SUCCESS');
		}
	}

	// Response logs (always visible, without timestamp)
	public static response(log: string) {
		let cleanedLog = this.cleanLog(log);
		if (this.isValidLog(cleanedLog)) {  // Always check validity
			this._outputPanel.appendLine(cleanedLog);
		}
	}

	private static cleanLog(log: string | null | undefined): string | null {
		if (log === null || log === undefined) return null;
		
		// Remove all types of whitespace including newlines
		return log.replace(/\0/g, '').replace(/[\r\n]+/g, '\n').trim(); // Replace newlines with a space, then trim
	}

	private static typeLog(log: String, type: String, includeTimestamp: boolean = true) {
		if (!this._outputPanel) {
			return;
		}
		let util = require('util');
		let time = includeTimestamp ? TimeUtils.getTime() : '';  // Add timestamp only if required
		if (!log || !log.split) return;
		let formattedLog = log;

		// Handle timestamp exclusion for response logs
		if (includeTimestamp) {
			formattedLog = util.format('[%s][%s]\t %s', time, type, log);
		}

		this._outputPanel.appendLine(formattedLog);
	}

	// Check if a log message is valid
	private static isValidLog(log: string | null | undefined): boolean {
		// Log a message if null or undefined is being passed for easier debugging
		if (log === null || log === undefined || log.trim() === '') {
			console.warn(`[Logger] Invalid log passed: ${log}`);
			return false;  // Do not log empty, null, or undefined messages
		}
		return true;
	}
}

class MelDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

	private getProcRange(ln_start: number, ln_end: number): vscode.Range {
        let pos1 = new vscode.Position(ln_start, 0);
        let pos2 = new vscode.Position(ln_end, 0);
        return new vscode.Range(pos1, pos2);
	}
	
	private getRange(name:string, text:string, ln_num: number): vscode.Range {
		let pos = text.indexOf(name)
        let pos1 = new vscode.Position(ln_num, pos);
        let pos2 = new vscode.Position(ln_num, pos+name.length);
        return new vscode.Range(pos1, pos2);
    }

	public provideDocumentSymbols(
		document: vscode.TextDocument, 
		token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]>
		{
        return new Promise((resolve, reject) => 
        { 
			let symbols: vscode.DocumentSymbol[] = [];
			let nodes = [symbols]
			let inside_proc = false
			let nested_levels = 0

			let symbolkind_proc = vscode.SymbolKind.Function
			let symbolkind_var = vscode.SymbolKind.Variable
			
			let procTypes = ["string", "string[]"]

			let proc_symbol;
			let proc_start_line:number;
			
			for (var i = 0; i < document.lineCount; i++) {
				var line = document.lineAt(i);
				let tokens = line.text.split(" ")

				for (var x = 0; x < tokens.length; x++) {

					let cur_token = tokens[x].trim()

					if (cur_token == '{' || cur_token.includes("{"))
					{//open 
						nested_levels += 1}

					// found a proc
					if (cur_token == "proc"){
						let proc_name = tokens[x+1]
						if(procTypes.includes(proc_name)){
							proc_name = tokens[x+2]
						}

						let clean_proc_name = proc_name.split("(")[0]
						let proc_range = this.getRange(clean_proc_name, line.text, i);
						proc_start_line = i

						proc_symbol = new vscode.DocumentSymbol(
							clean_proc_name,
							'',
							symbolkind_proc,
							line.range, proc_range)
	
						nodes[nodes.length-1].push(proc_symbol)
						if (!inside_proc) {
							nodes.push(proc_symbol.children)
							inside_proc = true
						}
					}
					if (cur_token == "}" || cur_token.includes("}")){
						//closed
						nested_levels -= 1
						if (inside_proc && nested_levels == 0) {
							proc_symbol.range = this.getProcRange(proc_start_line, i)
							nodes.pop()
							inside_proc = false
						}
					}

					// found a variable
					if (cur_token.startsWith("$")){
						if(tokens[x+1] == "=" || cur_token.includes("=")){
							let clean_var_name = cur_token.split("=")[0]
							let var_range = this.getRange(clean_var_name, line.text, i);
							let var_symbol = new vscode.DocumentSymbol(
								clean_var_name,
								'',
								symbolkind_var,
								var_range, var_range)
		
							nodes[nodes.length-1].push(var_symbol)
						}
					}
				}
			}
			resolve(symbols);
		});
	}
}

export function activate(context: vscode.ExtensionContext) {
	let outputPanel = vscode.window.createOutputChannel('Maya');
	Logger.registerOutputPanel(outputPanel);

	let cmds: Array<string> = [];
	let words: Array<string> = [];
	let seen_splits: Array<string> = [];
	let completions: Array<vscode.CompletionItem> = [];
	let word_completions: Array<vscode.CompletionItem> = [];
	let var_completions: Array<vscode.CompletionItem> = [];
	let lastStackTrace: string;
	const timeOpened = Date.now()

	var config = vscode.workspace.getConfiguration('mayacode');
	const verboseLogging = config.get<boolean>('logging.verbose', false);
	Logger.setLogVisibility(verboseLogging);

    // Register to listen for configuration changes and update log visibility dynamically
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('mayacode.logging.verbose')) {
            const updatedVerboseLogging = config.get<boolean>('logging.verbose', false);
            Logger.setLogVisibility(updatedVerboseLogging);
        }
    });

	// create telemetry reporter on extension activation
	// ensure it gets property disposed
	reporter = new TelemetryReporter(extensionId, extensionVersion);
	context.subscriptions.push(reporter);
	reporter.sendTelemetryEvent('start', {})

	function sendError(error: Error, code: number=0, category='typescript'){
		if(config.get('telemetry')){
			if(error.stack == lastStackTrace) return
			Logger.info(`Sending error event`);
			reporter.sendTelemetryEvent('exception', {
                code: code.toString(),
                category,
			})
			lastStackTrace = error.stack
		}
	}

	function sendEvent(event: string, execTime: number=0, fileType:string){
		if(config.get('telemetry')){
			const measurements: {[key: string]: number} = {}
			measurements['timeSpent'] = (Date.now() - timeOpened)/1000
			measurements['execTime'] = execTime

			const properties: {[key: string]: string} = {}
			properties['fileType'] = fileType

			Logger.info(`Sending event`);
			reporter.sendTelemetryEvent(event, properties, measurements)
		}
	}

	function cleanResponse(data: Buffer){
		var dataString = data.toString()
		if(dataString.startsWith("Error")){
			dataString = dataString.replace(/MayaCode.py", line (?<name>\d+)/, (...match) => {
				let newLineno = match[0].replace(match[1], (+match[1]-1).toString())
				return newLineno;
			})
		}
		return dataString
	}

	function ensureConnection(type: string) {
		let socket;
		let mayahost: string = config.get('hostname');
		let port: string = config.get('mel.port');

		socket = socket_mel;
		port_mel = port;

		if (socket instanceof Socket == true && socket.destroyed == false) {
			Logger.info(`Already active : Port ${port} on Host ${mayahost} for ${type}`);
			updateStatusBarItem(type);
		} else {
			socket = net.createConnection({ port: port, host: mayahost }, () => {
				Logger.info(`Connected : Port ${port} on Host ${mayahost} for ${type}`);
				updateStatusBarItem(type);
			});
			socket.on('error', function(error) {
				let errorMsg = `Unable to connect using port ${port} on Host ${mayahost}   \nPlease run the below mel command in Maya\`s script editor 

				commandPort -n "${mayahost}:${port}" -stp "mel" -echoOutput;

				Error Code : ${error.code}`;
				Logger.error(errorMsg);
				sendError(error, error.code, 'socket')
			});

			socket.on('data', function(data: Buffer) {
				Logger.response(cleanResponse(data));
			});

			socket.on('end', () => {
				Logger.info(`Disconnected from server. ${type} | Port ${port} on Host ${mayahost}`);
				updateStatusBarItem(type);
			});
		}
		return socket;
	}

    function dedent(text: string) {
        // Match the common leading whitespace of all non-empty lines
        const match = text.match(/^[ \t]*(?=\S)/gm);
        
        if (!match) return text; // Return as is if no match
    
        // Find the minimum leading whitespace
        const indent = Math.min(...match.map(el => el.length));
    
        // Remove that amount of leading whitespace from every line
        const dedentedText = text.replace(new RegExp(`^[ \\t]{${indent}}`, 'gm'), '');
        
        return dedentedText;
    }

	function send_tmp_file(text: string, type: string) {
		let cmd:string, nativePath:string, posixPath:string;
		var start = new Date().getTime();

		if (type == 'python') {
			//add encoding http://python.org/dev/peps/pep-0263/
			text = "# -*- coding: utf-8 -*-\n" + text;
			nativePath = path.join(os.tmpdir(), "MayaCode.py");
			posixPath = nativePath.replace(/\\/g, "/");
			if(config.get('runner.latest')){
				cmd = `python("exec(open('${posixPath}').read())")`;
			}else{
				cmd = `python("execfile('${posixPath}')")`;
			}
		}

		if (type == 'mel') {
			nativePath = path.join(os.tmpdir(), "MayaCode.mel");
			posixPath = nativePath.replace(/\\/g, "/");
			cmd = `source \"${posixPath}\";`;
		}

		Logger.info(`Writing text to ${posixPath}...`);
		fs.writeFile(nativePath, text, function (err) {
			if (err) {
				Logger.error(`Failed to write ${type} to temp file ${posixPath}`);
				sendError(err, 1, 'filewrite')
			} else {
				Logger.info(`Executing ${cmd}...`);
				send(cmd, type);
				var end = new Date().getTime();
				var time = end - start;
				sendEvent("send_tmp_file", time, type)
			}
		});
	}

	function send(text: string, type: string) {
		let success: boolean = socket_mel.write(text + '\n');
		// let success: boolean = socket_mel.write(text + '\n', "utf8");
		Logger.info(text);
		if (success){
			let successMsg = `Sent ${type} code to Maya...`;
			Logger.info(successMsg);
			vscode.window.setStatusBarMessage(successMsg);
		}
	}

	function getText(type: string, current_line: boolean = false) {
		let editor = vscode.window.activeTextEditor;
		let selection = editor.selection;
		let text: string;
		const languageId = editor.document.languageId;

		if (selection.isEmpty != true) {
			Logger.info(`Sending selected ${type} code to maya`);
			let selectedText = editor.document.getText(selection);
			
			// Check if the selection is on a single line
			const isSingleLine = selection.start.line === selection.end.line;

			// Check if the selected text has no spaces or is a single word
			const isSingleWord = /^[^\s]+$/.test(selectedText);

			let selectedTextTrim = selectedText.trim();

			if (isSingleLine && isSingleWord) {
				if (languageId === 'mel' && (!selectedTextTrim.startsWith('$'))) {
						text = `print($${selectedTextTrim});`
				}
				else
					text = `print(${selectedTextTrim});`

			}
			else {
				// Get the start position of the selection
				let selectionStart = selection.start;

				// Get all text from the beginning of the line to the selection start position
				let lineText = editor.document.getText(new vscode.Range(selectionStart.line, 0, selectionStart.line, selectionStart.character));
		
				// Use regex to match whitespace from the start of the line up to the selection start
				let leadingWhitespace = lineText.match(/^[\s\t]*/); // Match spaces or tabs at the beginning of the string

				// Combine the leading whitespace and selected text
				text = (leadingWhitespace ? leadingWhitespace[0] : '') + selectedText;

				text = dedent(text);
			}
		
		} else {
			if (current_line == true) {
				Logger.info(`Sending current line of ${type} code to maya`);
				// Get the cursor position
				const position = editor.selection.active;

				// Get the entire text of the current line
				const lineText = editor.document.lineAt(position.line).text;
		
				// Return the trimmed text (leading/trailing spaces removed)
				text = lineText.trim();
			} else {
				Logger.info(`Sending all ${type} code to maya`);
				text = editor.document.getText();
			}
		}
		return text;
	}

	function registerDisposables() {
		return [
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (mayaportStatusBar !== undefined) {
					if (editor !== undefined) {
						if (['debug', 'output'].some(part => editor.document.uri.scheme === part)) {
							return;
						}
					}
					updateStatusBarItem(editor.document.languageId);
				}
			})
		];
	}

	function isNumeric(value) {
		return /^-{0,1}\d+$/.test(value);
	}

	function process_completions(documentText:string) {
		var start = new Date().getTime();

		if (completions.length == 0) {
			Logger.info(`Building command completions`);

			data['completions'].forEach(this_item => {
				words.push(this_item['trigger']);
				let item = new vscode.CompletionItem(this_item['trigger'], vscode.CompletionItemKind.Function);
				item.detail = this_item['trigger'];
				item.documentation = this_item['comment'];
				completions.push(item);
			});
			var end = new Date().getTime();
			var time = end - start;
			sendEvent("build-completions", time, "mel")
		}

		const _splitTexts = documentText.split(/[^A-Za-z\$1-9]+/);
		_splitTexts.forEach(_word => {
			if (seen_splits.indexOf(_word) == -1) {
				seen_splits.push(_word);
				let isVariable = false;
				_word = _word.trim();
				if (_word.startsWith('$')) {
					isVariable = true;
					_word = _word.replace('$', '');
				}

				//negate all numbers and aready added items
				if (!isNumeric(_word) && words.indexOf(_word) == -1) {
					words.push(_word);
					if (isVariable) {
						var_completions.push(new vscode.CompletionItem(_word, vscode.CompletionItemKind.Variable));
					} else {
						word_completions.push(new vscode.CompletionItem(_word, vscode.CompletionItemKind.Text));
					}
				}
			}
		});

		var end = new Date().getTime();
		var time = end - start;
		Logger.info(`Completion execution time: ${time}`);
	}

	function getHoverText(url: string, documentation:string): vscode.MarkdownString {
		const text = `${documentation}\n\n[Read Online Help](${url})`;
		return new vscode.MarkdownString(text);
	}

	let hoverProviderMELdisposable = vscode.languages.registerHoverProvider("mel", {
			provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {

				if (cmds.length == 0) {
					Logger.info(`Building cmds`);

					data['completions'].forEach(this_item => {
						cmds.push(this_item['trigger']);
					});
				}

				const range = document.getWordRangeAtPosition(pos);

				if (range === undefined) {
					return;
				}

				const word = document.getText(range);

				if (cmds.indexOf(word) > -1){
					const helpUrl = `http://help.autodesk.com/cloudhelp/2017/ENU/Maya-Tech-Docs/Commands/${word}.html`;
					let documentation = '';
					data['completions'].forEach(this_item => {
						if (this_item['trigger'] == word) {
							documentation = this_item['comment'].replace(/\n/g, "  \n");
						}
					});
					return new vscode.Hover(getHoverText(helpUrl, documentation));
				}

				return;
			}
		}
	);

	context.subscriptions.push(hoverProviderMELdisposable);

	const provider_all = vscode.languages.registerCompletionItemProvider('mel', {
		provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token, context) {

			process_completions(document.getText());
			return [...word_completions, ...completions];
		}
	});

	const provider_vars = vscode.languages.registerCompletionItemProvider('mel', {
		provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token, context) {

			process_completions(document.getText());
			return [...var_completions];
		}
	}, '$');

	const provider_symbols = vscode.languages.registerDocumentSymbolProvider(
		{scheme: "file", language: "mel"}, 
		new MelDocumentSymbolProvider()
	)

	context.subscriptions.push(provider_symbols);
	context.subscriptions.push(provider_all);
	context.subscriptions.push(provider_vars);

	const command_mel = vscode.commands.registerCommand('mayacode.sendMelToMaya', function() {
		socket_mel = ensureConnection('mel');
		if (!socket_mel.destroyed) {
			let text = getText('mel');
			send_tmp_file(text, 'mel');
		}
	});

	context.subscriptions.push(command_mel);

	const command_py = vscode.commands.registerCommand('mayacode.sendPythonToMaya', function() {
		socket_mel = ensureConnection('python');
		if (!socket_mel.destroyed) {
			let text = getText('python');
			send_tmp_file(text, 'python');
		}
	});

	context.subscriptions.push(command_py);

	const command_line = vscode.commands.registerCommand('mayacode.sendCurrentLineToMaya', function() {
		socket_mel = ensureConnection('python');
		const editor = vscode.window.activeTextEditor;
		if (!socket_mel.destroyed && editor) {
			const languageId = editor.document.languageId;
			let text = getText(languageId, true);
			send_tmp_file(text, languageId);
		}
	});

	context.subscriptions.push(command_py);
	

	mayaportStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(mayaportStatusBar);

	context.subscriptions.push(...registerDisposables());
}

export function deactivate(context: vscode.ExtensionContext) {
	// This will ensure all pending events get flushed
	reporter.dispose();
}
