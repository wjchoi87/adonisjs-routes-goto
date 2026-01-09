# AdonisJS Routes Goto

A VS Code extension that provides "Go to Definition" support for AdonisJS v6 routes.

## Features

This extension enables Ctrl/Cmd+Click navigation in AdonisJS route files to jump to controller definitions and methods.

### Supported Files

- `**/routes/**/*.ts` - All TypeScript files in routes directories
- `**/start/routes.ts` - The main routes file

### Supported Click Targets

1. **Controller Identifiers**: Click on controller names in route handlers
   ```typescript
   router.get('/users', [UserController, 'index'])  // Click on UserController
   ```

2. **Method Strings**: Click on method names in route tuples
   ```typescript
   router.get('/users', [UserController, 'index'])  // Click on 'index'
   ```

3. **Controller Import Paths**: Click on #controllers import paths
   ```typescript
   const UserController = () => import('#controllers/user_controller')  // Click on '#controllers/user_controller'
   ```

## How It Works

- Only works within the current project's root (determined by finding the nearest `package.json`)
- Uses the `package.json#imports` mapping to resolve `#controllers/*` paths
- Supports controller factory declarations and route module imports
- Prioritizes TypeScript source files over compiled JavaScript

## Requirements

- VS Code 1.74.0 or later
- AdonisJS v6 project with TypeScript
- Properly configured `package.json#imports` for `#controllers/*` mapping

## Installation

1. Download and install the extension
2. Open an AdonisJS v6 project
3. In route files, use Ctrl/Cmd+Click on supported elements

## Limitations

- Only supports `#controllers/*` import alias (other aliases like `@controllers` are not supported)
- Does not add any UI elements or commands - purely enhances the existing "Go to Definition" functionality
- Only works within the current project's root directory