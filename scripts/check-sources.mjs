// Read-only maintenance source check. Reports the pinned status of every
// reviewed repository using injected evidence only: it never follows
// branches, never mutates the catalog, never installs content, never
// publishes, and reports "unknown" when no candidate evidence is supplied.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, root } from './lib.mjs';
import { expandSourceConfig } from './prepare-catalog.mjs';

/** Pure check: classify each pinned tuple against optional candidate evidence. */
export async function checkSources(config, { evidence = null } = {}) {
  if (!config?.v3) throw new Error('check-sources requires the v0.3 source config');
  const expanded = expandSourceConfig(config);
  const tuples = new Map();
  for (const member of expanded.members) {
    for (const tuple of [member.acquisition, ...(member.acquisition.overlays ?? [])]) {
      const key = `${tuple.repository}@${tuple.commit}`;
      if (!tuples.has(key)) tuples.set(key, { repository: tuple.repository, commit: tuple.commit });
    }
  }
  const rows = [];
  for (const tuple of tuples.values()) {
    const candidate = evidence ? findCandidate(evidence, tuple) : null;
    const status = candidate ? (candidate.matches ? 'verified' : 'changed') : 'unknown';
    rows.push({
      repository: tuple.repository,
      commit: tuple.commit,
      status,
      checked: candidate !== null,
      detail: candidate ? (candidate.matches ? 'candidate evidence matches the pinned commit and manifest' : 'candidate evidence differs from the reviewed manifest') : 'no candidate evidence supplied',
    });
  }
  return { rows: rows.sort((a, b) => (a.repository < b.repository ? -1 : 1)), wrote: false };
}

function findCandidate(evidence, tuple) {
  if (!Array.isArray(evidence)) return null;
  const hit = evidence.find((row) => row && row.repository === tuple.repository && row.commit === tuple.commit);
  return hit ? { matches: hit.matches === true } : null;
}

// CLI entry: print the read-only report; never write anything.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { argumentsFor } = await import('./lib.mjs');
  const options = argumentsFor(process.argv.slice(2), {});
  const config = await json(path.join(root, 'catalog/sources.json'));
  const report = await checkSources(config, {});
  for (const row of report.rows) {
    console.log(`${row.status.padEnd(8)} ${row.repository}@${row.commit.slice(0, 12)}… ${row.detail}`);
  }
  console.log(`Checked ${report.rows.length} pinned tuples. Read-only: no catalog, install, or publication was performed.`);
}
