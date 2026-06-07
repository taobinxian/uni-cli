import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppId, TerminalFrame } from '../shared/types.js';
import { EventBus } from './event-bus.js';

interface LaunchInput {
  appId: AppId;
  sessionId: string;
  command: string;
  args: string[];
  cwd?: string;
  pty?: boolean;
  stdin?: 'pipe' | 'ignore';
}

interface RuntimeLaunchInput extends LaunchInput {
  generation: number;
}

export interface LauncherExitInfo {
  appId: AppId;
  sessionId: string;
  reason: 'completed' | 'stopped' | 'failed';
  code?: number | null;
  signal?: string | number | null;
}

interface LiveProcess {
  sessionId: string;
  appId: AppId;
  generation: number;
  write(text: string): void;
  stop(): void;
}

export class LauncherService {
  private live = new Map<string, LiveProcess>();
  private generations = new Map<string, number>();
  private stoppedGenerations = new Set<string>();
  private finishedGenerations = new Set<string>();
  private exitHandlers = new Set<(info: LauncherExitInfo) => void>();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  async launch(input: LaunchInput): Promise<void> {
    if (this.live.has(input.sessionId)) return;
    const generation = (this.generations.get(input.sessionId) ?? 0) + 1;
    this.generations.set(input.sessionId, generation);
    const runtimeInput: RuntimeLaunchInput = { ...input, generation };
    const usePty = input.pty ?? needsScriptPty(input.command);
    if (usePty) {
      const ptyProcess = await this.tryPty(runtimeInput);
      if (ptyProcess) {
        this.live.set(input.sessionId, ptyProcess);
        return;
      }
      if (this.launchPythonPty(runtimeInput)) return;
      if (this.launchScriptPty(runtimeInput)) return;
    }
    this.launchChildProcess(runtimeInput);
  }

  onExit(handler: (info: LauncherExitInfo) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  write(sessionId: string, text: string): boolean {
    const live = this.live.get(sessionId);
    if (!live) return false;
    live.write(text);
    return true;
  }

  stop(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live) return false;
    this.stoppedGenerations.add(generationKey(live.sessionId, live.generation));
    live.stop();
    this.live.delete(sessionId);
    return true;
  }

  private async tryPty(input: RuntimeLaunchInput): Promise<LiveProcess | undefined> {
    try {
      const specifier = 'node-pty';
      const nodePty = await import(specifier);
      const term = nodePty.spawn(input.command, input.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: input.cwd ?? process.cwd(),
        env: terminalEnv()
      });
      term.onData((text: string) => this.emit(input, 'stdout', text));
      term.onExit((event: { exitCode?: number; signal?: string | number }) => this.finish(input, event.exitCode ?? null, event.signal ?? null));
      return {
        sessionId: input.sessionId,
        appId: input.appId,
        generation: input.generation,
        write: (text) => term.write(withTerminalEnter(text)),
        stop: () => term.kill()
      };
    } catch {
      return undefined;
    }
  }

  private launchScriptPty(input: RuntimeLaunchInput): boolean {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/script')) return false;
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', input.command, ...input.args], {
      cwd: input.cwd ?? process.cwd(),
      env: terminalEnv(),
      shell: false
    });
    child.stdout.on('data', (chunk) => {
      const text = cleanScriptPtyOutput(chunk.toString());
      if (text) this.emit(input, 'stdout', text);
    });
    child.stderr.on('data', (chunk) => {
      const text = cleanScriptPtyOutput(chunk.toString());
      if (text) this.emit(input, 'stderr', text);
    });
    child.on('close', (code, signal) => this.finish(input, code, signal));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      generation: input.generation,
      write: (text) => child.stdin?.write(withTerminalEnter(text)),
      stop: () => stopChild(child)
    });
    return true;
  }

  private launchPythonPty(input: RuntimeLaunchInput): boolean {
    const child = spawn(process.env.WORKBENCH_PYTHON ?? 'python3', ['-u', '-c', PYTHON_PTY_BRIDGE, input.command, ...input.args], {
      cwd: input.cwd ?? process.cwd(),
      env: terminalEnv(),
      shell: false
    });
    let started = true;
    child.stdout.on('data', (chunk) => this.emit(input, 'stdout', chunk.toString()));
    child.stderr.on('data', (chunk) => this.emit(input, 'stderr', chunk.toString()));
    child.on('error', (error) => {
      started = false;
      this.emit(input, 'stderr', `pty bridge failed: ${error.message}\n`);
      this.finish(input, 1, null);
    });
    child.on('close', (code, signal) => this.finish(input, code, signal));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      generation: input.generation,
      write: (text) => child.stdin?.write(withTerminalEnter(text)),
      stop: () => stopChild(child)
    });
    return started;
  }

  private launchChildProcess(input: RuntimeLaunchInput): void {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd ?? process.cwd(),
      env: terminalEnv(),
      shell: false,
      stdio: [input.stdin ?? 'pipe', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => this.emit(input, 'stdout', chunk.toString()));
    child.stderr?.on('data', (chunk) => this.emit(input, 'stderr', chunk.toString()));
    child.on('error', (error) => {
      this.emit(input, 'stderr', `process failed: ${error.message}\n`);
      this.finish(input, 1, null);
    });
    child.on('close', (code, signal) => this.finish(input, code, signal));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      generation: input.generation,
      write: (text) => child.stdin?.write(withLineFeed(text)),
      stop: () => stopChild(child)
    });
  }

  private finish(input: RuntimeLaunchInput, code: number | null, signal: string | number | null): void {
    const key = generationKey(input.sessionId, input.generation);
    if (this.finishedGenerations.has(key)) return;
    this.finishedGenerations.add(key);
    const live = this.live.get(input.sessionId);
    if (live?.generation === input.generation) this.live.delete(input.sessionId);
    const stopped = this.stoppedGenerations.delete(key);
    if (this.generations.get(input.sessionId) !== input.generation) return;
    const reason = stopped ? 'stopped' : code === 0 ? 'completed' : 'failed';
    const info: LauncherExitInfo = {
      appId: input.appId,
      sessionId: input.sessionId,
      reason,
      code,
      signal
    };
    for (const handler of this.exitHandlers) handler(info);
  }

  private emit(input: LaunchInput, stream: TerminalFrame['stream'], text: string): void {
    if (isIgnorableTerminalNoise(input.appId, text)) return;
    this.bus.terminal({
      appId: input.appId,
      sessionId: input.sessionId,
      stream,
      text,
      createdAt: new Date().toISOString()
    });
  }
}

