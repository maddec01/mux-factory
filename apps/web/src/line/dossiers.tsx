// The line's dossiers: each open concept, and each open item with sub-issues on the board. A dossier starts collapsed
// to its two header lines: its kind, title and chips (parts that need you, open decisions, blocked slices, fog), then
// its part bar, parts done, what's next, agent figures and repositories in columns that line up across every dossier
// and In flight row. Opened, it lists what keeps the work moving (parts that need you, parts to verify or merge, open
// decisions, blocked slices, waiting parts, parts ready to start and the map's fog) or says nothing holds it up, then
// its Work map or its parts list: each part with what it asks next, its stage track, figures, thread and slices, the
// done parts folded away. The browser remembers which dossiers are open and which view each shows.

import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Ban, ChevronDown, ChevronRight, CircleHelp, GitPullRequest, ListChecks, Map as MapIcon, MessagesSquare } from 'lucide-react';
import { blockerGroups, blockerRef, plural, prLabel, itemName, ref, repoKey, repoName } from '@lar-factory/shared';
import type { BoardData, Item, ItemThread } from '@lar-factory/shared';
import { Badge } from '@lar-factory/ui/design-system/Badge';
import { useBoardStore } from '../board/board-store.ts';
import { useItemDialogStore } from '../item-dialog/item-dialog-store.ts';
import { AzureFields, ItemTitle, SliceBar } from '../items/item-parts.tsx';
import { OpenThread } from '../items/open-thread.tsx';
import { StartAfterError } from '../items/start-after.tsx';
import { StartMessage } from '../items/start-control.tsx';
import { StatusGlyph, STATUS_COLOR } from '../items/status-glyph.tsx';
import { DECISION_KINDS, THREAD_GLYPH, dossiersOf, isDone, openWaits, threadsOf } from './dossier-parts.ts';
import type { Part } from './dossier-parts.ts';
import { PartStart, startable } from './part-start.tsx';
import { HEAD_A1, LINE2_A1, Figures, figuresOf } from './columns.tsx';
import { OnYourDesk, Track, lastSeen, stageOf, YOURS, picked } from './stage-track.tsx';
import { WorkMap } from './work-map.tsx';

const open = (item: Item) => useItemDialogStore.getState().open(item.id);
/** Keeps a click on a control from opening the item underneath it, nor do clicks in the menu it opens. */
const stop = (e: MouseEvent) => e.stopPropagation();
const usePicked = (item: Item) => useItemDialogStore((state) => state.itemId === item.id);

/** Finds the issue `#n` names in `repo`, the dossier's own repository when the reference names none. */
type FindRef = (repo: string | undefined, n: number) => Item | undefined;

/** Text with its `#n` and `owner/repo#n` references as buttons that open the item. */
function Refs({ text, find }: { text: string; find: FindRef }) {
  return text.split(/((?:[\w.-]+\/[\w.-]+)?#\d+)/).map((bit, n) => {
    const ref = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(bit);
    const item = ref ? find(ref[1], Number(ref[2])) : undefined;
    return item
      ? <button key={n} type="button" onClick={() => open(item)} title={item.title} className="rounded px-0.5 font-medium tabular-nums text-(--primary) hover:bg-(--accent)">{bit}</button>
      : bit;
  });
}

/** What a part waits on, as plain muted text: `waits on #305, #306`. */
const waitsOn = (part: Part) => `waits on ${openWaits(part).map((b) => blockerRef(part.item, b)).join(', ')}`;

/** A part's thread, its title and state; before it has one, what its start waits on. */
function ThreadLine({ part }: { part: Part }) {
  const { thread } = part;
  if (!thread) {
    const { work, dependencies } = blockerGroups(part.item, openWaits(part));
    const waits = [...work ? [`${work.names} ${work.many ? 'are' : 'is'} done`] : [], ...dependencies ? [`you mark ${dependencies.names} met`] : []];
    return waits.length ? <span>Thread starts when {waits.join(' and ')}</span> : null;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={thread.title}>
      <StatusGlyph status={THREAD_GLYPH[thread.state]} className="size-3" />
      <span className="truncate">T3 · {thread.title}</span>
      <span className="shrink-0">· {thread.state}{lastSeen(thread)}</span>
    </span>
  );
}

type View = 'list' | 'map';

