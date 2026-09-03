import net from 'node:net';
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

function isPortInUse() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

if (await isPortInUse()) {
  console.log(`WynAI 已有实例正在监听 ${host}:${port}，本次不重复启动。请直接使用现有开发进程，或先停止旧实例后再运行 npm run dev。`);
  process.exit(0);
}

// Watch runtime inputs as well as imported modules so local configuration and
// Skill JSON changes take effect without changing the development port.
const child = spawn(process.execPath, [
  '--watch',
  '--watch-path=server.mjs',
  '--watch-path=lib',
  '--watch-path=skills',
  '--watch-path=public',
  '--watch-path=.env.local',
  'server.mjs',
], { stdio: 'inherit', env: process.env });
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.once('error', error => { console.error(`无法启动 WynAI：${error.message}`); process.exit(1); });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
