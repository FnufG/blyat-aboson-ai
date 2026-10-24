import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const filename of ['.env.local', '.local/runtime.env']) {
  if (existsSync(root + filename)) loadEnvFile(root + filename);
}
process.env.LLM_BACKEND ||= 'local';
const mode = process.argv[2] || 'dev';
if (!['dev', 'start'].includes(mode)) throw new Error('Expected dev or start');
const child = spawn(process.execPath, [root + 'node_modules/next/dist/bin/next', mode, '--hostname', process.env.WEB_HOSTNAME || '0.0.0.0', ...process.argv.slice(3)], { cwd: root, env: process.env, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 1));
