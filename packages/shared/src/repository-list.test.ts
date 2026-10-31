// Connections: each pair of onboarded repositories the user related, kept once in the local repository list.

import { onTestFinished, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnections, saveConnections, saveOnboarded, saveOnboarding } from './repository-list.ts';

const WEB = 'maddec01/lar-web';
const API = 'maddec01/lar-api';
const IOS = 'maddec01/lar-ios';

/** A data folder whose list names `repos`, each on the board. */
function dataDir(repos: string[] = [WEB, API, IOS]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lar repository list test '));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'repository-settings.json'), JSON.stringify({ repositories: repos.map((repo) => ({ repo })) }));
  return dir;
}

const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'repository-settings.json'), 'utf8')) as { connections?: string[][] };

test('a Connection reads the same from either repository', () => {
  const dir = dataDir();
  saveConnections(WEB, [API], dir);
  assert.deepEqual(readConnections(WEB, dir), [API]);
  assert.deepEqual(readConnections(API, dir), [WEB]);
  assert.deepEqual(readConnections(IOS, dir), []);
});

test('saving a pair from each side, or again, keeps it once', () => {
  const dir = dataDir();
  saveConnections(WEB, [API], dir);
  saveConnections(API, [WEB], dir);
  saveConnections('MADDEC01/LAR-WEB', [API, API], dir);
  assert.deepEqual(saved(dir).connections, [[API, WEB]]);
});

test("saving a repository's Connections replaces its pairs, so an unticked one goes", () => {
  const dir = dataDir();
  saveConnections(WEB, [API, IOS], dir);
  saveConnections(API, [IOS], dir);
  saveConnections(WEB, [IOS], dir);
  assert.deepEqual(readConnections(WEB, dir), [IOS]);
  assert.deepEqual(readConnections(API, dir), [IOS]);
});

test('only another repository on the board can be connected', () => {
  const dir = dataDir([WEB, API]);
  saveOnboarding({ repo: IOS, progress: { step: 'role', done: [], answers: { projectId: 'p' } } }, null, dir);
  saveConnections(WEB, [WEB, IOS, 'maddec01/lar-cli', API], dir);
  assert.deepEqual(readConnections(WEB, dir), [API]);
});

test('restoring an onboarding keeps its pairs once', () => {
  const dir = dataDir();
  saveConnections(WEB, [API], dir);
  saveOnboarding({ repo: WEB, progress: { step: 'role', done: [], answers: { projectId: 'p' } } }, null, dir, { replaceUnusableConfig: true });
  saveOnboarded(WEB, null, dir);
  saveConnections(WEB, [API], dir);
  assert.deepEqual(saved(dir).connections, [[API, WEB]]);
});

test('a repository that leaves the list takes its Connections with it', () => {
  const dir = dataDir();
  saveConnections(WEB, [API, IOS], dir);
  saveOnboarding({ repo: WEB, progress: { step: 'role', done: [], answers: { projectId: 'p' } } }, null, dir, { replaceUnusableConfig: true });
  saveOnboarding({ repo: 'maddec01/lar-cli', progress: { step: 'role', done: [], answers: { projectId: 'p' } } }, WEB, dir);
  assert.deepEqual(saved(dir).connections, []);
  assert.deepEqual(readConnections(API, dir), []);
});

test('a pair naming a repository removed from the file by hand reads as gone', () => {
  const dir = dataDir([WEB, API]);
  writeFileSync(join(dir, 'repository-settings.json'), JSON.stringify({ repositories: [{ repo: WEB }], connections: [[API, WEB], [WEB, 7]] }));
  assert.deepEqual(readConnections(WEB, dir), []);
});
