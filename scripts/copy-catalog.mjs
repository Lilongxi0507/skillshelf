import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { json, modules, root } from './lib.mjs';

const { validatePublicCatalog, canonicalJson } = await modules();
const catalog = validatePublicCatalog(await json(path.join(root, 'catalog/bootstrap.json')));
const destination = path.join(root, 'packages/cli/dist/catalog');
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, 'bootstrap.json'), canonicalJson(catalog) + '\n');
await chmod(path.join(root,'packages/cli/dist/index.js'),0o755);
console.log(`Copied metadata-only bootstrap (${catalog.skills.length} entries); no skill content or localArtifact fields included.`);
