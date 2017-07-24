import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface CompletionContextInterface {
	line: vscode.TextLine;
	moduleName?: string;
	importStart?: number;
	importEnd?: number;
	fromStart?: number;
	// fromEnd?: number;
	quoteChar?: string;
	quoteStart?: number;
	quoteEnd?: number;
	search?: string;
};

export default class ProvidesModuleProvider implements vscode.CompletionItemProvider {
	// Constants
	public static readonly maxLineCheck: number = 5;
	public static readonly languages: string[] = [ 'javascript', 'javascriptreact' ];
	public static readonly completionChars: string[] = [ ';', '/', '\'', '"' ];
	
	// Module cache
	public static modules: string[] = [];
	public static moduleLookup: {} = {};

	private context: vscode.ExtensionContext;
	private readonly disposables: vscode.Disposable[] = [];

	// File watcher
	private jsFileWatcher: vscode.FileSystemWatcher;

	/**
	 * Extension initialization
	 * @param context The extension context
	 */
	public activate(context: vscode.ExtensionContext): void {
		// Cache the context and subscribe to it
		this.context = context;
		context.subscriptions.push(this);

		// Create completion provider
		vscode.languages.registerCompletionItemProvider(
			ProvidesModuleProvider.languages,
			this,
			...ProvidesModuleProvider.completionChars
		);

		// Create a file watcher for JS modules then push it to disposables
		this.jsFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.js');
		this.disposables.push(this.jsFileWatcher);

		// Subscribe to file watch events
		this.jsFileWatcher.onDidChange(this.onWatchedFileChanged);
		this.jsFileWatcher.onDidCreate(this.onWatchedFileChanged);
		this.jsFileWatcher.onDidDelete(this.onWatchedFileDeleted);

		// Cache modules on activate
		this.cacheModules();
		vscode.commands.registerCommand('extension.cacheModules', this.cacheModules);
	}

	public cacheModules = (): void => {
		new Promise((resolve, reject) => {
			vscode.workspace.findFiles('**/*.js', '**/node_modules/**', 500)
				.then(async result => {
					for (var i = 0; i < result.length; i++) {
						await this.addOrRemoveModuleToCache(result[i]);
					}
				});
		});
	}

	/**
	 * Extension tear down
	 */
	public dispose(): void {
		this.disposables.map(item => item.dispose());
	}

	/**
	 * Provides completion items for the given position and document
	 * @param document The document where the command was invoked
	 * @param position The position where the command was invoked
	 * @param token Cancellation token
	 * @returns An array of completions
	 */
	public async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
		const context = this.getCompletionContext(document, position);
		if (!context) {
			return [];
		}

