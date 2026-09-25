import assert from 'node:assert/strict';
import test from 'node:test';
import * as scripts from '../scripts/lib.mjs';

// v0.3 publication planning: exactly two public packages (metadata-only catalog
// + CLI). The legacy 0.2.x skill-count plan stays available untouched.
const { integrityFor, modules, publicationEntry, publicationPlan } = scripts;
const publicationPlanV3 = scripts.publicationPlanV3;

const api = await modules();
const version = api.CLI_VERSION;
const catalogBytes = Buffer.from('catalog fixture');
const cliBytes = Buffer.from('cli fixture');
const catalogEntry = (bytes = catalogBytes, file = `catalog-${version}.tgz`) => publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-catalog`, version, file, bytes, api);
const cliEntry = (bytes = cliBytes, file = `skillshelf-${version}.tgz`) => publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf`, version, file, bytes, api);
const skillPackEntry = (index) => publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-pack-pack${index}`, version, `pack-${index}.tgz`, Buffer.from('pack'), api);

test('v0.3 publication plan carries exactly the catalog and CLI packages', () => {
  assert.equal(typeof publicationPlanV3, 'function', 'v0.3 must expose a two-package publication plan');
  const plan = publicationPlanV3([catalogEntry(), cliEntry()], api, { catalogRevision: 1 });
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.published, false);
  assert.equal(plan.complete, true);
  assert.equal(plan.version, version);
  assert.equal(plan.tag, api.RELEASE_CHANNEL);
  assert.equal(plan.access, 'public');
  assert.equal(plan.scope, api.ALLOWED_SCOPE);
  assert.equal(plan.repository, api.REPOSITORY_URL);
  assert.equal(plan.catalogRevision, 1);
  assert.deepEqual(plan.packages.map((row) => row.name), [`${api.ALLOWED_SCOPE}/skillshelf-catalog`, `${api.ALLOWED_SCOPE}/skillshelf`]);
  for (const row of plan.packages) {
    assert.equal(row.version, version);
    assert.equal(row.tag, api.RELEASE_CHANNEL);
    assert.match(row.integrity, /^sha512-/u);
  }
});

test('v0.3 catalog revisions are independent of the CLI version', () => {
  const first = publicationPlanV3([catalogEntry(), cliEntry()], api, { catalogRevision: 1 });
  const second = publicationPlanV3([catalogEntry(), cliEntry()], api, { catalogRevision: 2 });
  assert.equal(first.version, second.version);
  assert.notEqual(first.catalogRevision, second.catalogRevision);
  assert.throws(() => publicationPlanV3([catalogEntry(), cliEntry()], api, { catalogRevision: 0 }));
  assert.throws(() => publicationPlanV3([catalogEntry(), cliEntry()], api, {}));
  assert.throws(() => publicationPlanV3([catalogEntry(), cliEntry()], api, { catalogRevision: '1' }));
});

test('v0.3 plan rejects skill packs, mixed entries, wrong order and duplicates', () => {
  assert.throws(() => publicationPlanV3([catalogEntry()], api, { catalogRevision: 1 }), /exactly/);
  assert.throws(() => publicationPlanV3([cliEntry()], api, { catalogRevision: 1 }), /exactly/);
  assert.throws(() => publicationPlanV3([catalogEntry(), cliEntry(), skillPackEntry(1)], api, { catalogRevision: 1 }), /exactly|skill/u);
  assert.throws(() => publicationPlanV3([cliEntry(), catalogEntry()], api, { catalogRevision: 1 }), /catalog/u);
  assert.throws(() => publicationPlanV3([catalogEntry(), catalogEntry(Buffer.from('x'), `catalog-${version}-2.tgz`)], api, { catalogRevision: 1 }), /unique|CLI|catalog/u);
  assert.throws(() => publicationPlanV3([catalogEntry(), catalogEntry()], api, { catalogRevision: 1 }), /unique|CLI|catalog/u);
  const malformed = { ...cliEntry(), integrity: 'sha512-not-base64-of-right-length!!!' };
  assert.throws(() => publicationPlanV3([catalogEntry(), malformed], api, { catalogRevision: 1 }));
  assert.throws(() => publicationPlanV3([catalogEntry(), { ...cliEntry(), version: 'not-a-version' }], api, { catalogRevision: 1 }));
});

test('legacy 0.2.x publication plan keeps its explicit skill-count semantics', () => {
  const packs = [1, 2, 3].map((index) => skillPackEntry(index));
  const partial = publicationPlan([...packs, catalogEntry()], api, 3);
  assert.equal(partial.schemaVersion, 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.packages.length, 4);
  assert.ok(partial.packages.some((row) => row.name === `${api.ALLOWED_SCOPE}/skillshelf-catalog`));
  const complete = publicationPlan([...packs, catalogEntry(), cliEntry()], api, 3, true);
  assert.equal(complete.complete, true);
  assert.equal(complete.packages.length, 5);
  assert.throws(() => publicationPlan(packs, api, 3, true), /count|CLI/u);
  assert.throws(() => publicationPlan(packs, api, 3, false), /count|skill/u);
  assert.throws(() => publicationPlan([...packs, skillPackEntry(4), catalogEntry()], api, 3, false), /count|skill/u);
  assert.throws(() => publicationPlan([...packs.slice(0, 2), catalogEntry()], api, 3, false), /count|skill/u);
});
