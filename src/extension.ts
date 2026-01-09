import * as vscode from 'vscode';
import { AdonisRoutesDefinitionProvider } from './definitionProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new AdonisRoutesDefinitionProvider();

  // Register for routes/**/*.ts files
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'typescript', pattern: '**/routes/**/*.ts' },
      provider
    )
  );

  // Register for start/routes.ts file
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'typescript', pattern: '**/start/routes.ts' },
      provider
    )
  );
}

export function deactivate() {}