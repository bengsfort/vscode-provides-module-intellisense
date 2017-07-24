'use strict';
import * as vscode from 'vscode';
import ProvidedModuleProvider from './moduleProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('[providesModule-Sense] Active!');
    const provider = new ProvidedModuleProvider();
    provider.activate(context);
}

// this method is called when your extension is deactivated
export function deactivate() {
}