import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface RunHandle {
  result: Promise<RunResult>;
  kill: () => void;
}

const TIMEOUT_MS = 10_000;

type LangConfig =
  | { kind: 'spawn'; cmd: string; args: (file: string) => string[]; ext: string }
  | { kind: 'json' }
  | { kind: 'unsupported'; reason: string };

const LANG_MAP: Record<string, LangConfig> = {
  python:     { kind: 'spawn', cmd: 'python3', args: f => [f], ext: '.py' },
  python3:    { kind: 'spawn', cmd: 'python3', args: f => [f], ext: '.py' },
  javascript: { kind: 'spawn', cmd: 'node',    args: f => [f], ext: '.js' },
  typescript: { kind: 'spawn', cmd: 'npx', args: f => ['ts-node', f], ext: '.ts' },
  java:       { kind: 'unsupported', reason: 'Java: run with `javac <file>.java && java <ClassName>`' },
  json:       { kind: 'json' },
  html:       { kind: 'unsupported', reason: 'HTML: open in a browser or use the VS Code Live Preview extension.' },
};

export function startRun(code: string, language: string): RunHandle {
  const config = LANG_MAP[language.toLowerCase()];

  if (!config) {
    return {
      result: Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 1,
        error: `Language "${language}" is not supported for execution in Explainable.`,
      }),
      kill: () => { /* nothing to kill */ },
    };
  }

  if (config.kind === 'unsupported') {
    return {
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0, error: config.reason }),
      kill: () => { /* nothing to kill */ },
    };
  }

  if (config.kind === 'json') {
    return {
      result: (async () => {
        try {
          const pretty = JSON.stringify(JSON.parse(code), null, 2);
          return { stdout: pretty, stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: '', stderr: e instanceof Error ? e.message : 'Invalid JSON', exitCode: 1 };
        }
      })(),
      kill: () => { /* nothing to kill */ },
    };
  }

  return spawnProcess(code, config);
}

export async function runCode(code: string, language: string): Promise<RunResult> {
  return startRun(code, language).result;
}

function spawnProcess(
  code: string,
  config: Extract<LangConfig, { kind: 'spawn' }>
): RunHandle {
  const suffix = randomBytes(8).toString('hex');
  const tmpFile = path.join(os.tmpdir(), `explainable_${suffix}${config.ext}`);

  let activeChild: ChildProcess | null = null;

  const result = new Promise<RunResult>((resolve) => {
    fs.writeFile(tmpFile, code, 'utf8').then(() => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const settle = (r: RunResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      const child = spawn(config.cmd, config.args(tmpFile), {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? '',
        },
      });
      activeChild = child;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
      }, TIMEOUT_MS);

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      }

      child.on('close', async (code) => {
        clearTimeout(timer);
        if (killTimer !== null) { clearTimeout(killTimer); }
        activeChild = null;
        try { await fs.unlink(tmpFile); } catch { /* ignore cleanup errors */ }

        if (timedOut) {
          settle({ stdout, stderr, exitCode: 1, error: `Execution timed out after ${TIMEOUT_MS / 1000}s` });
          return;
        }

        settle({ stdout, stderr, exitCode: code ?? 0 });
      });

      child.on('error', async (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (killTimer !== null) { clearTimeout(killTimer); }
        activeChild = null;
        try { await fs.unlink(tmpFile); } catch { /* ignore */ }

        if (err.code === 'ENOENT' && config.cmd === 'python3') {
          const handle = spawnProcess(code, { ...config, cmd: 'python' });
          handle.result.then(settle).catch(() => { /* settled via error */ });
          return;
        }

        settle({
          stdout: '',
          stderr: '',
          exitCode: 1,
          error: `Could not start "${config.cmd}": ${err.message}. Is it installed and on your PATH?`,
        });
      });
    }).catch((e: unknown) => {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: 1,
        error: `Could not write temp file: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  });

  return {
    result,
    kill: () => {
      if (activeChild) {
        activeChild.kill('SIGTERM');
        setTimeout(() => { activeChild?.kill('SIGKILL'); }, 500);
      }
    },
  };
}
