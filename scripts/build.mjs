import { rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  mainFields: ['module', 'main'],
  alias: {
    'react-devtools-core': path.resolve('stubs/react-devtools-core.js'),
  },
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __pocketCreateRequire } from "node:module";\n' +
      'const require = __pocketCreateRequire(import.meta.url);',
  },
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

console.log('BUILD_OK dist/cli.js');