		// If there is a provided moduleName that should always be in the predictions
		const hasModuleName = context.moduleName && context.moduleName.indexOf('{') < 0;
		const result: vscode.CompletionItem[] = [];
		ProvidesModuleProvider.modules.filter(module => {
			if (module.indexOf(context.search) > -1 || (hasModuleName && module.indexOf(context.moduleName) > -1)) {
				result.push(new vscode.CompletionItem(module, vscode.CompletionItemKind.Module));
			}
		});
		return result;
	}

	/**
	 * @param item Completion item currently active in the UI
	 * @param token Cancellation token
	 * @returns The resolved completion item
	 */
	public resolveCompletionItem?(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.CompletionItem | Thenable<vscode.CompletionItem> {
		return item;
	}

	private getCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContextInterface {
		const line = document.lineAt(position);
		const lineText = line.text.trim();
		const importStart = lineText.indexOf('import ');
		const importEnd = importStart + 'import '.length;
		const fromStart = lineText.indexOf('from ', importEnd);
		
		// if it isn't some sort of import line post-`from` then we don't care about it
		if (fromStart < 0) {
			return;
		}

		let context: CompletionContextInterface = {
			line,
			importStart,
			importEnd,
			fromStart,
			moduleName: importStart > -1 && lineText.slice(importEnd, fromStart).trim(),
		};

		const [ quoteIndex, quoteChar ] = this.getQuotationPosition(lineText, position.character);
		context.quoteStart = quoteIndex;
		context.quoteChar = quoteChar;
		context.search = lineText.slice(quoteIndex + 1, position.character);

		return context;
	}

	private getQuotationPosition(line: string, index: number): [ number, string ] {
		const i = line.lastIndexOf('\'', index - 1);
		const j = line.lastIndexOf('"', index - 1);
		if (i > j) {
			return [ i, '\'' ];
		}
		return [ j, '"' ];
	}

	private removeAtIndex(index: number): Array<string> {
		return ProvidesModuleProvider.modules = ProvidesModuleProvider.modules
			.slice(0, index)
			.concat(ProvidesModuleProvider.modules.slice(index + 1));
	}

	private onWatchedFileChanged = async (e: vscode.Uri): Promise<void> => {
		this.addOrRemoveModuleToCache(e);
	}

	private onWatchedFileDeleted = async (e: vscode.Uri): Promise<void> => {
		const moduleIndex = ProvidesModuleProvider.moduleLookup[e.path];
		if (moduleIndex == null)
			return;
		// Module is cached, delete it
		this.deleteModuleFromCache(e.path, moduleIndex);
	}

	private addOrRemoveModuleToCache = async (uri: vscode.Uri): Promise<void> => {
		const moduleName = await this.getProvidedModule(uri);
		const moduleIndex = ProvidesModuleProvider.moduleLookup[uri.path];

		// It's not cached and still shouldn't be cached. Ignore.
		if (moduleName === '' && typeof(moduleIndex) === 'undefined') {
			return;
		}

		if (moduleIndex >= 0) {
			// It's been deleted. Remove
			if (moduleName === '') {
				this.deleteModuleFromCache(uri.path, moduleIndex);
				return;
			}

			// If there hasn't been a change, don't do anything.
			if (moduleName === ProvidesModuleProvider.modules[moduleIndex]) {
				return;
			}
			
			// The name has been changed, update it
			ProvidesModuleProvider.modules[moduleIndex] = moduleName;
			return;
		}

		// A module was found, push it into the module dictionary
		this.addModuleToCache(moduleName, uri.path);
	}

	private deleteModuleFromCache = (path: string, index: number): void => {
		ProvidesModuleProvider.modules = this.removeAtIndex(index);
		delete ProvidesModuleProvider.moduleLookup[path];
	}

	private addModuleToCache = (name: string, path: string): void => {
		//this.debug('adding module', name, 'to cache');
		ProvidesModuleProvider.modules.push(name);
		ProvidesModuleProvider.moduleLookup = {
			...ProvidesModuleProvider.moduleLookup,
			[path]: ProvidesModuleProvider.modules.length - 1,
		};
	}

	private async getProvidedModule(file: vscode.Uri): Promise<string> {
		const doc = await vscode.workspace.openTextDocument(file);
		if (doc.lineCount < 1) {
			return '';
		}
		// Iterate through the lines until a module is found or we reach the max search amount
		const linesToSearch = Math.min(ProvidesModuleProvider.maxLineCheck, doc.lineCount);
		for (let i = 0; i < linesToSearch; i++) {
			// Check if the line is empty or not
			const line = doc.lineAt(i);
			if (line.isEmptyOrWhitespace)
				continue;
			// Split the line into words, check to see we haven't passed the opening comment
			const words = line.text.split(' ');
			if (words.length < 2 || words[1] == '*/')
				continue;
			// Return the module name if it was found
			if (words.some(word => word === '@providesModule'))
				return words[words.length - 1];
		}
		// Return nothing if nothing was found
		return '';
	}

	private debug(...data: any[]): void {
		console.log('[providesModule Sense]:', ...data);
	}
}