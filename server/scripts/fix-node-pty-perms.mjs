import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const helperPath = path.join(
  root,
  'node_modules',
  'node-pty',
  'prebuilds',
  `darwin-${process.arch}`,
  'spawn-helper'
);

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!fs.existsSync(helperPath)) {
  console.log(`[postinstall] node-pty spawn-helper not found at ${helperPath}`);
  process.exit(0);
}

try {
  fs.chmodSync(helperPath, 0o755);
  console.log(`[postinstall] fixed node-pty spawn-helper permissions: ${helperPath}`);
} catch (err) {
  console.warn(`[postinstall] failed to fix node-pty spawn-helper permissions: ${err?.message || err}`);
}
