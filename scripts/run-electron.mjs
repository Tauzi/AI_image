import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const executable = path.resolve('node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(executable)) {
  console.error(`Electron executable not found: ${executable}`);
  process.exit(1);
}

const electron = spawn(executable, ['.'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

electron.on('error', (error) => {
  console.error('Failed to start Electron:', error);
  process.exit(1);
});

electron.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

const stop = () => {
  if (!electron.killed) electron.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

