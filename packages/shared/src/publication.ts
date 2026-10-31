import type { AzureBodyField } from './item-details.ts';
import type { RepositoryOperation, RepositorySetup } from './model.ts';
import type { VocabularyDiscovery } from './vocabulary.ts';

// Browser-safe requests and results for the publication journal. Provider adapters execute only claimed operations.

export interface GateEvidence {
  gateId: string;
  workId: string;
  sourceRevision: number;
  briefDigest: string;
  approvedBy: string;
  evidence: string;
  recordedAt: string;
}

export interface GateResult {
  briefDigest: string | null;
  current: boolean;
  evidence: GateEvidence[];
}

export interface PublicationSource {
  workId: string;
  revision: number;
  /** Includes refinement and structure, excludes execution metadata and journal writes. */
  digest: string;
  gate: GateEvidence | null;
}

export interface PublicationReadiness {
  eligible: boolean;
  reasons: string[];
  sources: PublicationSource[];
}

export interface PublicationDestination {
  provider: 'github' | 'azure';
  repository: string;
  /** Azure project or team scope, when needed. */
  project?: string;
  ticket?: string;
  url?: string;
}

export interface VocabularyTerm {
  type: string | null;
  labels: string[];
}

export interface PublicationTicket {
  /** The work ID, or for a Dependency's request, the Dependency's ID. */
  workId: string;
  /** Set on a Dependency's request: the work record that holds the Dependency. Its destination is the owning team's repository. */
  dependencyOf?: string;
  /** Node engine's effective settings at preview. Older journal callers may omit it. */
  settingsSnapshot?: string;
  destination: PublicationDestination;
  /** Effective entries applicable to this ticket, after local overrides and repository defaults. */
  vocabulary: Record<string, VocabularyTerm>;
  /** The user's explicit resolution of all applicable exclusive type candidates, including choosing none. */
  typeResolution: { candidates: string[]; selected: string | null };
  title: string;
  body: string;
}

export type PublicationLocation =
  | { kind: 'body'; start: number; end: number; field?: AzureBodyField }
  | { kind: 'comment'; commentId: string };

/** Raw provider description and the facts that determine required update notices. */
export interface PublicationBodySnapshot {
  field?: AzureBodyField;
  body: string;
  format: 'markdown' | 'html' | 'unsupported';
  revision?: number;
  assigned: boolean;
  linkedPullRequest: boolean;
}

export interface PublicationTextConflict {
  workId: string;
  stored: string;
  current: string;
  proposed: string;
  location: PublicationLocation;
  reason: string;
}

interface Operation {
  operationId: string;
  ticketWorkId: string;
  /** Earlier operations whose successful results this operation requires. */
  dependsOn: string[];
}

export type PublicationOperation = Operation & (
  | { kind: 'create' }
  | { kind: 'append' | 'replace'; content: string; location: Extract<PublicationLocation, { kind: 'body' }>; expectedText: string; expected?: PublicationBodySnapshot }
  | { kind: 'comment'; content: string; purpose?: 'notice' }
  | { kind: 'replace-comment'; content: string; location: Extract<PublicationLocation, { kind: 'comment' }>; expectedText: string }
  | { kind: 'relationship'; relatedWorkId: string; relationship: 'child' | 'blocked-by' }
  | { kind: 'textual-relationship'; relatedWorkId: string; relationship: 'child' | 'blocked-by'; content: string }
  | { kind: 'pr-closing-reference'; pullRequest: string; content: string }
);

export interface PublicationContent {
  tickets: PublicationTicket[];
  /** Provider writes in dispatch order. An uncertain or failed operation stops dispatch. */
  operations: PublicationOperation[];
}

export interface PublicationProposal extends PublicationContent {
  /** Every source returned by publicationReadiness, at the revision used to prepare the content. */
  sources: { workId: string; revision: number }[];
  replaces?: string;
}

export type PublicationOutcome =
  | { status: 'successful'; evidence: string; ticket?: string; url?: string; location?: PublicationLocation }
  | { status: 'failed' | 'uncertain'; evidence: string };