function generationKey(sessionId: string, generation: number): string {
  return `${sessionId}:${generation}`;
}

function stopChild(child: ChildProcess): void {
  if (!child.killed) child.kill('SIGTERM');
}

function terminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: process.env.WORKBENCH_TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor'
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  if (process.env.WORKBENCH_FORCE_COLOR) env.FORCE_COLOR = process.env.WORKBENCH_FORCE_COLOR;
  if (process.env.WORKBENCH_NO_COLOR === '1') {
    env.NO_COLOR = '1';
    delete env.FORCE_COLOR;
  }
  return env;
}

function isIgnorableTerminalNoise(appId: string, text: string): boolean {
  const normalized = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;
  if (/NO_COLOR/i.test(normalized) && /FORCE_COLOR/i.test(normalized)) return true;
  if (/warnOnDeactivatedColors|getColorDepth|shouldColorize|internal:util\/colors|loadAssertionError/i.test(normalized)) return true;
  if (/opentui-notifications|Capabilities|Ptmux|\]66;|\]1337;|\]99;|\]10;|\]11;|\]12;/i.test(normalized)) return true;
  if (appId === 'oh-my-pi' && /Connecting to MCP servers|(?:^|\s)omp v\d/i.test(normalized)) return true;
  if (isBlockUiSplash(normalized)) return true;
  return false;
}

function isBlockUiSplash(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return false;
  const blockChars = compact.match(/[▀▄█▌▐▁▂▃▄▅▆▇╘╒╓╔╗╝╚║═│─┌┐└┘|]/g)?.length ?? 0;
  const letters = compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g)?.length ?? 0;
  return blockChars >= 8 && blockChars > compact.length * 0.35 && letters < blockChars;
}

function needsScriptPty(command: string): boolean {
  if (process.env.WORKBENCH_SCRIPT_PTY === '1') return true;
  const name = basename(command).toLowerCase();
  return name === 'codex' || name === 'claude' || name === 'opencode' || name.includes('antigravity') || name.includes('oh-my-pi');
}

function cleanScriptPtyOutput(text: string): string {
  return text
    .replace(/script: tcgetattr\/ioctl: Operation not supported on socket\r?\n?/g, '')
    .replace(/\u0004\b\b/g, '');
}

function withTerminalEnter(text: string): string {
  if (text.endsWith('\r')) return text;
  if (text.endsWith('\n')) return `${text.slice(0, -1)}\r`;
  return `${text}\r`;
}

function withLineFeed(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

const PYTHON_PTY_BRIDGE = String.raw`
import errno
import os
import pty
import select
import signal
import sys

argv = sys.argv[1:]
if not argv:
    sys.exit(2)

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
try:
    os.set_blocking(fd, False)
    os.set_blocking(stdin_fd, False)
except AttributeError:
    pass

def forward_signal(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)

exit_status = 0
while True:
    try:
        ready, _, _ = select.select([fd, stdin_fd], [], [], 0.1)
    except InterruptedError:
        continue

    if fd in ready:
        try:
            data = os.read(fd, 8192)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not data:
            break
        os.write(stdout_fd, data)

    if stdin_fd in ready:
        try:
            data = os.read(stdin_fd, 8192)
        except OSError:
            data = b''
        if data:
            try:
                os.write(fd, data)
            except OSError as exc:
                if exc.errno not in (errno.EIO, errno.EBADF):
                    raise

    try:
        finished_pid, status = os.waitpid(pid, os.WNOHANG)
        if finished_pid == pid:
            if os.WIFEXITED(status):
                exit_status = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                exit_status = 128 + os.WTERMSIG(status)
            break
    except ChildProcessError:
        break

sys.exit(exit_status)
`;
