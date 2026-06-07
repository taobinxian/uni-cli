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

interface LiveProcess {
  sessionId: string;
  appId: AppId;
  write(text: string): void;
  stop(): void;
}

export class LauncherService {
  private live = new Map<string, LiveProcess>();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  async launch(input: LaunchInput): Promise<void> {
    if (this.live.has(input.sessionId)) return;
    const usePty = input.pty ?? needsScriptPty(input.command);
    if (usePty) {
      const ptyProcess = await this.tryPty(input);
      if (ptyProcess) {
        this.live.set(input.sessionId, ptyProcess);
        return;
      }
      if (this.launchPythonPty(input)) return;
      if (this.launchScriptPty(input)) return;
    }
    this.launchChildProcess(input);
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
    live.stop();
    this.live.delete(sessionId);
    return true;
  }

  private async tryPty(input: LaunchInput): Promise<LiveProcess | undefined> {
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
      term.onExit(() => this.live.delete(input.sessionId));
      return {
        sessionId: input.sessionId,
        appId: input.appId,
        write: (text) => term.write(withTerminalEnter(text)),
        stop: () => term.kill()
      };
    } catch {
      return undefined;
    }
  }

  private launchScriptPty(input: LaunchInput): boolean {
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
    child.on('close', () => this.live.delete(input.sessionId));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      write: (text) => child.stdin?.write(withTerminalEnter(text)),
      stop: () => stopChild(child)
    });
    return true;
  }

  private launchPythonPty(input: LaunchInput): boolean {
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
      this.live.delete(input.sessionId);
    });
    child.on('close', () => this.live.delete(input.sessionId));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      write: (text) => child.stdin?.write(withTerminalEnter(text)),
      stop: () => stopChild(child)
    });
    return started;
  }

  private launchChildProcess(input: LaunchInput): void {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd ?? process.cwd(),
      env: terminalEnv(),
      shell: false,
      stdio: [input.stdin ?? 'pipe', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => this.emit(input, 'stdout', chunk.toString()));
    child.stderr?.on('data', (chunk) => this.emit(input, 'stderr', chunk.toString()));
    child.on('error', (error) => this.emit(input, 'stderr', `process failed: ${error.message}\n`));
    child.on('close', () => this.live.delete(input.sessionId));
    this.live.set(input.sessionId, {
      sessionId: input.sessionId,
      appId: input.appId,
      write: (text) => child.stdin?.write(withLineFeed(text)),
      stop: () => stopChild(child)
    });
  }

  private emit(input: LaunchInput, stream: TerminalFrame['stream'], text: string): void {
    this.bus.terminal({
      appId: input.appId,
      sessionId: input.sessionId,
      stream,
      text,
      createdAt: new Date().toISOString()
    });
  }
}

function stopChild(child: ChildProcess): void {
  if (!child.killed) child.kill('SIGTERM');
}

function terminalEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: process.env.WORKBENCH_TERM ?? 'xterm-256color',
    COLORTERM: process.env.COLORTERM ?? 'truecolor',
    FORCE_COLOR: process.env.FORCE_COLOR ?? '1'
  };
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