/** A dossier setting this browser remembers across reloads, stored as a string under `lar-board:dossier-<name>:<id>`. */
interface Stored<T> {
  name: string;
  /** The setting from what was stored, or from null before anything is. */
  read: (stored: string | null) => T;
  write: (value: T) => string;
}

/** Open or collapsed, stored as '1' or '0'; a dossier starts collapsed. */
const OPEN: Stored<boolean> = { name: 'open', read: (s) => s === '1', write: (on) => (on ? '1' : '0') };
/** Work map or parts list; a dossier starts on its Work map. */
const VIEW: Stored<View> = { name: 'view', read: (s) => (s === 'list' ? 'list' : 'map'), write: (v) => v };

function useStored<T>({ name, read, write }: Stored<T>, parent: Item): [T, (v: T) => void] {
  const key = `lar-board:dossier-${name}:${parent.id}`;
  const [value, setValue] = useState(() => read(localStorage.getItem(key)));
  return [value, (v) => {
    localStorage.setItem(key, write(v));
    setValue(v);
  }];
}

/** Work map or parts list: one dossier's way of drawing its parts. */
function ViewToggle({ view, onView }: { view: View; onView: (v: View) => void }) {
  const one = (v: View, icon: ReactNode, label: string) => (
    <button type="button" onClick={(e) => { e.stopPropagation(); onView(v); }} aria-pressed={view === v}
      className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs ${view === v ? 'bg-(--card) font-medium text-(--foreground) shadow-xs' : 'text-(--muted-foreground) hover:text-(--foreground)'}`}>{icon}{label}</button>
  );
  return <div className="inline-flex rounded-lg bg-(--muted) p-0.5">{one('map', <MapIcon className="size-3.5" />, 'Work map')}{one('list', <ListChecks className="size-3.5" />, 'Parts list')}</div>;
}

/** A part as a link to its item dialog: its status and its title, up to two lines. */
function PartLink({ part }: { part: Part }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); open(part.item); }} title={`${itemName(part.item)}`}
      className="flex min-w-0 items-start gap-1.5 rounded text-left text-[13px] hover:underline">
      <span className="mt-0.5 inline-flex"><StatusGlyph status={part.item.status} className="size-3.5" /></span>
      <span className="line-clamp-2"><ItemTitle item={part.item} /></span>
    </button>
  );
}

/** One entry of an attention row, with what it waits on or its next action at the right. */
function Entry({ main, side }: { main: ReactNode; side?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-md px-1.5 py-1 hover:bg-(--soft)">
      <span className="min-w-0 flex-1 basis-64">{main}</span>
      {side && <span className="ml-auto shrink-0 text-[11px] text-(--muted-foreground)">{side}</span>}
    </div>
  );
}

/** What keeps the work moving, as labelled rows, each shown only with entries: parts in Needs you, parts in Verify or
 *  Ready to merge, open decisions, blocked slices, parts waiting on others, parts ready to start, the map's
 *  Dependencies and its fog. */
function Attention({ parent, parts, data, find }: { parent: Item; parts: Part[]; data: BoardData; find: FindRef }) {
  const ahead = parts.filter((p) => !isDone(p.item));
  const blocked = ahead.flatMap((part) => part.item.slices.filter((s) => s.progress === 'blocked').map((slice) => ({ part, slice })));
  const rows = [
    { key: 'you', label: 'Needs you', tone: 'text-(--warning-foreground)',
      entries: ahead.filter((p) => p.item.status === 'Needs you').map((p) => <Entry key={p.item.id} main={<PartLink part={p} />} side={<OpenThread item={p.item} data={data} />} />) },
    { key: 'verify', label: 'To verify or merge', tone: 'text-(--warning-foreground)',
      entries: ahead.filter((p) => p.item.status === 'Verify' || p.item.status === 'Ready to merge').map((p) => <Entry key={p.item.id} main={<PartLink part={p} />} side={p.item.status} />) },
    { key: 'decisions', label: 'Open decisions', tone: 'text-(--primary)',
      entries: ahead.filter((p) => DECISION_KINDS.includes(p.kind)).map((p) => <Entry key={p.item.id} main={<PartLink part={p} />} side={`${p.kind} · ${p.item.status}`} />) },
    { key: 'blocked', label: 'Blocked slices', tone: 'text-(--st-review)',
      entries: blocked.map(({ part, slice }, i) => (
        <Entry key={i}
          main={<span className="flex min-w-0 items-start gap-1.5 text-[13px]"><Ban className="mt-0.5 size-3.5 shrink-0 text-(--st-review)" /><span className="line-clamp-2">{slice.number > 0 && <><span className="tabular-nums text-(--muted-foreground)">#{slice.number}</span> </>}{slice.title}</span></span>}
          side={<>slice of <button type="button" onClick={() => open(part.item)} title={part.item.title} className="rounded px-0.5 font-medium tabular-nums text-(--primary) hover:bg-(--accent)">{ref(part.item)}</button> · waits on a re-slice</>} />
      )) },
    { key: 'waiting', label: 'Waiting', tone: 'text-(--muted-foreground)',
      entries: ahead.filter((p) => openWaits(p).length && p.item.status !== 'Needs you').map((p) => (
        <Entry key={p.item.id} main={<PartLink part={p} />} side={waitsOn(p)} />
      )) },
    { key: 'ready', label: 'Ready to start', tone: 'text-(--st-now)',
      entries: ahead.filter(startable).map((p) => (
        <Entry key={p.item.id} main={<PartLink part={p} />} side={<span onClick={stop}><PartStart part={p} data={data} label="Start" /></span>} />
      )) },
    { key: 'dependencies', label: 'Dependencies', tone: 'text-(--st-review)',
      entries: (parent.map?.dependencies ?? []).map((d) => (
        <Entry key={d} main={<span className="flex items-start gap-1.5 text-[13px]"><Ban className="mt-0.5 size-3.5 shrink-0 text-(--st-review)" /><span><Refs text={d} find={find} /></span></span>} />
      )) },
    { key: 'fog', label: 'Fog', tone: 'text-(--st-amber)',
      entries: (parent.map?.fog ?? []).map((q) => (
        <Entry key={q} main={<span className="flex items-start gap-1.5 text-[13px]"><CircleHelp className="mt-0.5 size-3.5 shrink-0 text-(--st-amber)" /><span><Refs text={q} find={find} /></span></span>} />
      )) },
  ].filter((r) => r.entries.length);
  if (!rows.length) return <p className="m-0 text-[13px] text-(--muted-foreground)" data-attention-none>Nothing holds this up.</p>;
  return (
    // The labels' column is 7.5rem, or as wide as the longest label so none wraps ("To verify or merge" needs more).
    <dl className="m-0 grid grid-cols-[minmax(7.5rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2" data-attention>
      {rows.map((r) => (
        <div key={r.key} className="contents" data-attention-row={r.key}>
          <dt className={`whitespace-nowrap pt-1 text-[11px] font-medium uppercase tracking-wide ${r.tone}`}>{r.label} <span className="tabular-nums">{r.entries.length}</span></dt>
          <dd className="m-0 grid gap-0.5">{r.entries}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The one thing a part asks next: on your desk, its Start (or Start after while it waits), or its thread while one
 *  works on it. A part that waits on another and has no Start says what it waits on instead. */
function Action({ part, data }: { part: Part; data: BoardData }) {
  const { status } = part.item;
  if (YOURS.includes(status)) return <OnYourDesk status={status} />;
  if (status === 'Ready' || status === 'Queued') return <span onClick={stop}><PartStart part={part} data={data} label="Start" /></span>;
  if (openWaits(part).length) return <span>{waitsOn(part)}</span>;
  if (['Shaping', 'In progress', 'Review'].includes(status)) return <span onClick={stop}><OpenThread item={part.item} data={data} /></span>;
  return null;
}

/** One part of the parts list: its title and what it asks next, then its stage track, status, agent figures, Azure
 *  fields, PR and thread, its slice bar, and its start's message or error. */
function PartRow({ part, data }: { part: Part; data: BoardData }) {
  const { item } = part;
  const isPicked = usePicked(item);
  const waits = openWaits(part);
  const s = figuresOf(item, data);
  return (
    <li onClick={() => open(item)} data-part={item.id} className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-(--accent) ${picked(isPicked)}`}>
      <span className="flex min-w-0 items-center gap-2"><PartLink part={part} /></span>
      <span className="flex items-center justify-end gap-2 text-[11px] text-(--muted-foreground)">
        {item.slices.length > 0 && <span className="tabular-nums">{item.slices.filter((x) => x.progress === 'done').length}/{item.slices.length}</span>}
        <Action part={part} data={data} />
      </span>
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-(--muted-foreground)" data-part-meta>
        <span className="w-28 shrink-0"><Track status={item.status} waiting={waits.length > 0} /></span>
        <span>{item.status}</span>
        {s && <Figures s={s} />}
        <AzureFields azure={item.azure} />
        {item.linkedPrs.map((pr) => <span key={pr.number} className="inline-flex items-center gap-1"><GitPullRequest className="size-3 text-(--st-done)" />{prLabel(pr)}</span>)}
        <span className="min-w-0 empty:hidden"><ThreadLine part={part} /></span>
      </span>
      {item.slices.length > 0 && <span className="col-span-2 pl-3.5"><SliceBar item={item} /></span>}
      {(item.status === 'Ready' || item.status === 'Queued') && (
        <span className="col-span-2 pl-5 empty:hidden" onClick={stop}><StartMessage item={item} kind={item.status === 'Ready' ? 'build' : 'refine'} /><StartAfterError item={item} data={data} /></span>
      )}
    </li>
  );
}

