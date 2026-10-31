import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { openWorkRecords, type WorkKind, type WorkRecords } from './work-records.ts';

const dirs: string[] = [];
const opened: WorkRecords[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-records-dependencies-'));
  dirs.push(dir);
  return dir;
};
const open = async (path = join(tempDir(), 'work-records.db')) => {
  const records = await openWorkRecords(path);
  opened.push(records);
  return records;
};
afterEach(() => {
  for (const records of opened.splice(0)) records.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lar = (records: WorkRecords, kind: WorkKind) => records.create({ title: 'Work', repository: 'maddec01/lar', kind });
const at = (records: WorkRecords, workId: string) => records.read(workId).revision;
const NEED = { need: 'A sign-in endpoint, so the board can log in.', owner: 'acme/auth', ticket: 'acme/auth#5', pullRequests: ['acme/auth#9'], handover: '# Handover\n\nPOST /sign-in.' };

/** A concept owning a Dependency that blocks one of its builds. */
async function blockedBuild() {
  const records = await open();
  const [concept, build] = [lar(records, 'concept'), lar(records, 'build')];
  records.setParent(build.workId, 1, concept.workId);
  const added = records.addDependency(concept.workId, NEED);
  const dependency = records.addDependencyBlock(added.dependencyId, added.revision, build.workId);
  return { records, concept, build, dependency };
}

describe('Dependencies', () => {
  it('keeps a Dependency inside its work record across close and reopen', async () => {
    const path = join(tempDir(), 'work-records.db');
    const records = await openWorkRecords(path);
    const concept = lar(records, 'concept');
    const added = records.addDependency(concept.workId, { ...NEED, contract: 'Returns a session token.', evidence: 'The PR merges.' });
    expect(added).toMatchObject({
      workId: concept.workId, need: NEED.need, owner: 'acme/auth', contract: 'Returns a session token.', evidence: 'The PR merges.',
      ticket: 'acme/auth#5', pullRequests: ['acme/auth#9'], handover: NEED.handover, met: null, needsReview: false, blocks: [],
      replacedBy: null, observations: [], revision: 1,
    });
    expect(records.read(concept.workId).revision).toBe(2);
    records.close();
    const reopened = await open(path);
    expect(reopened.dependency(added.dependencyId)).toEqual(added);
    expect(reopened.dependencies(concept.workId)).toEqual([added]);
  });

  it('updates its fields with the current revision and refuses a stale one', async () => {
    const records = await open();
    const added = records.addDependency(lar(records, 'build').workId, NEED);
    const updated = records.updateDependency(added.dependencyId, 1, { contract: 'Returns a token.', ticket: null, pullRequests: [] });
    expect(updated).toMatchObject({ contract: 'Returns a token.', ticket: null, pullRequests: [], handover: NEED.handover, revision: 2 });
    expect(() => records.updateDependency(added.dependencyId, 1, { need: 'Other' })).toThrow(expect.objectContaining({ code: 'stale-revision' }));
    expect(() => records.updateDependency(added.dependencyId, 2, { pullRequests: ['nope'] })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(records.dependency(added.dependencyId)).toEqual(updated);
  });

  it('blocks only builds in its own work tree, and refuses unknown IDs', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    const [slice, outside, sibling] = [lar(records, 'slice'), lar(records, 'build'), lar(records, 'build')];
    records.setParent(sibling.workId, 1, concept.workId);
    const id = dependency.dependencyId;
    expect(() => records.addDependencyBlock(id, 2, slice.workId)).toThrow('blocks only builds');
    expect(() => records.addDependencyBlock(id, 2, outside.workId)).toThrow('same work tree');
    expect(() => records.addDependencyBlock(id, 2, 'missing')).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => records.addDependencyBlock('missing', 2, sibling.workId)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() => records.addDependency('missing', NEED)).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(records.addDependencyBlock(id, 2, sibling.workId).blocks).toEqual([build.workId, sibling.workId]);
    const own = records.addDependency(outside.workId, NEED);
    records.addDependencyBlock(own.dependencyId, 1, outside.workId);
    expect(() => records.update(outside.workId, at(records, outside.workId), { kind: 'feature' })).toThrow('blocked by the Dependency');
    expect(() => records.clearParent(build.workId, at(records, build.workId))).toThrow('same work tree');
    expect(records.removeDependencyBlock(id, 3, sibling.workId).blocks).toEqual([build.workId]);
    expect(() => records.removeDependencyBlock(id, 4, sibling.workId)).toThrow("doesn't block");
  });

  it('holds its builds until the user marks it met; an external close or merge never does', async () => {
    const { records, build, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    const waiting = [{ dependencyId: id, reasons: ["It isn't marked met."] }];
    expect(records.waitingOn(build.workId)).toEqual(waiting);
    expect(records.observeDependency(id, 2, { subject: 'acme/auth#5', kind: 'closed' }).met).toBeNull();
    expect(records.observeDependency(id, 3, { subject: 'acme/auth#9', kind: 'merged' }).met).toBeNull();
    expect(records.waitingOn(build.workId)).toEqual(waiting);
    records.setPullRequest(build.workId, at(records, build.workId), 'maddec01/lar#1');
    records.observe(build.workId, at(records, build.workId), { of: 'pr', state: 'merged' });
    expect(records.completion(build.workId)).toEqual({ complete: false, reasons: [`Its Dependency ${id} on acme/auth isn't met.`] });

    const met = records.markDependencyMet(id, 4, 'pedro');
    expect(met).toMatchObject({ met: { by: 'pedro', at: expect.any(String) }, needsReview: false, revision: 5 });
    expect(records.waitingOn(build.workId)).toEqual([]);
    expect(records.completion(build.workId).complete).toBe(true);
    expect(records.clearDependencyMet(id, 5).met).toBeNull();
    expect(records.waitingOn(build.workId)).toEqual(waiting);
  });

  it('keeps a met Dependency met when an observation changes, and flags it for review', async () => {
    const { records, build, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    records.observeDependency(id, 2, { subject: 'acme/auth#9', kind: 'merged' });
    records.markDependencyMet(id, 3, 'pedro');
    expect(records.observeDependency(id, 4, { subject: 'acme/auth#9', kind: 'merged' }).needsReview).toBe(false);
    const changed = records.observeDependency(id, 5, { subject: 'acme/auth#9', kind: 'reopened' });
    expect(changed).toMatchObject({ met: { by: 'pedro' }, needsReview: true });
    expect(changed.observations).toEqual([{ subject: 'acme/auth#9', kind: 'reopened', detail: null, observedAt: expect.any(String), lastGood: null }]);
    expect(records.waitingOn(build.workId)).toEqual([]);
    expect(records.markDependencyMet(id, 6, 'pedro')).toMatchObject({ needsReview: false });
  });

  it('leaves a met Dependency unflagged by the first read of a subject, even after a read that failed', async () => {
    const { records, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    records.markDependencyMet(id, 2, 'pedro');
    expect(records.observeDependency(id, 3, { subject: 'acme/auth#5', kind: 'closed' }).needsReview).toBe(false);
    records.observeDependency(id, 4, { subject: 'acme/auth#9', kind: 'read-failed', detail: 'HTTP 502' });
    expect(records.observeDependency(id, 5, { subject: 'acme/auth#9', kind: 'merged' }).needsReview).toBe(false);
  });

  it('keeps the Dependency and its handover through a failed read or lost access, and keeps each kind distinct', async () => {
    const { records, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    records.observeDependency(id, 2, { subject: 'acme/auth#5', kind: 'access-lost', detail: 'HTTP 404' });
    const failed = records.observeDependency(id, 3, { subject: 'acme/auth#9', kind: 'read-failed', detail: 'gh timed out' });
    expect(failed).toMatchObject({ handover: NEED.handover, blocks: dependency.blocks, met: null });
    expect(failed.observations.map(({ subject, kind, detail }) => ({ subject, kind, detail }))).toEqual([
      { subject: 'acme/auth#5', kind: 'access-lost', detail: 'HTTP 404' },
      { subject: 'acme/auth#9', kind: 'read-failed', detail: 'gh timed out' },
    ]);
    expect(records.observeDependency(id, 4, { subject: 'acme/auth#5', kind: 'deleted' }).observations[0]).toMatchObject({ kind: 'deleted', detail: null });
    expect(() => records.observeDependency(id, 5, { subject: 'acme/auth#5', kind: 'gone' as never })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => records.observeDependency(id, 5, { subject: 'acme/other#1', kind: 'open' })).toThrow("isn't the Dependency's ticket or one of its PRs");
  });

  it('keeps the last good read beside a failed one, and leaves a met Dependency unflagged through an outage', async () => {
    const { records, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    const merged = records.observeDependency(id, 2, { subject: 'acme/auth#9', kind: 'merged' }).observations[0]!;
    records.markDependencyMet(id, 3, 'pedro');
    const lastGood = { kind: 'merged', observedAt: merged.observedAt };

    const outage = records.observeDependency(id, 4, { subject: 'acme/auth#9', kind: 'read-failed', detail: 'HTTP 502' });
    expect(outage).toMatchObject({ met: { by: 'pedro' }, needsReview: false });
    expect(outage.observations).toEqual([{ subject: 'acme/auth#9', kind: 'read-failed', detail: 'HTTP 502', observedAt: expect.any(String), lastGood }]);
    expect(records.observeDependency(id, 5, { subject: 'acme/auth#9', kind: 'read-failed', detail: 'HTTP 503' }).observations[0]!.lastGood).toEqual(lastGood);
    const back = records.observeDependency(id, 6, { subject: 'acme/auth#9', kind: 'merged' });
    expect(back).toMatchObject({ met: { by: 'pedro' }, needsReview: false });
    expect(back.observations[0]!.lastGood).toBeNull();

    const lost = records.observeDependency(id, 7, { subject: 'acme/auth#9', kind: 'access-lost', detail: 'HTTP 403' });
    expect(lost).toMatchObject({ met: { by: 'pedro' }, needsReview: true });
    expect(lost.observations[0]!.lastGood).toMatchObject({ kind: 'merged' });
  });

  it('swaps its blocker references on every dependent build for a named build in one transaction', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    const [second, replacement] = [lar(records, 'build'), lar(records, 'build')];
    records.setParent(second.workId, 1, concept.workId);
    const id = dependency.dependencyId;
    records.addDependencyBlock(id, 2, second.workId);
    records.markDependencyMet(id, 3, 'pedro');

    const replaced = records.replaceDependencyWithBuild(id, 4, replacement.workId);
    expect(replaced).toMatchObject({ blocks: [], replacedBy: replacement.workId, met: { by: 'pedro' }, handover: NEED.handover });
    for (const dependent of [build, second]) {
      expect(records.blockers(dependent.workId).map((record) => record.workId)).toEqual([replacement.workId]);
      expect(records.waitingOn(dependent.workId)).toEqual([{ workId: replacement.workId, reasons: ['It has no recorded PR.'] }]);
    }
  });

  it('rolls the whole replacement back when one dependent would close a cycle', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    const [second, replacement] = [lar(records, 'build'), lar(records, 'build')];
    records.setParent(second.workId, 1, concept.workId);
    const id = dependency.dependencyId;
    records.addDependencyBlock(id, 2, second.workId);
    records.addBlocker(replacement.workId, 1, second.workId);
    const before = { dependency: records.dependency(id), build: records.read(build.workId), second: records.read(second.workId) };

    expect(() => records.replaceDependencyWithBuild(id, 3, replacement.workId)).toThrow('cycle');
    expect(() => records.replaceDependencyWithBuild(id, 3, lar(records, 'slice').workId)).toThrow('build');
    expect(records.dependency(id)).toEqual(before.dependency);
    expect(records.read(build.workId)).toEqual(before.build);
    expect(records.read(second.workId)).toEqual(before.second);
    expect(records.blockers(build.workId)).toEqual([]);
  });

  it('survives retention while unmet: a due record holding or blocked by an unmet Dependency is kept', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    records.setAside(build.workId, at(records, build.workId));
    records.setAside(concept.workId, at(records, concept.workId));
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(records.deleteExpired({ hideAfterDays: 7, deleteAfterDays: 30 }, later)).toEqual({ deleted: [], kept: [
      { workId: concept.workId, reason: `It holds the unmet Dependency ${dependency.dependencyId}.` },
      { workId: build.workId, reason: `The unmet Dependency ${dependency.dependencyId} blocks it.` },
    ] });
    expect(records.dependency(dependency.dependencyId)).toMatchObject({ handover: NEED.handover, blocks: [build.workId] });
  });

  it('deletes a met Dependency with its holder, its blocks and its reads', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    records.observeDependency(id, 2, { subject: 'acme/auth#9', kind: 'merged' });
    records.markDependencyMet(id, 3, 'pedro');
    records.setAside(build.workId, at(records, build.workId));
    records.setAside(concept.workId, at(records, concept.workId));
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(records.deleteExpired({ hideAfterDays: 7, deleteAfterDays: 30 }, later)).toEqual({ deleted: [concept.workId, build.workId], kept: [] });
    expect(() => records.dependency(id)).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('keeps a due holder whose met Dependency blocks a kept build, and drops a deleted build from a kept Dependency', async () => {
    const { records, concept, build, dependency } = await blockedBuild();
    const id = dependency.dependencyId;
    const sibling = lar(records, 'build');
    records.setParent(sibling.workId, 1, concept.workId);
    records.addDependencyBlock(id, 2, sibling.workId);
    records.markDependencyMet(id, 3, 'pedro');
    records.setAside(concept.workId, at(records, concept.workId));
    records.setAside(sibling.workId, at(records, sibling.workId));
    const before = at(records, concept.workId);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(records.deleteExpired({ hideAfterDays: 7, deleteAfterDays: 30 }, later)).toEqual({ deleted: [sibling.workId], kept: [
      { workId: concept.workId, reason: `It holds the Dependency ${id}, which blocks the kept build ${build.workId}.` },
    ] });
    expect(records.dependency(id)).toMatchObject({ blocks: [build.workId], revision: 5 });
    expect(at(records, concept.workId)).toBe(before + 1);
  });
});
