#!/bin/bash
set -e

# Create directory structure
mkdir -p src/{client,avatar,base,types,utils,html}
mkdir -p scripts
mkdir -p deploy

# package.json
cat > package.json << 'EOF'
{
  "name": "@metaversalcorp/persona-login",
  "version": "0.1.0",
  "description": "Persona authentication and session management client",
  "type": "module",
  "main": "deploy/app.js",
  "scripts": {
    "build": "node scripts/build.js",
    "dev": "node scripts/dev-server.js",
    "typecheck": "tsc --noEmit",
    "serve": "http-server ./deploy -p 8080 --cors -c-1",
    "clean": "rm -rf deploy/*.js deploy/*.map"
  },
  "author": "Metaversal Corporation",
  "license": "UNLICENSED",
  "private": true,
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.3.2"
  },
  "optionalDependencies": {
    "http-server": "^14.1.1",
    "chokidar": "^3.5.3"
  }
}
EOF

# tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "moduleResolution": "node",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./deploy",
    "baseUrl": "./src",
    "paths": {
      "@/*": ["./*"]
    },
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "deploy"]
}
EOF

# .gitignore
cat > .gitignore << 'EOF'
node_modules/
package-lock.json
yarn.lock
deploy/
dist/
build/
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store
.env.local
.env.*.local
npm-debug.log*
yarn-debug.log*
EOF

# LICENSE
cat > LICENSE << 'EOF'
Copyright 2025 Metaversal Corporation

UNLICENSED - Private Repository

This code and all associated documentation are proprietary and confidential.
Unauthorized copying or distribution is prohibited.
EOF

# README.md
cat > README.md << 'EOF'
# PersonaLogin

Minimal but fully functional Persona authentication and session management client for RP1.

## Features

- Real MV library integration
- TypeScript with strict type safety
- Minimal dependencies (esbuild, TypeScript)
- Development server with hot reload
- Bootstrap 5 UI
- Complete transaction logging

## Quick Start

```bash
npm install
npm run dev