/** The parts list: one row per open part in two columns where there's room, the done ones folded into a count. */
function PartsList({ parts, data }: { parts: Part[]; data: BoardData }) {
  const [showDone, setShowDone] = useState(false);
  const shown = parts.filter((p) => showDone || !isDone(p.item));
  const done = parts.filter((p) => isDone(p.item)).length;
  return (
    <div className="grid gap-1">
      <ol className="m-0 grid list-none gap-x-4 gap-y-0.5 p-0 @4xl:grid-cols-2" data-parts-list>
        {shown.map((p) => <PartRow key={p.item.id} part={p} data={data} />)}
      </ol>
      {done > 0 && <button type="button" aria-expanded={showDone} onClick={() => setShowDone(!showDone)} className="justify-self-start rounded px-2 py-1 text-[11px] text-(--muted-foreground) hover:bg-(--accent)">{showDone ? `Hide ${done} done` : `Show ${done} done`}</button>}
    </div>
  );
}

type Slice = Item['slices'][number];

/** A dossier's reading for its header: parts done and counted, and the parts each chip and "what's next" name.
 *  `needsYou` holds the parts in Needs you; `yours` adds those in Verify or Ready to merge. */
interface Moving {
  parts: Part[]; done: number; count: number;
  needsYou: Part[]; yours: Part[]; decisions: Part[]; blockedSlices: { part: Part; slice: Slice }[];
  ready: Part[]; active: Part[]; fog: string[];
}

