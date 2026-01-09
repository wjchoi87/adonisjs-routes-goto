import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export class AdonisRoutesDefinitionProvider implements vscode.DefinitionProvider {
  private importsCache = new Map<string, any>();
  private cacheTimestamps = new Map<string, number>();

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
    try {
      const filePath = document.fileName;
      const offset = document.offsetAt(position);
      const sourceFile = ts.createSourceFile(
        filePath,
        document.getText(),
        ts.ScriptTarget.Latest,
        true
      );

      const node = this.findNodeAtPosition(sourceFile, offset);
      if (!node) return null;

      // Check if we're in a supported file pattern
      if (!this.isSupportedFile(filePath)) return null;

      const projectRoot = this.findProjectRoot(filePath);
      if (!projectRoot) return null;

      // Determine what was clicked
      const clickContext = this.analyzeClickContext(node, sourceFile);
      if (!clickContext) return null;

      return this.resolveDefinition(clickContext, projectRoot, sourceFile);
    } catch (error) {
      console.error('AdonisJS Routes Goto Error:', error);
      return null;
    }
  }

  private isSupportedFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    return normalizedPath.includes(path.sep + 'routes' + path.sep) ||
           normalizedPath.endsWith(path.sep + 'start' + path.sep + 'routes.ts');
  }

  private findProjectRoot(filePath: string): string | null {
    let currentDir = path.dirname(filePath);
    while (currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    return null;
  }

  private findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | null {
    function find(node: ts.Node): ts.Node | null {
      if (position >= node.getStart() && position <= node.getEnd()) {
        for (const child of node.getChildren()) {
          const found = find(child);
          if (found) return found;
        }
        return node;
      }
      return null;
    }
    return find(sourceFile);
  }

  private analyzeClickContext(node: ts.Node, sourceFile: ts.SourceFile): ClickContext | null {
    // Check if it's an identifier
    if (ts.isIdentifier(node)) {
      return this.analyzeIdentifierClick(node, sourceFile);
    }

    // Check if it's a string literal
    if (ts.isStringLiteral(node)) {
      return this.analyzeStringLiteralClick(node, sourceFile);
    }

    return null;
  }

  private analyzeIdentifierClick(node: ts.Identifier, sourceFile: ts.SourceFile): ClickContext | null {
    // Check if this identifier is part of a router call handler
    const routerCall = this.findRouterCall(node);
    if (routerCall) {
      const handler = this.extractHandlerFromRouterCall(routerCall);
      if (handler && handler.type === 'controller') {
        return {
          type: 'controller_identifier',
          controllerName: handler.controllerName,
          methodName: handler.methodName
        };
      }
    }

    // Check if this is a routes module identifier in group
    const routesGroup = this.findRoutesGroupCall(node);
    if (routesGroup) {
      return {
        type: 'routes_module',
        moduleName: node.text
      };
    }

    return null;
  }

  private analyzeStringLiteralClick(node: ts.StringLiteral, sourceFile: ts.SourceFile): ClickContext | null {
    // Check if this string is a method name in [Controller, 'method'] tuple
    const tupleContext = this.isMethodStringInTuple(node);
    if (tupleContext) {
      return {
        type: 'method_string',
        controllerName: tupleContext.controllerName,
        methodName: node.text
      };
    }

    // Check if this string is a #controllers import path
    if (node.text.startsWith('#controllers/')) {
      return {
        type: 'controller_import_path',
        importPath: node.text
      };
    }

    return null;
  }

  private findRouterCall(node: ts.Node): ts.CallExpression | null {
    let current: ts.Node = node;
    while (current) {
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
        const methodName = current.expression.name.text;
        if (['get', 'post', 'put', 'patch', 'delete', 'route', 'resource', 'group'].includes(methodName)) {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private extractHandlerFromRouterCall(call: ts.CallExpression): HandlerInfo | null {
    // Handle method calls like router.get('/path', handler)
    if (call.arguments.length >= 2) {
      const handlerArg = call.arguments[1];
      return this.parseHandlerArgument(handlerArg);
    }

    // Handle chained calls - look for the original call
    let currentCall = call;
    while (currentCall.parent && ts.isCallExpression(currentCall.parent)) {
      currentCall = currentCall.parent;
      if (currentCall.arguments.length >= 2) {
        const handlerArg = currentCall.arguments[1];
        return this.parseHandlerArgument(handlerArg);
      }
    }

    return null;
  }

  private parseHandlerArgument(arg: ts.Expression): HandlerInfo | null {
    // Array literal [Controller, 'method']
    if (ts.isArrayLiteralExpression(arg) && arg.elements.length === 2) {
      const controllerExpr = arg.elements[0];
      const methodExpr = arg.elements[1];

      if (ts.isIdentifier(controllerExpr) && ts.isStringLiteral(methodExpr)) {
        return {
          type: 'controller',
          controllerName: controllerExpr.text,
          methodName: methodExpr.text
        };
      }
    }

    // Arrow function or function expression - skip
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return null;
    }

    // Identifier - could be a controller variable
    if (ts.isIdentifier(arg)) {
      // This might be a controller factory variable
      return {
        type: 'controller_variable',
        variableName: arg.text
      };
    }

    return null;
  }

  private isMethodStringInTuple(node: ts.StringLiteral): { controllerName: string } | null {
    let current: ts.Node = node;
    while (current) {
      if (ts.isArrayLiteralExpression(current) && current.elements.length === 2) {
        const index = current.elements.indexOf(node as ts.Expression);
        if (index === 1) { // Second element in [Controller, 'method']
          const controllerExpr = current.elements[0];
          if (ts.isIdentifier(controllerExpr)) {
            return { controllerName: controllerExpr.text };
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  private findRoutesGroupCall(node: ts.Node): ts.CallExpression | null {
    let current: ts.Node = node;
    while (current) {
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
        if (current.expression.name.text === 'group') {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private resolveDefinition(context: ClickContext, projectRoot: string, sourceFile: ts.SourceFile): vscode.Location | null {
    switch (context.type) {
      case 'controller_identifier':
        if (!context.controllerName) return null;
        return this.resolveControllerDefinition(context.controllerName, context.methodName, projectRoot);

      case 'method_string':
        if (!context.controllerName) return null;
        return this.resolveControllerDefinition(context.controllerName, context.methodName, projectRoot);

      case 'controller_import_path':
        if (!context.importPath) return null;
        return this.resolveControllerFromImportPath(context.importPath, projectRoot);

      case 'routes_module':
        if (!context.moduleName) return null;
        return this.resolveRoutesModule(context.moduleName, projectRoot, sourceFile);

      default:
        return null;
    }
  }

  private resolveControllerDefinition(controllerName: string, methodName: string | undefined, projectRoot: string): vscode.Location | null {
    const controllerPath = this.resolveControllerPath(controllerName, projectRoot);
    if (!controllerPath) return null;

    const controllerUri = vscode.Uri.file(controllerPath);
    const controllerDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === controllerPath);

    if (!controllerDocument) return new vscode.Location(controllerUri, new vscode.Position(0, 0));

    if (!methodName) {
      return new vscode.Location(controllerUri, new vscode.Position(0, 0));
    }

    // Find method definition
    const methodLocation = this.findMethodInController(controllerDocument, methodName);
    return methodLocation || new vscode.Location(controllerUri, new vscode.Position(0, 0));
  }

  private resolveControllerPath(controllerName: string, projectRoot: string): string | null {
    const imports = this.getPackageImports(projectRoot);
    const controllersMapping = imports['#controllers/*'];
    if (!controllersMapping) return null;

    const basePath = path.resolve(projectRoot, controllersMapping.replace('/*', ''));
    const possiblePaths = [
      path.join(basePath, `${controllerName}.ts`),
      path.join(basePath, `${controllerName}.js`),
      path.join(basePath, controllerName, 'index.ts'),
      path.join(basePath, controllerName, 'index.js')
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  private getPackageImports(projectRoot: string): any {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const stat = fs.statSync(packageJsonPath);
    const cacheKey = packageJsonPath;

    if (this.cacheTimestamps.get(cacheKey) !== stat.mtime.getTime()) {
      try {
        const content = fs.readFileSync(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(content);
        this.importsCache.set(cacheKey, packageJson.imports || {});
        this.cacheTimestamps.set(cacheKey, stat.mtime.getTime());
      } catch (error) {
        this.importsCache.set(cacheKey, {});
      }
    }

    return this.importsCache.get(cacheKey) || {};
  }

  private findMethodInController(document: vscode.TextDocument, methodName: string): vscode.Location | null {
    const sourceFile = ts.createSourceFile(
      document.fileName,
      document.getText(),
      ts.ScriptTarget.Latest,
      true
    );

    const candidates: { node: ts.MethodDeclaration | ts.FunctionDeclaration, priority: number }[] = [];

    function visit(node: ts.Node) {
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === methodName) {
        let priority = 2; // Default priority

        // Check if it's in export default class
        let parent: ts.Node = node.parent;
        while (parent) {
          if (ts.isClassDeclaration(parent) && parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) &&
              parent.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
            priority = 1; // Highest priority
            break;
          }
          if (ts.isClassDeclaration(parent)) {
            priority = 2; // Other class
            break;
          }
          parent = parent.parent;
        }

        candidates.push({ node, priority });
      }

      if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === methodName &&
          node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        candidates.push({ node, priority: 3 }); // Exported function
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    if (candidates.length === 0) return null;

    // Sort by priority (lower number = higher priority)
    candidates.sort((a, b) => a.priority - b.priority);

    const bestMatch = candidates[0];
    if (!bestMatch.node.name) return null;
    const position = document.positionAt(bestMatch.node.name.getStart());
    return new vscode.Location(document.uri, position);
  }

  private resolveControllerFromImportPath(importPath: string, projectRoot: string): vscode.Location | null {
    const imports = this.getPackageImports(projectRoot);
    const mapping = imports[importPath];
    if (!mapping) return null;

    const resolvedPath = path.resolve(projectRoot, mapping);
    const possiblePaths = [
      resolvedPath.replace('.js', '.ts'),
      resolvedPath,
      resolvedPath.replace(/\.ts$/, '/index.ts'),
      resolvedPath.replace(/\.js$/, '/index.js')
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return new vscode.Location(vscode.Uri.file(p), new vscode.Position(0, 0));
      }
    }

    return null;
  }

  private resolveRoutesModule(moduleName: string, projectRoot: string, sourceFile: ts.SourceFile): vscode.Location | null {
    // First check if it's imported
    const imports = this.getPackageImports(projectRoot);
    const routesMapping = imports['#routes/*'];
    if (routesMapping) {
      const basePath = path.resolve(projectRoot, routesMapping.replace('/*', ''));
      const possiblePaths = [
        path.join(basePath, `${moduleName}.ts`),
        path.join(basePath, `${moduleName}.js`)
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return new vscode.Location(vscode.Uri.file(p), new vscode.Position(0, 0));
        }
      }
    }

    // Check local file
    const currentDir = path.dirname(sourceFile.fileName);
    const localPath = path.join(currentDir, `${moduleName}.ts`);
    if (fs.existsSync(localPath)) {
      return new vscode.Location(vscode.Uri.file(localPath), new vscode.Position(0, 0));
    }

    return null;
  }
}

interface ClickContext {
  type: 'controller_identifier' | 'method_string' | 'controller_import_path' | 'routes_module';
  controllerName?: string;
  methodName?: string;
  importPath?: string;
  moduleName?: string;
}

interface HandlerInfo {
  type: 'controller' | 'controller_variable';
  controllerName?: string;
  variableName?: string;
  methodName?: string;
}