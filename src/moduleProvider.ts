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
	public static readonly maxModuleCache: number = 1000;
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

	/**
	 * iterates through all of the files in a workspace and caches them.
	 */
	public cacheModules = (): void => {
		new Promise((resolve, reject) => {
			vscode.workspace.findFiles('**/*.js', '**/node_modules/**', ProvidesModuleProvider.maxModuleCache)
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
		// Get context for the current position. If there is none, exit early
		const context = this.getCompletionContext(document, position);
		if (!context) {
			return [];
		}

		// If there is a provided moduleName that should always be in the predictions
		const hasModuleName = context.moduleName && context.moduleName.indexOf('{') < 0;
		const result: vscode.CompletionItem[] = [];
		// Filter out modules that don't match our search or the provided module name
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

	/**
	 * Gets the intellisense context of a given document position
	 * @param document The active document
	 * @param position The current active position in the document
	 * @returns An interface with information about the current line
	 */
	private getCompletionContext(document: vscode.TextDocument, position: vscode.Position): CompletionContextInterface {
		const line = document.lineAt(position);
		const lineText = line.text.trim();
		const importStart = lineText.indexOf('import ');
		const importEnd = importStart + 'import '.length;
		const fromStart = lineText.indexOf('from ', importEnd);
		
		// if it isn't some sort of import line post-`from` then we don't care about it
		if (fromStart < 0 || lineText.lastIndexOf(';') > -1) {
			return;
		}

		// Create our base context
		const context: CompletionContextInterface = {
			line,
			importStart,
			importEnd,
			fromStart,
			moduleName: importStart > -1 && lineText.slice(importEnd, fromStart).trim(),
		};

		// Figure out where the quotes are so we can determine what the user has been searching for
		const [ quoteIndex, quoteChar ] = this.getQuotationPosition(lineText, fromStart);
		context.quoteStart = quoteIndex;
		context.quoteChar = quoteChar;
		context.search = lineText.slice(quoteIndex + 1, position.character);

		return context;
	}

	/**
	 * Figure out where the first quotation mark is
	 * @param line The text that makes up the line to search in
	 * @param index The index at which to start searching
	 * @returns Tuple of the index of the first quotation and the type of quotation
	 */
	private getQuotationPosition(line: string, index: number): [ number, string ] {
		const i = line.indexOf('\'', index - 1);
		const j = line.indexOf('"', index - 1);
		// Since not found is -1, whichever character has been found will be greater than the other
		if (i > j) {
			return [ i, '\'' ];
		}
		return [ j, '"' ];
	}

	/**
	 * Returns a new module array with the given index removed
	 * @param index The index to remove
	 * @returns A new array without the index
	 */
	private removeAtIndex(index: number): Array<string> {
		return ProvidesModuleProvider.modules = ProvidesModuleProvider.modules
			.slice(0, index)
			.concat(ProvidesModuleProvider.modules.slice(index + 1));
	}

	/**
	 * Callback for handling whenever the a watched file is changed.
	 * Will perform a check as to whether this module needs to be cached or not.
	 * @param e The VSCode URI for the file.
	 * @returns A promise
	 */
	private onWatchedFileChanged = async (e: vscode.Uri): Promise<void> => {
		this.addOrRemoveModuleToCache(e);
	}

	/**
	 * Callback for handling whenever a watched file has been deleted.
	 * This removes the module from the module cache (if it was cached in the first place).
	 * @param e The VSCode URI for the file
	 * @returns A promise
	 */
	private onWatchedFileDeleted = async (e: vscode.Uri): Promise<void> => {
		const moduleIndex = ProvidesModuleProvider.moduleLookup[e.path];
		if (moduleIndex == null)
			return;
		// Module is cached, delete it
		this.deleteModuleFromCache(e.path, moduleIndex);
	}

	/**
	 * Given a VSCode file URI it will parse the top of the file for a @providesModule declaration,
	 * then take one of several actions:
	 * 	- if the file is not cached and there is now a @providesModule declaration, it caches the module.
	 * 	- if the file is cached and there is a different or module name, it will update the cached module name.
	 *  - if the file has been renamed, it will rename the records in the cache and lookup object
	 * 	- if the file is cached and there is no longer a @providesModule declaration, it will remove it from the cache
	 * @param uri The VSCode URI for the module to add/remove
	 * @returns A promise
	 */
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

	/**
	 * Removes a module from the cache and lookup dictionary
	 * @param path The path/key to the module
	 * @param index The index of the module
	 */
	private deleteModuleFromCache = (path: string, index: number): void => {
		ProvidesModuleProvider.modules = this.removeAtIndex(index);
		delete ProvidesModuleProvider.moduleLookup[path];
	}

	/**
	 * Adds a module to the cache.
	 * @param name The module name
	 * @param path The path to the module (used as the key for lookup)
	 */
	private addModuleToCache = (name: string, path: string): void => {
		//this.debug('adding module', name, 'to cache');
		ProvidesModuleProvider.modules.push(name);
		ProvidesModuleProvider.moduleLookup = {
			...ProvidesModuleProvider.moduleLookup,
			[path]: ProvidesModuleProvider.modules.length - 1,
		};
	}

	/**
	 * Checks whether a module has a @providesModule declaration and if so, returns the module name.
	 * @param file The VSCode URI to the file.
	 * @returns A promise to return the module name or an empty string if there is none.
	 */
	private async getProvidedModule(file: vscode.Uri): Promise<string> {
		const doc = await vscode.workspace.openTextDocument(file);
		// If there is less than 1 line don't bother
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

	/**
	 * Prints debug messages to the debug console with a pretty prefix :D
	 * @param data The data to print to console
	 */
	private debug(...data: any[]): void {
		console.log('[providesModule Sense]:', ...data);
	}
}