function moving(parent: Item, parts: Part[]): Moving {
  const ahead = parts.filter((p) => !isDone(p.item));
  return {
    parts,
    done: Math.max(parent.subIssues.completed, parts.length - ahead.length),
    count: Math.max(parent.subIssues.total, parts.length),
    needsYou: ahead.filter((p) => p.item.status === 'Needs you'),
    yours: ahead.filter((p) => YOURS.includes(p.item.status)),
    decisions: ahead.filter((p) => DECISION_KINDS.includes(p.kind)),
    blockedSlices: ahead.flatMap((part) => part.item.slices.filter((s) => s.progress === 'blocked').map((slice) => ({ part, slice }))),
    ready: ahead.filter(startable),
    active: ahead.filter((p) => ['Shaping', 'In progress', 'Review'].includes(p.item.status)),
    fog: parent.map?.fog ?? [],
  };
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={on} aria-label={on ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="grid size-6 shrink-0 place-items-center rounded-md text-(--muted-foreground) hover:bg-(--soft) hover:text-(--foreground)">
      {on ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}

const kindLabel = (parent: Item) => (parent.kind === 'concept' ? 'Concept' : 'Coupled work');
const repos = (m: Moving, data: BoardData) => [...new Set(m.parts.map((p) => repoName(repoKey(p.item), data.repos)))].join(' + ');

/** Every part as a segment in its status colour, done first, so the bar fills left to right; a dashed one per part the board doesn't read. */
function PartsBar({ m }: { m: Moving }) {
  const order = [...m.parts].sort((a, b) => Number(isDone(b.item)) - Number(isDone(a.item)) || stageOf(b.item.status) - stageOf(a.item.status));
  const unread = m.count - m.parts.length;
  return (
    <ol className="m-0 flex min-w-0 list-none gap-[2px] p-0" title={`${m.done}/${m.count} parts done`} data-part-bar>
      {order.map((p) => (
        <li key={p.item.id} title={`${itemName(p.item)}: ${p.item.status}`} className={`h-1.5 min-w-[3px] flex-1 rounded-full ${p.item.status === 'In progress' ? 'status-pulse' : ''}`}
          style={{ background: isDone(p.item) ? 'var(--st-done)' : p.item.status === 'Queued' || p.item.status === 'List' ? 'var(--soft)' : STATUS_COLOR[p.item.status] }} />
      ))}
      {Array.from({ length: Math.max(0, unread) }, (_, n) => <li key={`u${n}`} className="h-1.5 min-w-[3px] flex-1 rounded-full border border-dashed border-(--input)" />)}
    </ol>
  );
}

/** The one thing to say next: what waits on you (a part in Needs you first), else what can start, else what's moving. */
function nextOf(m: Moving): { tone: 'you' | 'start' | 'moving' | 'none'; part?: Part; text: string } {
  const yours = m.needsYou[0] ?? m.yours[0];
  if (yours) return { tone: 'you', part: yours, text: `${itemName(yours.item)}` };
  if (m.ready[0]) return { tone: 'start', part: m.ready[0], text: `${itemName(m.ready[0].item)}` };
  if (m.active[0]) return { tone: 'moving', part: m.active[0], text: `${itemName(m.active[0].item)}` };
  return { tone: 'none', text: m.count > m.parts.length ? 'Some parts are outside the board' : 'Nothing waits on you' };
}

/** Line 1's thread counts and Azure fields: they give up their room before the title does, ending in an ellipsis.
 *  Below `lg` they may shrink to nothing, so a narrow line's title keeps its room; their tooltips keep the text. */
const META = 'min-w-0 lg:min-w-10 shrink-[1000] truncate';

/** The dossier's T3 threads, then how many run and how many wait for the user's reply, each left out at zero (with no
 *  threads, nothing), so the threads' wording never contradicts the "need you" chip, which counts parts. */
function threadCounts(threads: ReturnType<typeof threadsOf>): string {
  if (!threads.length) return '';
  const running = threads.filter((t) => t.state === 'running').length;
  const waiting = threads.filter((t) => t.state === 'needs you').length;
  return [plural(threads.length, 'T3 thread'), running && `${running} running`, waiting && `${waiting} awaiting your reply`].filter(Boolean).join(' · ');
}

/** A small count chip: `n` and its word, coloured by `tone`, hidden at zero. */
function Count({ n, word, tone, icon }: { n: number; word: string; tone: 'warning' | 'danger' | 'neutral' | 'accent'; icon?: ReactNode }) {
  if (!n) return null;
  return <Badge tone={tone} className="tabular-nums whitespace-nowrap" data-chip>{icon}{n} {word}</Badge>;
}

/** What needs the user's eye: parts in Needs you, open decisions, blocked slices and the map's remaining fog. */
function Counts({ m }: { m: Moving }) {
  return <>
    <Count n={m.needsYou.length} word="need you" tone="warning" icon={<StatusGlyph status="Needs you" className="size-3" />} />
    <Count n={m.decisions.length} word={m.decisions.length === 1 ? 'decision' : 'decisions'} tone="accent" icon={<MessagesSquare />} />
    <Count n={m.blockedSlices.length} word="blocked" tone="danger" icon={<Ban />} />
    <Count n={m.fog.length} word="fog" tone="neutral" icon={<CircleHelp />} />
  </>;
}

/** Next, as a sentence with its Start. */
function Next({ m, data }: { m: Moving; data: BoardData }) {
  const n = nextOf(m);
  // A part on your desk is named as its attention row names it: Needs you, or to verify or merge.
  const yours = n.part?.item.status === 'Verify' ? 'To verify' : n.part?.item.status === 'Ready to merge' ? 'To merge' : 'Needs you';
  const word = { you: yours, start: 'Next', moving: 'Moving', none: '' }[n.tone];
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12px]">
      {word && <span className={`shrink-0 font-medium ${n.tone === 'you' ? 'text-(--warning-foreground)' : 'text-(--muted-foreground)'}`}>{word}</span>}
      <span className="min-w-0 truncate" title={n.text}>{n.text}</span>
      {n.part && n.tone === 'start' && <span className="shrink-0" onClick={stop}><PartStart part={n.part} data={data} label="Start" /></span>}
    </span>
  );
}

