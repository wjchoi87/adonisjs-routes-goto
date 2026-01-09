import * as vscode from 'vscode';
import { AdonisRoutesDefinitionProvider } from './definitionProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('AdonisJS Routes Goto extension activated!');

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

  console.log('Definition providers registered for routes files');
}

export function deactivate() {}