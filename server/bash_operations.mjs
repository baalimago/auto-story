import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.mjs';
import { terminateChild } from './terminate_child.mjs';

const BASH = process.env.BASH_BIN || ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(p => existsSync(p)) || 'bash';

// WASIX supports child processes but not detached process groups.
const DEFAULT_TIMEOUT_SECONDS = 120;

// Every command sources agent/tools/shell.sh first: Node stand-ins for grep and rg, plain errors for
// python and friends, and a fix for `node --input-type=module` heredocs, which Edge.js cannot read.
const SHELL_RC = `${config.agentDir}/tools/shell.sh`;
const shellEnv = env => ({ ...(env || process.env), ...(existsSync(SHELL_RC) ? { BASH_ENV: SHELL_RC, AUTO_STORY_TOOLS: `${config.agentDir}/tools` } : {}) });

export function createBashOperations(onTimeout = () => {}) {
  return {
    exec(command, cwd, { onData, signal, timeout = DEFAULT_TIMEOUT_SECONDS, env }) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Bash command aborted'));
        const child = spawn(BASH, ['-c', command], {
          cwd, env: shellEnv(env), detached: false, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let failure;
        const stop = (message, timedOut = false) => {
          if (failure) return;
          failure = new Error(message);
          cleanup();
          try { terminateChild(child); }
          finally {
            reject(failure);
            if (timedOut) onTimeout(failure);
          }
        };
        const abort = () => stop('Bash command aborted');
        signal?.addEventListener('abort', abort, { once: true });
        const timer = timeout ? setTimeout(() => stop(`Command timed out after ${timeout} seconds`, true), timeout * 1000) : undefined;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', exitCode => {
          cleanup();
          if (failure) reject(failure);
          else resolve({ exitCode });
        });
      });
    },
  };
}

export const bashOperations = createBashOperations();
