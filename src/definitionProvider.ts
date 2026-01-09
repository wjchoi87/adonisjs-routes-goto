import * as vscode from "vscode";
import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";

export class AdonisRoutesDefinitionProvider
  implements vscode.DefinitionProvider
{
  private importsCache = new Map<string, any>();
  private cacheTimestamps = new Map<string, number>();

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
    try {
      console.log(
        "provideDefinition called for file:",
        document.fileName,
        "position:",
        position
      );

      const filePath = document.fileName;
      const offset = document.offsetAt(position);
      const sourceFile = ts.createSourceFile(
        filePath,
        document.getText(),
        ts.ScriptTarget.Latest,
        true
      );

      const node = this.findNodeAtPosition(sourceFile, offset);
      console.log("Node at position:", node?.kind, node?.getText());
      if (!node) {
        console.log("No node found at position");
        return null;
      }

      // Check if we're in a supported file pattern
      if (!this.isSupportedFile(filePath)) {
        console.log("File not supported:", filePath);
        return null;
      }
      console.log("File supported, checking project root...");

      const projectRoot = this.findProjectRoot(filePath);
      console.log("Project root found:", projectRoot);
      if (!projectRoot) {
        console.log("No project root found");
        return null;
      }

      const clickContext = this.analyzeClickContext(node, sourceFile);
      console.log("Click context analyzed:", clickContext);
      if (!clickContext) {
        console.log("No click context found");
        return null;
      }

      console.log("Resolving definition...");
      const resolved = this.resolveDefinition(
        clickContext,
        projectRoot,
        sourceFile
      );

      // When clicking controller variables, TypeScript's built-in definition provider will also return
      // the variable declaration. Return a LocationLink with an originSelectionRange to help VS Code
      // prioritize our more meaningful target.
      if (resolved && clickContext.type === "controller_variable") {
        const originSelectionRange = this.getNodeRange(
          document,
          sourceFile,
          node
        );
        return [
          {
            originSelectionRange,
            targetUri: resolved.uri,
            targetRange: resolved.range,
            targetSelectionRange: resolved.range,
          },
        ];
      }

      return resolved;
    } catch (error) {
      console.error("AdonisJS Routes Goto Error:", error);
      return null;
    }
  }

  private getNodeRange(
    document: vscode.TextDocument,
    sourceFile: ts.SourceFile,
    node: ts.Node
  ): vscode.Range {
    const start = document.positionAt(node.getStart(sourceFile));
    const end = document.positionAt(node.getEnd());
    return new vscode.Range(start, end);
  }

  private isSupportedFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    return (
      normalizedPath.includes(path.sep + "routes" + path.sep) ||
      normalizedPath.endsWith(path.sep + "start" + path.sep + "routes.ts")
    );
  }

  private findProjectRoot(filePath: string): string | null {
    let currentDir = path.dirname(filePath);
    while (currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    return null;
  }

  private findNodeAtPosition(
    sourceFile: ts.SourceFile,
    position: number
  ): ts.Node | null {
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

  private analyzeClickContext(
    node: ts.Node,
    sourceFile: ts.SourceFile
  ): ClickContext | null {
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

  private analyzeIdentifierClick(
    node: ts.Identifier,
    sourceFile: ts.SourceFile
  ): ClickContext | null {
    // Check if this identifier is part of a router call handler
    const routerCall = this.findRouterCall(node);
    if (routerCall) {
      const handler = this.extractHandlerFromRouterCall(routerCall);
      if (handler) {
        if (handler.type === "controller_variable" && handler.variableName) {
          return {
            type: "controller_variable",
            variableName: handler.variableName,
          };
        }

        // Note: handler.type === 'controller' is handled primarily via clicking the method string.
        // If clicking the first element in a tuple handler: [ControllerVar, 'method']
        // Prefer resolving ControllerVar to the imported controller file (not the variable declaration).
        if (
          ts.isArrayLiteralExpression(node.parent) &&
          node.parent.elements.length === 2 &&
          node.parent.elements[0] === node &&
          ts.isStringLiteral(node.parent.elements[1])
        ) {
          return {
            type: "controller_variable",
            variableName: node.text,
          };
        }
      }
    }

    // Check if this is a routes module identifier in group
    const routesGroup = this.findRoutesGroupCall(node);
    if (routesGroup) {
      return {
        type: "routes_module",
        moduleName: node.text,
      };
    }

    return null;
  }

  private analyzeStringLiteralClick(
    node: ts.StringLiteral,
    sourceFile: ts.SourceFile
  ): ClickContext | null {
    // Check if this string is a method name in [Controller, 'method'] tuple
    const tupleContext = this.isMethodStringInTuple(node);
    if (tupleContext) {
      return {
        type: "method_string",
        controllerName: tupleContext.controllerName,
        methodName: node.text,
      };
    }

    // Check if this string is a #controllers import path
    if (node.text.startsWith("#controllers/")) {
      return {
        type: "controller_import_path",
        importPath: node.text,
      };
    }

    return null;
  }

  private findRouterCall(node: ts.Node): ts.CallExpression | null {
    let current: ts.Node = node;
    while (current) {
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const methodName = current.expression.name.text;
        if (
          [
            "get",
            "post",
            "put",
            "patch",
            "delete",
            "route",
            "resource",
            "group",
          ].includes(methodName)
        ) {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private extractHandlerFromRouterCall(
    call: ts.CallExpression
  ): HandlerInfo | null {
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
          type: "controller",
          controllerName: controllerExpr.text,
          methodName: methodExpr.text,
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
        type: "controller_variable",
        variableName: arg.text,
      };
    }

    return null;
  }

  private isMethodStringInTuple(
    node: ts.StringLiteral
  ): { controllerName: string } | null {
    let current: ts.Node = node;
    while (current) {
      if (
        ts.isArrayLiteralExpression(current) &&
        current.elements.length === 2
      ) {
        const index = current.elements.indexOf(node as ts.Expression);
        if (index === 1) {
          // Second element in [Controller, 'method']
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
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        if (current.expression.name.text === "group") {
          return current;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private resolveDefinition(
    context: ClickContext,
    projectRoot: string,
    sourceFile: ts.SourceFile
  ): vscode.Location | null {
    console.log("Resolving definition for context:", context);

    switch (context.type) {
      case "controller_variable":
        if (!context.variableName) {
          console.log("No variable name for controller variable");
          return null;
        }
        console.log("Resolving controller variable definition...");
        return this.resolveControllerVariableDefinition(
          context.variableName,
          context.methodName,
          projectRoot,
          sourceFile
        );

      case "method_string":
        if (!context.controllerName) {
          console.log("No controller name for method string");
          return null;
        }
        console.log("Resolving method string definition...");
        return this.resolveControllerDefinition(
          context.controllerName,
          context.methodName,
          projectRoot
        );

      case "controller_import_path":
        if (!context.importPath) {
          console.log("No import path");
          return null;
        }
        console.log("Resolving controller import path...");
        return this.resolveControllerFromImportPath(
          context.importPath,
          projectRoot
        );

      case "routes_module":
        if (!context.moduleName) {
          console.log("No module name");
          return null;
        }
        console.log("Resolving routes module...");
        return this.resolveRoutesModule(
          context.moduleName,
          projectRoot,
          sourceFile
        );

      default:
        console.log("Unknown context type:", context.type);
        return null;
    }
  }

  private resolveControllerVariableDefinition(
    variableName: string,
    methodName: string | undefined,
    projectRoot: string,
    sourceFile: ts.SourceFile
  ): vscode.Location | null {
    console.log(
      `Resolving controller variable: ${variableName}, method: ${methodName}`
    );

    // Find the variable declaration in the source file
    const importPath = this.findControllerImportPath(variableName, sourceFile);
    console.log("Import path found:", importPath);

    if (!importPath) {
      console.log("No import path found for variable");
      return null;
    }

    // Resolve the import path to actual file path
    const location = this.resolveControllerFromImportPath(
      importPath,
      projectRoot
    );
    if (!location) {
      console.log("Controller path not found");
      return null;
    }

    // Extract file path from location
    const controllerPath = location.uri.fsPath;
    const controllerDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === controllerPath
    );
    console.log("Controller document found:", !!controllerDocument);

    if (!methodName) {
      console.log(
        "No method name specified, returning controller file location"
      );
      return new vscode.Location(location.uri, new vscode.Position(0, 0));
    }

    // Find method definition (works even if the controller file isn't already open)
    console.log("Finding method in controller...");
    const methodLocation = controllerDocument
      ? this.findMethodInController(controllerDocument, methodName)
      : this.findMethodInControllerFile(controllerPath, methodName);
    console.log("Method location found:", !!methodLocation);

    return (
      methodLocation ||
      new vscode.Location(location.uri, new vscode.Position(0, 0))
    );
  }

  private resolveControllerDefinition(
    controllerName: string,
    methodName: string | undefined,
    projectRoot: string
  ): vscode.Location | null {
    console.log(
      `Resolving controller: ${controllerName}, method: ${methodName}, root: ${projectRoot}`
    );

    const controllerPath = this.resolveControllerPath(
      controllerName,
      projectRoot
    );
    console.log("Controller path resolved to:", controllerPath);

    if (!controllerPath) {
      console.log("Controller path not found");
      return null;
    }

    const controllerUri = vscode.Uri.file(controllerPath);

    if (!methodName) {
      console.log(
        "No method name specified, returning controller file location"
      );
      return new vscode.Location(controllerUri, new vscode.Position(0, 0));
    }

    console.log("Finding method in controller...");
    const methodLocation = this.findMethodInControllerFile(
      controllerPath,
      methodName
    );
    console.log("Method location found:", !!methodLocation);

    return (
      methodLocation ||
      new vscode.Location(controllerUri, new vscode.Position(0, 0))
    );
  }

  private resolveControllerPath(
    controllerName: string,
    projectRoot: string
  ): string | null {
    console.log(`Resolving controller path for: ${controllerName}`);

    const imports = this.getPackageImports(projectRoot);
    console.log("Package imports:", imports);

    const controllersMapping = imports["#controllers/*"];
    console.log("Controllers mapping:", controllersMapping);

    if (!controllersMapping) {
      console.log("No #controllers/* mapping found");
      return null;
    }

    // The import map often points to "./app/controllers/*.js" even though the source is ".ts".
    // Use the mapping's directory as the base path.
    const basePath = path.resolve(
      projectRoot,
      path.dirname(String(controllersMapping))
    );
    console.log("Base path:", basePath);

    // Convert PascalCase to snake_case (e.g., BannerController -> banner_controller)
    const snakeCaseName = controllerName
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
    console.log("Converted to snake_case:", snakeCaseName);

    const possiblePaths = [
      path.join(basePath, `${snakeCaseName}.ts`),
      path.join(basePath, `${snakeCaseName}.js`),
      path.join(basePath, controllerName, "index.ts"),
      path.join(basePath, controllerName, "index.js"),
      // Also try PascalCase just in case
      path.join(basePath, `${controllerName}.ts`),
      path.join(basePath, `${controllerName}.js`),
    ];

    console.log("Possible paths:", possiblePaths);

    for (const p of possiblePaths) {
      console.log(`Checking path: ${p}, exists: ${fs.existsSync(p)}`);
      if (fs.existsSync(p)) {
        console.log("Found controller file:", p);
        return p;
      }
    }

    console.log("No controller file found");
    return null;
  }

  private getPackageImports(projectRoot: string): any {
    const packageJsonPath = path.join(projectRoot, "package.json");
    const stat = fs.statSync(packageJsonPath);
    const cacheKey = packageJsonPath;

    if (this.cacheTimestamps.get(cacheKey) !== stat.mtime.getTime()) {
      try {
        const content = fs.readFileSync(packageJsonPath, "utf8");
        const packageJson = JSON.parse(content);
        this.importsCache.set(cacheKey, packageJson.imports || {});
        this.cacheTimestamps.set(cacheKey, stat.mtime.getTime());
      } catch (error) {
        this.importsCache.set(cacheKey, {});
      }
    }

    return this.importsCache.get(cacheKey) || {};
  }

  private findMethodInController(
    document: vscode.TextDocument,
    methodName: string
  ): vscode.Location | null {
    const sourceFile = ts.createSourceFile(
      document.fileName,
      document.getText(),
      ts.ScriptTarget.Latest,
      true
    );

    const candidates: {
      node: ts.MethodDeclaration | ts.FunctionDeclaration;
      priority: number;
    }[] = [];

    function visit(node: ts.Node) {
      if (
        ts.isMethodDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName
      ) {
        let priority = 2; // Default priority

        // Check if it's in export default class
        let parent: ts.Node = node.parent;
        while (parent) {
          if (
            ts.isClassDeclaration(parent) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword
            ) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.DefaultKeyword
            )
          ) {
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

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
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
    const start = document.positionAt(bestMatch.node.name.getStart(sourceFile));
    const end = document.positionAt(bestMatch.node.name.getEnd());
    return new vscode.Location(document.uri, new vscode.Range(start, end));
  }

  private findMethodInControllerFile(
    controllerPath: string,
    methodName: string
  ): vscode.Location | null {
    try {
      const text = fs.readFileSync(controllerPath, "utf8");
      const sourceFile = ts.createSourceFile(
        controllerPath,
        text,
        ts.ScriptTarget.Latest,
        true
      );

      const best = this.findBestMethodNameNode(sourceFile, methodName);
      if (!best) return null;

      const startLc = ts.getLineAndCharacterOfPosition(
        sourceFile,
        best.getStart(sourceFile)
      );
      const endLc = ts.getLineAndCharacterOfPosition(sourceFile, best.getEnd());
      const start = new vscode.Position(startLc.line, startLc.character);
      const end = new vscode.Position(endLc.line, endLc.character);

      return new vscode.Location(
        vscode.Uri.file(controllerPath),
        new vscode.Range(start, end)
      );
    } catch (error) {
      console.error(
        "Failed to find method in controller file:",
        controllerPath,
        error
      );
      return null;
    }
  }

  private findBestMethodNameNode(
    sourceFile: ts.SourceFile,
    methodName: string
  ): ts.Identifier | null {
    const candidates: { node: ts.Identifier; priority: number }[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isMethodDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName
      ) {
        let priority = 2;

        let parent: ts.Node = node.parent;
        while (parent) {
          if (
            ts.isClassDeclaration(parent) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ExportKeyword
            ) &&
            parent.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.DefaultKeyword
            )
          ) {
            priority = 1;
            break;
          }
          if (ts.isClassDeclaration(parent)) {
            priority = 2;
            break;
          }
          parent = parent.parent;
        }

        candidates.push({ node: node.name, priority });
      }

      if (
        ts.isPropertyDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName
      ) {
        candidates.push({ node: node.name, priority: 2 });
      }

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === methodName &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        candidates.push({ node: node.name, priority: 3 });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0].node;
  }

  private resolveControllerFromImportPath(
    importPath: string,
    projectRoot: string
  ): vscode.Location | null {
    const imports = this.getPackageImports(projectRoot);
    const mapping = imports[importPath];

    // 1) Exact mapping in package.json imports
    if (mapping) {
      const resolvedPath = path.resolve(projectRoot, mapping);
      const possiblePaths = [
        resolvedPath.replace(".js", ".ts"),
        resolvedPath,
        resolvedPath.replace(/\.ts$/, "/index.ts"),
        resolvedPath.replace(/\.js$/, "/index.js"),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0)
          );
        }
      }

      return null;
    }

    // 2) Wildcard mapping like "#controllers/*": "./app/controllers/*.js"
    if (importPath.startsWith("#controllers/")) {
      const controllersMapping = imports["#controllers/*"];
      if (!controllersMapping) return null;
      const controllerModule = importPath.substring("#controllers/".length);

      const mappingPattern = String(controllersMapping);

      // If mapping contains a "*" pattern (e.g. ./app/controllers/*.js), replace it with the module.
      if (mappingPattern.includes("*")) {
        const mapped = mappingPattern.replace("*", controllerModule);
        const resolvedPath = path.resolve(projectRoot, mapped);
        const candidates = [
          resolvedPath.replace(".js", ".ts"),
          resolvedPath,
          resolvedPath.replace(/\.ts$/, "/index.ts"),
          resolvedPath.replace(/\.js$/, "/index.js"),
        ];

        for (const p of candidates) {
          if (fs.existsSync(p)) {
            return new vscode.Location(
              vscode.Uri.file(p),
              new vscode.Position(0, 0)
            );
          }
        }

        return null;
      }

      // Fallback: treat the mapping as a directory-ish base
      const basePath = path.resolve(projectRoot, path.dirname(mappingPattern));
      const candidates = [
        path.join(basePath, `${controllerModule}.ts`),
        path.join(basePath, `${controllerModule}.js`),
        path.join(basePath, controllerModule, "index.ts"),
        path.join(basePath, controllerModule, "index.js"),
      ];

      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0)
          );
        }
      }
    }

    return null;
  }

  private findControllerImportPath(
    variableName: string,
    sourceFile: ts.SourceFile
  ): string | null {
    function visit(node: ts.Node): string | null {
      // Look for variable declarations
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === variableName
      ) {
        if (node.initializer) {
          // Handle arrow function: () => import('#controllers/...')
          if (ts.isArrowFunction(node.initializer) && node.initializer.body) {
            const body = node.initializer.body;
            if (
              ts.isCallExpression(body) &&
              body.expression.kind === ts.SyntaxKind.ImportKeyword
            ) {
              const args = body.arguments;
              if (args.length > 0 && ts.isStringLiteral(args[0])) {
                return args[0].text;
              }
            }
          }
          // Handle direct import: import('#controllers/...')
          else if (
            ts.isCallExpression(node.initializer) &&
            node.initializer.expression.kind === ts.SyntaxKind.ImportKeyword
          ) {
            const args = node.initializer.arguments;
            if (args.length > 0 && ts.isStringLiteral(args[0])) {
              return args[0].text;
            }
          }
        }
      }

      // Continue searching
      return ts.forEachChild(node, visit) || null;
    }

    return visit(sourceFile);
  }

  private resolveRoutesModule(
    moduleName: string,
    projectRoot: string,
    sourceFile: ts.SourceFile
  ): vscode.Location | null {
    // First check if it's imported
    const imports = this.getPackageImports(projectRoot);
    const routesMapping = imports["#routes/*"];
    if (routesMapping) {
      const basePath = path.resolve(
        projectRoot,
        routesMapping.replace("/*", "")
      );
      const possiblePaths = [
        path.join(basePath, `${moduleName}.ts`),
        path.join(basePath, `${moduleName}.js`),
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          return new vscode.Location(
            vscode.Uri.file(p),
            new vscode.Position(0, 0)
          );
        }
      }
    }

    // Check local file
    const currentDir = path.dirname(sourceFile.fileName);
    const localPath = path.join(currentDir, `${moduleName}.ts`);
    if (fs.existsSync(localPath)) {
      return new vscode.Location(
        vscode.Uri.file(localPath),
        new vscode.Position(0, 0)
      );
    }

    return null;
  }
}

interface ClickContext {
  type:
    | "controller_variable"
    | "method_string"
    | "controller_import_path"
    | "routes_module";
  variableName?: string;
  controllerName?: string;
  methodName?: string;
  importPath?: string;
  moduleName?: string;
}

interface HandlerInfo {
  type: "controller" | "controller_variable";
  controllerName?: string;
  variableName?: string;
  methodName?: string;
}