/** A concept or coupled parent, in full: what keeps it moving, then its parts as a Work map or a list. */
function Dossier({ parent, parts, data, now }: { parent: Item; parts: Part[]; data: BoardData; now: number }) {
  const [view, setView] = useStored(VIEW, parent);
  const [on, setOpen] = useStored(OPEN, parent);
  // Letting go of a drag that selected text in the header leaves the dossier as it was; a key press on the chevron
  // (a click with no detail) or a selection elsewhere on the page still toggles it.
  const toggle = (e: MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (e.detail > 0 && selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
    setOpen(!on);
  };
  const isPicked = usePicked(parent);
  const find: FindRef = (repo = parent.repo ?? '', n) => data.items.find((i) => i.number === n && i.repo?.toLowerCase() === repo.toLowerCase());
  const m = moving(parent, parts);
  const missing = m.count - parts.length;
  const threads = [parent, ...parts.map((p) => p.item)].flatMap(threadsOf);

  return (
    <article className="overflow-hidden rounded-xl border border-(--border) bg-(--card)" data-dossier={parent.id}>
      {/* Only the title opens the item; anywhere else on the two lines but the chips opens or closes the dossier. */}
      <div onClick={toggle} data-item={parent.id} data-open={on} className={`${HEAD_A1} cursor-pointer rounded-xl hover:bg-(--accent) ${on ? 'rounded-b-none border-b border-(--border)' : ''} ${picked(isPicked)}`}>
        <Toggle on={on} onToggle={() => setOpen(!on)} />
        <span className="flex min-w-0 items-start justify-between gap-x-2 gap-y-1 pt-0.5" data-line="1">
          {/* One row: the threads and Azure fields shrink first, down to an ellipsis, so the title keeps its room. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-x-2">
            {/* The badge and title stay together, so a long title wraps beside the badge instead of below it. */}
            <span className="flex min-w-0 items-start gap-2">
              <Badge tone="neutral" className="mt-px shrink-0">{kindLabel(parent)}</Badge>
              <button type="button" onClick={(e) => { e.stopPropagation(); open(parent); }} title={parent.title} data-title
                className="min-w-0 rounded text-left text-[14px] font-medium hover:underline"><ItemTitle item={parent} /></button>
            </span>
            <span className={`${META} text-[11px] text-(--muted-foreground) empty:hidden`} title={threadCounts(threads) || undefined} data-threads>
              {threadCounts(threads)}
            </span>
            <span className={`${META} empty:hidden`}><AzureFields azure={parent.azure} /></span>
          </span>
          <span onClick={stop} className="flex shrink-0 gap-1" data-chips><Counts m={m} /></span>
        </span>
        <span className={`col-start-2 grid ${LINE2_A1} items-center gap-x-4`} data-line="2">
          <span data-col="bar"><PartsBar m={m} /></span>
          <span className="text-[11px] tabular-nums text-(--muted-foreground)">{m.done}/{m.count} parts</span>
          <span data-col="next" className="min-w-0" data-next><Next m={m} data={data} /></span>
          <span data-col="figures" className="grid min-w-0"><Figures s={figuresOf(parent, data, true)} /></span>
          <span data-col="repos" className="hidden truncate text-right text-[11px] text-(--muted-foreground) lg:block" title={repos(m, data)}>{repos(m, data)}</span>
        </span>
      </div>

      {on && (
        <div className="grid gap-4 px-4 py-3">
          {missing > 0 && <p className="m-0 text-xs text-(--muted-foreground)" data-unread-parts>
            {plural(missing, 'part')} the board doesn't read. A repository may no longer be on the board.
          </p>}
          <Attention parent={parent} parts={parts} data={data} find={find} />
          <div className="grid gap-3">
            <ViewToggle view={view} onView={setView} />
            {view === 'map' ? <WorkMap parts={parts} check={parent.map?.check} data={data} now={now} /> : <PartsList parts={parts} data={data} />}
          </div>
        </div>
      )}
    </article>
  );
}

/** `items` are the line's items in the main area's scope. */
export function Dossiers({ items }: { items: Item[] }) {
  const { data, now } = useBoardStore();
  const dossiers = dossiersOf(items, data.items);
  if (!dossiers.length) return null;
  return <div className="grid gap-2" data-dossiers>{dossiers.map(({ parent, parts }) => <Dossier key={parent.id} parent={parent} parts={parts} data={data} now={now} />)}</div>;
}
