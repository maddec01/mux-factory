// The item source interface: where the board server reads tickets, for the work records' context, and closes one when
// the user confirms Abandon's close.
// Each adapter lives with its provider's code, such as GitHub issues in github/repo-issues.ts.

import type { Item, ItemSourceKind, ItemSourceProblem, PickedTicket, TicketMatch } from '@lar-factory/shared';
import type { NewObservation } from '@lar-factory/work-records';

/** One read of an item source: its title, for the board's header, and its items. */
export interface ItemsRead {
  title: string;
  items: Item[];
  /** Each repository whose items the read left off, and why; absent when none. */
  problems?: ItemSourceProblem[];
  /**
   * The repositories whose source a merged read hasn't read yet, as it still reads or waits for its tool's check;
   * absent when none. A source whose first read failed, or that its tool blocks, isn't waiting.
   */
  waiting?: string[];
}

/** Reports which item sources a read is reading: each source starts and finishes under its name, in whatever order its reads end. */
export interface ReadProgress {
  started(name: string): void;
  finished(name: string): void;
  /** A source's read landed while another still reads: the merged read so far, as a whole read would list it then. */
  landed?(read: ItemsRead): void;
}

/**
 * A read failure the user fixes outside the board, such as a logged-out az: the merged read leaves only this source's
 * repository off and shows the problem and its fix command, when one fixes it.
 */
export class ReadProblem extends Error {
  readonly fix?: string;
  constructor(message: string, fix?: string) {
    super(message);
    if (fix !== undefined) this.fix = fix;
  }
}

/** A read the provider answered with a ticket or PR that doesn't exist. */
export class NotFound extends Error {}

/** A read the provider refused because the signed-in account can't see that repository, ticket or PR. */
export class AccessLost extends Error {}

/**
 * How fast a merged read keeps each source: a source holding an item `active` says is due every `activeMs`, any other
 * every `idleMs`, ACTIVE_READ_MS and IDLE_READ_MS when absent, and every source is idle while `slow` holds, as when a
 * provider's quota runs low. A source whose change check sees every edit keeps only the items `polled` says at
 * `activeMs`, as no check sees a PR's checks finish. A source of a kind `waits` names reads nothing, as while its
 * provider's tool is still checking or blocks it; one `blocked` names, as by a logged-out gh, isn't waiting to read.
 */
export interface ReadPace {
  now: number;
  active(item: Item): boolean;
  polled(item: Item): boolean;
  waits?(kind: ItemSourceKind): boolean;
  blocked?(kind: ItemSourceKind): boolean;
  activeMs?: number;
  idleMs?: number;
  slow?: boolean;
}

/** How many tickets a search lists at most. */
export const TICKET_MATCHES = 20;

/** A ticket search's number: `12` or `#12`; null for words. */
export const ticketNumberOf = (query: string): number | null => (/^#?\d+$/.test(query.trim()) ? Number(query.trim().replace('#', '')) : null);

/** A ticket as its provider shows it now: open or closed with its assignees, or a confirmed not-found. */
export type TicketObservation = Omit<Extract<NewObservation, { of: 'ticket' }>, 'of'>;

/** Closed native parts read only during legacy onboarding import, never ordinary ticket picking. */
export interface LegacyChild extends PickedTicket {
  state: 'closed';
  labels: string[];
  notPlanned: boolean;
  mergedPr?: string;
}

export interface ItemSource {
  /** What a read reports for this source; absent for a source its repositories name, as the merged source then does. */
  name?: string;
  /**
   * Reads the source's items, reporting to `progress` for each source it reads on its way, if it merges several. A
   * merged source given `pace` reads only the sources due at its pace, and lists the others' items from their last read.
   */
  read(progress?: ReadProgress, pace?: ReadPace): Promise<ItemsRead>;
  /**
   * Reads these items alone afresh, as the source lists them, with their slices, PRs and checks; an item the source
   * no longer lists is left out. Absent on a source that reads only whole.
   */
  readSome?(items: Item[]): Promise<Item[]>;
  /**
   * What changed since `since`, in ms since the epoch, by a check that costs no quota while nothing did: the URLs of
   * the changed issues and PRs; null when the check can't tell which, so the whole source reads. Absent on a source
   * with no such check.
   */
  changes?(since: number): Promise<string[] | null>;
  /** Whether `changes` names every edit to an item: its state, labels, slices and PRs. */
  seesEdits?: boolean;
  /**
   * The ticket picker's search: up to TICKET_MATCHES of `repo`'s open tickets whose words match `query`, or the one
   * a number names. Throws when the provider can't answer.
   */
  searchTickets(repo: string, query: string): Promise<TicketMatch[]>;
  /** One of `repo`'s open tickets as a pick reads it; null when it has none open with that number. Throws when the provider can't answer. */
  readTicket(repo: string, number: number): Promise<PickedTicket | null>;
  /** Closed native decision/build parts of a selected legacy concept, with their original text. */
  legacyChildren?(repo: string, number: number): Promise<LegacyChild[]>;
  /** One of `repo`'s tickets, open or not, as a work record observes it. Throws when the provider can't answer. */
  observeTicket(repo: string, number: number): Promise<TicketObservation>;
  /** Closes the item's ticket once the user confirms Abandon's close: the error to show, or null when the provider accepted it. */
  abandon(item: Item): Promise<string | null>;
  /** The Item.id now of an item a record saved under an id from before Item.id was the content's node id; undefined when none is. */
}
