import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmodTree } from '../packages/cli/dist/store/local.js';
import { digestManifest, inventory } from '../packages/cli/dist/validation.js';
import { makeTarball } from '../scripts/lib.mjs';

const archive = process.env.SKILLSHELF_TEST_CLI_ARCHIVE;
import { legacyCatalogFixture } from './legacy-fixture.mjs';
const catalog = await legacyCatalogFixture(process.env.SKILLSHELF_TEST_CATALOG);
const base = process.env.SKILLSHELF_TEST_TMP ?? tmpdir();
const ready = Boolean(archive && catalog && process.env.npm_execpath);

function completed(result, operation) {
  assert.equal(result.error, undefined, `${operation}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${operation}: killed after ${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, `${operation}: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function installedCommand(bin, args, root) {
  const env = { ...process.env, NO_COLOR: '1' };
  if (process.platform !== 'win32') {
    return spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, env, cwd: root });
  }
  // PowerShell invokes npm's real .cmd shim. Arguments are passed as JSON in
  // the environment so fixture paths never become PowerShell source text.
  const powershell = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $cliArgs = @(ConvertFrom-Json -InputObject $env:SKILLSHELF_TEST_ARGS); & $env:SKILLSHELF_TEST_BIN @cliArgs; exit $LASTEXITCODE';
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60_000, cwd: root,
    env: { ...env, SKILLSHELF_TEST_BIN: bin, SKILLSHELF_TEST_ARGS: JSON.stringify(args) },
  });
}

async function nextCatalog(root, currentPath) {
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const old = current.skills.find(entry => entry.id === 'brandkit');
  assert.ok(old);
  const version = '0.3.0';
  const source = path.join(root, 'new-brandkit');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: brandkit\ndescription: Installed CLI update fixture\n---\n# Updated brandkit\n');
  await writeFile(path.join(source, 'LICENSE'), 'MIT\n');
  const files = await inventory(source);
  const runtime = { kind: 'instructions', requiresNetwork: false };
  const contentDigest = digestManifest(files);
  const manifest = { schemaVersion: 1, id: 'brandkit', name: 'brandkit', files, contentDigest, runtime };
  const bytes = makeTarball([
    { path: 'package/package.json', data: JSON.stringify({ name: old.packageName, version, license: 'MIT', files: ['skill/', 'skillshelf.manifest.json', 'LICENSE'] }) },
    { path: 'package/skillshelf.manifest.json', data: JSON.stringify(manifest) },
    { path: 'package/LICENSE', data: 'MIT\n' },
    ...await Promise.all(files.map(async file => ({ path: 'package/skill/' + file.path, data: await readFile(path.join(source, file.path)), executable: file.executable }))),
  ]);
  const artifact = `brandkit-${version}.tgz`;
  await writeFile(path.join(root, artifact), bytes);
  const entry = {
    ...old, version, runtime, contentDigest,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    fileCount: files.length, unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
    localArtifact: artifact,
  };
  const updated = path.join(root, 'updated-catalog.json');
  await writeFile(updated, JSON.stringify({ ...current, catalogVersion: version, skills: current.skills.map(item => item.id === 'brandkit' ? entry : item) }));
  return updated;
}