export interface PublicationAttempt {
  /** Creation receipts survive independently of content verification. */
  verification?: { status: 'pending' | 'verified' | 'discrepancy'; evidence: string };
  claimToken: string;
  claimedBy: string;
  claimedAt: string;
  /** Claiming records uncertainty before the provider write. No expiry returns it to pending. */
  status: 'successful' | 'failed' | 'uncertain';
  evidence: string | null;
  ticket: string | null;
  url: string | null;
  location: PublicationLocation | null;
  resolvedBy: string | null;
  recordedAt: string | null;
}

export interface PublicationOperationResult {
  operation: PublicationOperation;
  status: 'pending' | PublicationAttempt['status'];
  attempt: PublicationAttempt | null;
}

export interface PublicationPlan extends PublicationContent {
  planId: string;
  workId: string;
  revision: number;
  /** SHA-256 of the complete immutable proposal, source evidence included. Approval must echo it. */
  digest: string;
  sources: PublicationSource[];
  replaces: string | null;
  supersededBy: string | null;
  proposedAt: string;
  approval: { approvedBy: string; approvedAt: string; digest: string } | null;
  results: PublicationOperationResult[];
}

export interface PublicationPending {
  plan: PublicationPlan;
  current: boolean;
  reasons: string[];
  next: PublicationOperation | null;
  /** Provider edits that require a new explicit text resolution and approval. */
  conflicts?: PublicationTextConflict[];
  successful: string[];
  failed: string[];
  uncertain: string[];
}

export interface PublishedText {
  /** Distinguishes primary publication text from textual relationship comments across owning plans. */
  operationKind: PublicationOperation['kind'];
  planId: string;
  operationId: string;
  workId: string;
  ticket: string;
  url: string;
  text: string;
  location: PublicationLocation;
  recordedAt: string;
}

export interface PublicationAttachment {
  workId: string;
  planId: string;
  ticket: string;
  url: string;
  recordedAt: string;
}

/** Team-language content entered before the engine renders an immutable preview. */
export interface PublicationDocument {
  workId: string;
  title: string;
  outcome: string;
  change: string;
  checks: string[];
  assumptions: string[];
  decisions: { decision: string; reason: string }[];
  builderNotes: string[];
  domainNotes: string[];
  relatedTickets: string[];
}

/** Team-language request for the team that owns a Dependency, rendered into its ticket or handover. */
export interface PublicationDependencyDocument {
  dependencyId: string;
  title: string;
  change: string;
  reason: string;
  contract: string;
  checks: string[];
}

/** A fresh journal read for the reusable board dialog. This is never durable browser state. */
export interface PublicationBoardState {
  readiness: PublicationReadiness;
  sources: { workId: string; revision: number; title: string; repository: string; kind: string; body: string; ticket?: string | null }[];
  settings: { setup: RepositorySetup; discovery: VocabularyDiscovery }[];
  firstUse: boolean;
  pending: PublicationPending | null;
  candidates?: { operationId: string; tickets: { ticket: string; url: string }[]; comments?: string[]; evidence: string }[];
  handover?: string;
  attachments?: PublicationAttachment[];
  history?: PublicationPlan[];
  resolvedUrl?: { workId: string; revision: number; ticket: string; url: string; body: string; format: PublicationBodySnapshot['format'] };
}

/** The independent local consents needed for one concrete operation. */
export function publicationConsents(operation: PublicationOperation, ticket: PublicationTicket): RepositoryOperation[] {
  if (operation.kind === 'create') return ['publish-ticket',
    ...Object.values(ticket.vocabulary).some((term) => term.labels.length) ? ['tag-ticket' as const] : [],
    ...ticket.typeResolution.selected ? ['type-ticket' as const] : []];
  if (operation.kind === 'pr-closing-reference') return ticket.destination.provider === 'azure' ? ['relate-ticket'] : [];
  if (operation.kind === 'relationship') return ['relate-ticket'];
  return operation.kind === 'append' || operation.kind === 'replace' ? ['edit-ticket'] : ['comment-ticket'];
}

/** GitHub child links modify the parent's sub-issues collection; other writes modify the target. */
export function publicationWriteTicket(operation: PublicationOperation, tickets: PublicationTicket[]): PublicationTicket {
  const target = tickets.find((ticket) => ticket.workId === operation.ticketWorkId)!;
  return operation.kind === 'relationship' && operation.relationship === 'child' && target.destination.provider === 'github'
    ? tickets.find((ticket) => ticket.workId === operation.relatedWorkId)!
    : target;
}
