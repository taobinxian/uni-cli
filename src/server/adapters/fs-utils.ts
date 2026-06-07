import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonlTail(path: string, limit = 80): Promise<unknown[]> {
  if (!(await exists(path))) return [];
  const content = await readFile(path, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

export async function listFiles(dir: string, suffix = ''): Promise<Array<{ path: string; mtime: Date }>> {
  if (!(await exists(dir))) return [];
  const names = await readdir(dir);
  const files = [];
  for (const name of names) {
    if (suffix && !name.endsWith(suffix)) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isFile()) files.push({ path, mtime: info.mtime });
  }
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function listFilesRecursive(dir: string, suffix = ''): Promise<Array<{ path: string; mtime: Date }>> {
  if (!(await exists(dir))) return [];
  const files: Array<{ path: string; mtime: Date }> = [];

  async function visit(currentDir: string): Promise<void> {
    const names = await readdir(currentDir);
    for (const name of names) {
      const path = join(currentDir, name);
      const info = await stat(path);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile() && (!suffix || name.endsWith(suffix))) {
        files.push({ path, mtime: info.mtime });
      }
    }
  }

  await visit(dir);
  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
