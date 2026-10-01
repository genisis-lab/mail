// Runs the API server (with reload) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env: process.env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => code && stop()));
