import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

interface ResolveCommandInput {
  envVar: string;
  names: string[];
  candidates?: string[];
}

export async function resolveCommand(input: ResolveCommandInput): Promise<string | undefined> {
  const explicit = process.env[input.envVar]?.trim();
  if (explicit) return findExecutableCommand(explicit);

  const candidates = uniqueStrings([
    ...(input.candidates ?? []),
    ...input.names,
    ...(await commonCommandCandidates(input.names))
  ]);
  for (const candidate of candidates) {
    const resolved = await findExecutableCommand(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

export async function requireCommand(input: ResolveCommandInput, label: string): Promise<string> {
  const command = await resolveCommand(input);
  if (!command) throw new Error(`${label} CLI is not configured`);
  return command;
}

export async function executableCommand(command: string): Promise<boolean> {
  return Boolean(await findExecutableCommand(command));
}

async function findExecutableCommand(command: string): Promise<string | undefined> {
  if (!command.trim()) return undefined;
  if (command.includes('/')) return (await executablePath(command)) ? command : undefined;
  for (const dir of executableSearchDirs()) {
    const path = join(dir, command);
    if (await executablePath(path)) return path;
  }
  return undefined;
}

async function commonCommandCandidates(names: string[]): Promise<string[]> {
  const dirs = uniqueStrings([
    ...executableSearchDirs(),
    ...await globBinDirs(join(homedir(), '.nvm', 'versions', 'node')),
    ...await globBinDirs(join(homedir(), '.fnm', 'node-versions'), 'installation/bin'),
    ...await globBinDirs(join(homedir(), '.asdf', 'installs', 'nodejs')),
    ...await globBinDirs(join(homedir(), '.local', 'share', 'mise', 'installs', 'node'))
  ]);
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)));
}

function executableSearchDirs(): string[] {
  return uniqueStrings([
    ...splitPath(process.env.PATH),
    process.env.HOMEBREW_PREFIX ? join(process.env.HOMEBREW_PREFIX, 'bin') : undefined,
    process.env.NVM_BIN,
    process.env.PNPM_HOME,
    process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, 'bin') : undefined,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : undefined,
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin') : undefined,
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'),
    join(homedir(), '.bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), '.cargo', 'bin'),
    join(homedir(), '.asdf', 'shims'),
    join(homedir(), '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]);
}

async function globBinDirs(root: string, nestedBin = 'bin'): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionDir = join(root, entry.name);
    const binDir = join(versionDir, nestedBin);
    if ((await pathExists(binDir)) && basename(binDir) === 'bin') result.push(binDir);
  }
  return result;
}

async function executablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPath(pathValue?: string): string[] {
  return pathValue?.split(delimiter).filter(Boolean) ?? [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}
