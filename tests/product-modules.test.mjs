import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMessage, enrollAgent, listEnrollments, scanTarget, verifyEnrolledAgent, previewDedupe, applyDedupe } from '../packages/cli/dist/agents/onboarding.js';
import { createDraft, listDrafts, validateDraft, publishDraft, removeDraft } from '../packages/cli/dist/authoring.js';
import { listProfiles, saveProfile, getProfile, removeProfile } from '../packages/cli/dist/profiles.js';
import { addMcp, listMcp, diagnoseMcp, setMcpEnabled, removeMcp } from '../packages/cli/dist/mcp/manager.js';
import { uninstallSkillShelf } from '../packages/cli/dist/commands/maintenance.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { storePath } from '../packages/cli/dist/store/state.js';
import { chmodTree } from '../packages/cli/dist/store/local.js';
import { cp } from 'node:fs/promises';

async function fixture(t) {
  const root = await mkdtemp(join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-product-'));
  t.after(async () => {
    try { await lstat(join(root, 'data')); await chmodTree(join(root, 'data'), false); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, ctx: { home: join(root, 'data'), offline: true } };
}

test('connect enrollment is idempotent and verification records evidence', async t => {
  const { root, ctx } = await fixture(t), skills = join(root, 'agent', 'skills');
  await mkdir(join(skills, 'hello'), { recursive: true });
  await writeFile(join(skills, 'hello', 'SKILL.md'), '---\nname: hello\ndescription: test\n---\n# hello\n');
  const message = connectMessage('opencode');
  assert.equal(message.protocol, 'skillshelf-connect/v1');
  const first = await enrollAgent(ctx, 'custom', { path: skills, label: 'Test Agent' });
  const second = await enrollAgent(ctx, 'custom', { path: skills, label: 'Changed Label' });
  assert.equal(first.enrollment.targetId, second.enrollment.targetId);
  assert.equal(second.idempotent, true);
  const targetId = first.enrollment.targetId;
  const inventory = await scanTarget((await loadState(ctx)).targets[targetId]);
  assert.equal(inventory.length, 1);
  const verified = await verifyEnrolledAgent(ctx, targetId);
  assert.equal(verified.status, 'reload-required');
  assert.ok((await listEnrollments(ctx)).agents.length === 1);
});

test('local authoring creates, validates, publishes and removes a complete pack draft', async t => {
  const { ctx } = await fixture(t);
  const created = await createDraft(ctx, 'local-design', { members: [{ id: 'one', description: 'one' }, { id: 'two', description: 'two' }] });
  assert.equal(created.members.length, 2);
  assert.equal((await validateDraft(ctx, 'local-design')).valid, true);
  const published = await publishDraft(ctx, 'local-design', { version: '0.1.0-local.1', yes: true });
  assert.equal(published.id, 'local-design');
  assert.equal((await listDrafts(ctx)).drafts.length, 1);
  assert.equal((await removeDraft(ctx, 'local-design')).removed, true);
});

test('dedupe preview matches a complete member tree and replaces it through a shared projection', async t => {
  const { root, ctx } = await fixture(t), draftRoot = join(ctx.home, 'drafts', 'shared-pack');
  await createDraft(ctx, 'shared-pack');
  await publishDraft(ctx, 'shared-pack', { version: '0.1.0-local.1', yes: true });
  const state = await loadState(ctx), release = state.releases[state.selections['shared-pack'].releaseKey];
  const skills = join(root, 'agent', 'skills'); await mkdir(skills, { recursive: true });
  await cp(join(storePath(ctx, release.contentDigest), release.manifest.members[0].path), join(skills, 'shared-pack'), { recursive: true });
  const enrolled = await enrollAgent(ctx, 'custom', { path: skills });
  const targetId = enrolled.target.id;
  const preview = await previewDedupe(ctx, targetId);
  assert.equal(preview.duplicates.length, 1);
  const applied = await applyDedupe(ctx, targetId, { yes: true });
  assert.equal(applied.replaced.length, 1);
  assert.equal((await previewDedupe(ctx, targetId)).duplicates.length, 0);
});

test('profiles persist local task combinations without duplicating content', async t => {
  const { ctx } = await fixture(t);
  await saveProfile(ctx, { id: 'frontend', name: '前端开发', packs: ['taste'], members: { taste: ['image-to-code'] }, mcps: ['docs'] });
  assert.equal((await getProfile(ctx, 'frontend')).packs[0], 'taste');
  assert.equal((await listProfiles(ctx)).profiles.length, 1);
  assert.equal((await removeProfile(ctx, 'frontend')).removed, true);
});

test('MCP definitions are centralized, redacted and diagnosed without network calls', async t => {
  const { ctx } = await fixture(t);
  await addMcp(ctx, { id: 'docs', transport: 'stdio', command: 'docs-mcp', env: { token: 'DOCS_TOKEN' } });
  const listed = await listMcp(ctx);
  assert.equal(listed.definitions[0].env.token, '<env-ref>');
  const diagnosed = await diagnoseMcp(ctx, 'docs');
  assert.equal(diagnosed.networkRequested, false);
  assert.equal(diagnosed.results[0].status, 'ready');
  await setMcpEnabled(ctx, 'docs', false);
  assert.equal((await diagnoseMcp(ctx, 'docs')).results[0].status, 'disabled');
  assert.equal((await removeMcp(ctx, 'docs')).removed, true);
});

test('uninstall preview never removes data without explicit confirmation', async t => {
  const { ctx } = await fixture(t);
  const preview = await uninstallSkillShelf(ctx, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal((await listProfiles(ctx)).profiles.length, 0);
});