test('actual packed CLI installs into a private prefix and its native command installs one complete skill', { skip: ready ? false : 'Set CLI archive, development catalog and npm executable for installed CLI test', timeout: 180_000 }, async t => {
  assert.ok(path.isAbsolute(archive));
  assert.ok(path.isAbsolute(catalog));
  assert.ok(path.isAbsolute(process.env.npm_execpath));
  const root = await mkdtemp(path.join(base, 'skillshelf-installed-'));
  const home = path.join(root, 'home');
  t.after(async () => {
    try { await lstat(home); await chmodTree(home, false); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, 'prefix');
  const installed = spawnSync(process.execPath, [process.env.npm_execpath, 'install', '--global', archive, '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {
    encoding: 'utf8', timeout: 120_000, cwd: root,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  completed(installed, 'npm install of actual CLI tarball');
  const bin = process.platform === 'win32' ? path.join(prefix, 'skillshelf.cmd') : path.join(prefix, 'bin', 'skillshelf');
  const binInfo = await lstat(bin);
  assert.ok(binInfo.isFile() || binInfo.isSymbolicLink(), 'npm created a native command entry');

  assert.equal(completed(installedCommand(bin, ['--version'], root), 'installed --version'), JSON.parse(await readFile(catalog, 'utf8')).catalogVersion);
  const options = ['--home', home, '--catalog', catalog, '--offline', '--json'];
  const list = JSON.parse(completed(installedCommand(bin, [...options, 'list'], root), 'installed list'));
  assert.equal(list.status, 'ok');
  assert.equal(list.data.skills.length, JSON.parse(await readFile(catalog, 'utf8')).skills.length);
  const install = JSON.parse(completed(installedCommand(bin, [...options, 'install', 'brandkit', '--yes'], root), 'installed on-demand install'));
  assert.equal(install.status, 'ok');
  assert.equal((await readdir(path.join(home, 'artifacts'))).length, 1, 'one selected skill fetches one archive');

  const agentRoot = path.join(root, 'managed-agent', 'skills');
  const agent = JSON.parse(completed(installedCommand(bin, [...options, 'agents', 'add', 'custom', '--path', agentRoot, '--mode', 'copy', '--yes'], root), 'registered Agent target'));
  assert.equal(agent.status, 'ok');
  assert.equal(agent.data.target.path, agentRoot);
  const targetId = agent.data.target.id;
  completed(installedCommand(bin, [...options, 'enable', 'brandkit', '--agent', targetId, '--yes'], root), 'managed Agent projection');
  const projected = path.join(agentRoot, 'brandkit');
  const projectedInfo = await lstat(projected);
  assert.ok(projectedInfo.isDirectory() && !projectedInfo.isSymbolicLink(), 'the installed command wrote a managed copy');
  assert.ok((await readFile(path.join(projected, 'SKILL.md'), 'utf8')).includes('brandkit'));

  const project = path.join(root, 'project');
  await mkdir(project);
  const projectInstall = JSON.parse(completed(installedCommand(bin, [...options, 'install', 'brandkit', '--project', project, '--agent', 'codex', '--yes'], root), 'installed project lock and native target'));
  const lockPath = path.join(project, 'skillshelf-lock.json');
  const lockBefore = await readFile(lockPath, 'utf8');
  assert.equal(JSON.parse(lockBefore).skills[0].id, 'brandkit');
  const projectSkill = path.join(project, '.agents', 'skills', 'brandkit');
  const projectProjection = projectInstall.data.projections.find(item =>
    process.platform === 'win32' ? item.path.toLowerCase() === projectSkill.toLowerCase() : item.path === projectSkill);
  assert.ok(projectProjection, 'the installed command records its native project target');
  assert.ok(['link', 'copy'].includes(projectProjection.mode), 'auto chose a supported projection mode');
  const projectInfo = await lstat(projectSkill);
  assert.equal(projectInfo.isSymbolicLink(), projectProjection.mode === 'link');
  assert.ok((await readFile(path.join(projectSkill, 'SKILL.md'), 'utf8')).includes('brandkit'));
  completed(installedCommand(bin, [...options, 'sync', '--frozen', '--project', project, '--yes'], root), 'frozen project restore');
  assert.equal(await readFile(lockPath, 'utf8'), lockBefore, 'frozen sync preserves the exact project lock');

  const updatedCatalog = await nextCatalog(root, catalog);
  const updatedOptions = ['--home', home, '--catalog', updatedCatalog, '--offline', '--json'];
  completed(installedCommand(bin, [...updatedOptions, 'update', 'brandkit', '--yes'], root), 'installed CLI update');
  let status = JSON.parse(completed(installedCommand(bin, [...updatedOptions, 'status'], root), 'status after update')).data;
  assert.equal(status.installed.find(item => item.id === 'brandkit').version, '0.3.0');
  assert.ok((await readFile(path.join(projected, 'SKILL.md'), 'utf8')).includes('Updated brandkit'));
  completed(installedCommand(bin, [...updatedOptions, 'rollback', 'brandkit', '--yes'], root), 'installed CLI rollback');
  status = JSON.parse(completed(installedCommand(bin, [...updatedOptions, 'status'], root), 'status after rollback')).data;
  assert.equal(status.installed.find(item => item.id === 'brandkit').version, JSON.parse(await readFile(catalog, 'utf8')).catalogVersion);
  assert.equal(await readFile(lockPath, 'utf8'), lockBefore, 'global update and rollback leave project lock unchanged');
  const verified = JSON.parse(completed(installedCommand(bin, [...options, 'verify'], root), 'installed verify'));
  assert.equal(verified.status, 'ok');
  assert.equal(verified.data.ok, true);
});
