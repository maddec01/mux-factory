import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { exportMarkdown } from './export.ts';
import { openWorkRecords, type WorkKind, type WorkRecords } from './work-records.ts';

// A filesystem without hard links, such as exFAT, refuses linkSync with this code.
const unlinkable = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  const linkSync: typeof fs.linkSync = (existing, path) => {
    if (unlinkable.code) throw Object.assign(new Error(`${unlinkable.code}: operation not supported, link`), { code: unlinkable.code });
    fs.linkSync(existing, path);
  };
  return { ...fs, linkSync };
});

const dirs: string[] = [];
const opened: WorkRecords[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-records-export-'));
  dirs.push(dir);
  return dir;
};
const open = async () => {
  const records = await openWorkRecords(join(tempDir(), 'work-records.db'));
  opened.push(records);
  return records;
};
afterEach(() => {
  unlinkable.code = null;
  for (const records of opened.splice(0)) records.close();
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
const lar = (records: WorkRecords, kind: WorkKind) => records.create({ title: 'Work', repository: 'maddec01/lar', kind });

describe('markdown export', () => {
  it("writes a concept's map and its decisions with safe names for titles holding slashes and dots", async () => {
    const records = await open();
    const [concept, first, second] = [lar(records, 'concept'), lar(records, 'decision'), lar(records, 'decision')];
    records.setBody(concept.workId, 1, 'map', '# Work records / storage\n\nThe map.\n');
    records.setBody(first.workId, 1, 'decision', '# ../../etc/passwd v1.2\n\nUse SQLite.\n');
    records.setBody(second.workId, 1, 'decision', 'No heading here.\n');
    records.setParent(first.workId, 2, concept.workId);
    records.setParent(second.workId, 2, concept.workId);
    const to = tempDir();

    const written = exportMarkdown(records, concept.workId, to);
    expect(written).toEqual([join(to, 'map-work-records-storage.md'), join(to, 'decision-etc-passwd-v1-2.md'), join(to, `decision-${second.workId}.md`)]);
    expect(readdirSync(to).toSorted()).toEqual(written.map((path) => path.slice(to.length + 1)).toSorted());
    expect(readFileSync(join(to, 'decision-etc-passwd-v1-2.md'), 'utf8')).toBe('# ../../etc/passwd v1.2\n\nUse SQLite.\n');
  });

  it("writes a build's brief and tells apart two bodies with the same title", async () => {
    const records = await open();
    const [concept, first, second] = [lar(records, 'concept'), lar(records, 'decision'), lar(records, 'decision')];
    for (const decision of [first, second]) {
      records.setBody(decision.workId, 1, 'decision', '# Same.');
      records.setParent(decision.workId, 2, concept.workId);
    }
    const build = lar(records, 'build');
    records.setBody(build.workId, 1, 'brief', '## What\n\nAdd it.\n');
    const to = tempDir();
    expect(exportMarkdown(records, build.workId, to)).toEqual([join(to, 'brief-what.md')]);
    expect(exportMarkdown(records, concept.workId, to)).toEqual([join(to, 'decision-same.md'), join(to, `decision-same-${second.workId}.md`)]);
  });

  it('fails on an invalid or unwritable destination and changes nothing', async () => {
    const records = await open();
    const build = lar(records, 'build');
    const after = records.setBody(build.workId, 1, 'brief', '# Brief');
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, '');
    const locked = tempDir();
    chmodSync(locked, 0o500);

    expect(() => exportMarkdown(records, build.workId, join(tempDir(), 'missing'))).toThrow("isn't a folder");
    expect(() => exportMarkdown(records, build.workId, file)).toThrow("isn't a folder");
    expect(() => exportMarkdown(records, build.workId, 'relative')).toThrow('absolute');
    expect(() => exportMarkdown(records, build.workId, locked)).toThrow(expect.objectContaining({ code: 'export-failed' }));
    expect(readdirSync(locked)).toEqual([]);
    expect(records.read(build.workId)).toEqual(after);
  });

  it('refuses to replace a file the folder already holds and writes nothing', async () => {
    const records = await open();
    const [concept, decision] = [lar(records, 'concept'), lar(records, 'decision')];
    records.setBody(concept.workId, 1, 'map', '# Map');
    records.setBody(decision.workId, 1, 'decision', '# Choice');
    records.setParent(decision.workId, 2, concept.workId);
    const to = tempDir();
    writeFileSync(join(to, 'decision-choice.md'), 'mine');

    expect(() => exportMarkdown(records, concept.workId, to)).toThrow(
      expect.objectContaining({ code: 'export-failed', message: expect.stringContaining(join(to, 'decision-choice.md')) }),
    );
    expect(readdirSync(to)).toEqual(['decision-choice.md']);
    expect(readFileSync(join(to, 'decision-choice.md'), 'utf8')).toBe('mine');
  });

  it('copies the files on a filesystem without hard links', async () => {
    const records = await open();
    const build = lar(records, 'build');
    records.setBody(build.workId, 1, 'brief', '# Brief\n\nAdd it.\n');
    const to = tempDir();
    unlinkable.code = 'ENOTSUP';

    expect(exportMarkdown(records, build.workId, to)).toEqual([join(to, 'brief-brief.md')]);
    expect(readdirSync(to)).toEqual(['brief-brief.md']);
    expect(readFileSync(join(to, 'brief-brief.md'), 'utf8')).toBe('# Brief\n\nAdd it.\n');
  });

  it('keeps a temporary file it did not make', async () => {
    const records = await open();
    const build = lar(records, 'build');
    records.setBody(build.workId, 1, 'brief', '# Brief');
    const to = tempDir();
    const temporary = join(to, `.brief-brief.md.${process.pid}.tmp`);
    writeFileSync(temporary, 'mine');

    expect(() => exportMarkdown(records, build.workId, to)).toThrow(expect.objectContaining({ code: 'export-failed' }));
    expect(readdirSync(to)).toEqual([`.brief-brief.md.${process.pid}.tmp`]);
    expect(readFileSync(temporary, 'utf8')).toBe('mine');
  });

  it("writes each Dependency the record holds, with its contract, references, met mark and handover", async () => {
    const records = await open();
    const build = lar(records, 'build');
    const added = records.addDependency(build.workId, {
      need: 'A sign-in endpoint.', owner: 'acme/auth', contract: 'POST /sign-in.', evidence: 'The PR merges.', ticket: 'acme/auth#5',
      pullRequests: ['acme/auth#9'], handover: 'Please add it.',
    });
    records.markDependencyMet(added.dependencyId, 1, 'pedro');
    const to = tempDir();

    expect(exportMarkdown(records, build.workId, to)).toEqual([join(to, 'dependency-acme-auth-a-sign-in-endpoint.md')]);
    const text = readFileSync(join(to, 'dependency-acme-auth-a-sign-in-endpoint.md'), 'utf8');
    for (const part of ['# acme/auth: A sign-in endpoint.', 'POST /sign-in.', 'The PR merges.', 'acme/auth#5', 'acme/auth#9', 'Marked met by pedro', 'Please add it.']) {
      expect(text).toContain(part);
    }
  });

  it('refuses a record with nothing to export', async () => {
    const records = await open();
    const build = lar(records, 'build');
    expect(() => exportMarkdown(records, build.workId, tempDir())).toThrow('nothing to export');
  });
});
