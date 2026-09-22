import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Store/cache directory contains a link or special file');
  }
}
export async function readRegularFile(filename: string, maximum: number): Promise<Buffer> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new Error('Expected bounded regular file without links');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size || opened.nlink !== 1) throw new Error('File changed during verification');
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { total += chunk.length; if (total > maximum) throw new Error('File exceeds limit'); chunks.push(Buffer.from(chunk)); }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || total !== opened.size) throw new Error('File changed during verification');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
export async function localArtifactPath(catalogFile: string, relative: string): Promise<string> {
  const directory = await realpath(path.dirname(path.resolve(catalogFile)));
  let current = directory;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Local artifact path contains a link');
  }
  const actual = await realpath(current);
  if (!actual.startsWith(directory + path.sep)) throw new Error('Local artifact escapes explicit catalog directory');
  return actual;
}
