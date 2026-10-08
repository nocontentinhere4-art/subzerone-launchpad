// Local development: the web server and one worker in two child processes, restarted together.
import { spawn } from 'node:child_process';
const run = (file) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { stdio: 'inherit' });
const kids = [run(new URL('./server.js', import.meta.url).pathname), run(new URL('./worker.js', import.meta.url).pathname)];
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { kids.forEach((k) => k.kill(s)); process.exit(0); });
