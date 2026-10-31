// Node entry for both the installed command and board server. Private records remain authoritative.
import { randomUUID } from 'node:crypto';
import { decodePart, isRecord, onAzure, publicationConsents, sameRepo, publicationWriteTicket, resolveVocabulary, type PublicationContent, type PublicationDependencyDocument, type PublicationDocument, type PublicationOperation,
  type PublicationPending, type PublicationPlan, type PublicationTicket, type RepositoryOperation } from '@lar-factory/shared';
import { readPublicationSettings, readRepositorySetups, type PublicationSettings } from '@lar-factory/shared/publication-settings';
import { prepareText, PublicationConflict, type PublicationDelivery, type PublicationResolution } from './publication-text.ts';
import { WorkRecordError, type WorkRecords } from './work-records.ts';
import { publicationProvider, PublicationRefused, type PublicationProvider, type TicketReceipt } from './publication-providers.ts';

export { PublicationConflict, type PublicationDelivery, type PublicationResolution } from './publication-text.ts';

export type { PublicationDependencyDocument, PublicationDocument } from '@lar-factory/shared';

export interface PreparePublication {
  documents: PublicationDocument[];
  /** Requests for the teams that own the work's Dependencies. A Dependency without one stays out of the plan. */
  dependencies?: PublicationDependencyDocument[];
  /** Required only for conflicting exclusive types; null explicitly chooses no type. */
  typeSelections?: Record<string, string | null>;
  replaces?: string;
  /** Default body delivery updates the last published location, including a prior comment fallback. Keyed by work or
   * Dependency ID; a Dependency's request is created by default and posted as a comment only on its ticket when chosen. */
  delivery?: Record<string, PublicationDelivery>;
  resolutions?: Record<string, PublicationResolution>;
}
export interface PublicationDependencies {
  settings?: (repository: string) => Promise<PublicationSettings>;
  /** Whether the repository is on this Mac's list; a Dependency's owner that isn't gets plain terms and no consent check. */
  allowed?: (repository: string) => boolean;
  provider?: PublicationProvider;
  /** Settings and the work database normally share the same application data directory. */
  dir?: string;
}
export interface ReconciliationSelection {
  operationId: string;
  /** A user-selected candidate, which the engine reads and checks against the approved payload. */
  ticket?: string;
  /** An explicitly supplied ordinary ticket URL, inspected even when provider search is unavailable. */
  url?: string;
  commentId?: string;
}

const invalid = (message: string): never => { throw new WorkRecordError('invalid', message); };
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
function validateDocument(value: unknown): asserts value is PublicationDocument {
  const strings = ['workId', 'title', 'outcome', 'change'];
  const lists = ['checks', 'assumptions', 'builderNotes', 'domainNotes', 'relatedTickets'];
  if (!isRecord(value) || strings.some((key) => typeof value[key] !== 'string' || !String(value[key]).trim())
    || lists.some((key) => !Array.isArray(value[key]) || value[key].some((item: unknown) => typeof item !== 'string' || !item.trim()))
    || !Array.isArray(value.decisions) || value.decisions.some((d: unknown) => !isRecord(d) || typeof d.decision !== 'string' || !d.decision.trim() || typeof d.reason !== 'string' || !d.reason.trim())) {
    invalid('Provide a complete team document with outcome, change, all lists and decisions with reasons.');
  }
}
const list = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join('\n') : 'None.';
const teamLanguage = (title: string, text: string) => {
  if (/\b(?:lar[- ]factory|factory|work[- ]records?|slices?|passing brief|shaping gate|start build)\b|^#+\s*(?:Status|Phase|Review progress|Private map)\b/im.test(`${title}\n${text}`)) {
    invalid('Rewrite private workflow wording into team language before preview.');
  }
};
function render(document: PublicationDocument, concept: boolean): string {
  if (!concept && !document.checks.some((check) => check.trim())) invalid('Provide at least one observable completion check for each build.');
  const sections = concept ? [['Destination', document.outcome], ['Change', document.change]]
    : [['Outcome', document.outcome], ['Change', document.change], ['Completion checks', list(document.checks)], ['Confirmed assumptions', list(document.assumptions)]];
  sections.push(['Decisions and reasons', list(document.decisions.map((d) => `${d.decision} ${d.reason}`))],
    ['Implementation notes', list(document.builderNotes)], ['Domain notes', list(document.domainNotes)], ['Related tickets', list(document.relatedTickets)]);
  const text = sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n');
  if (!document.title?.trim() || !document.outcome?.trim() || !document.change?.trim()
    || document.decisions.some((d) => !d.decision.trim() || !d.reason.trim())) invalid('Provide a title, outcome, change and reasons for every decision.');
  for (const link of document.relatedTickets) {
    try { const url = new URL(link); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('Related tickets need HTTP URLs without credentials.'); }
    catch { invalid('Related tickets need HTTP URLs.'); }
  }
  teamLanguage(document.title, text);
  return text;
}
/** The owning team's request, linking the user's tickets already published. */
function renderRequest(request: unknown, links: string[]): string {
  if (!isRecord(request) || ['dependencyId', 'title', 'change', 'reason', 'contract'].some((key) => typeof request[key] !== 'string' || !String(request[key]).trim())
    || !Array.isArray(request.checks) || !request.checks.length || request.checks.some((check: unknown) => typeof check !== 'string' || !check.trim())) {
    return invalid('Provide each Dependency request with a title, change, reason, contract and at least one delivery check.');
  }
  const { title, change, reason, contract, checks } = request as unknown as PublicationDependencyDocument;
  const text = [['Change', change], ['Reason', reason], ['Contract', contract], ['Delivery checks', list(checks)], ...links.length ? [['Requested by', list(links)]] : []]
    .map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n');
  teamLanguage(title, text);
  return text;
}
/** The settings snapshot of a request to a repository that isn't onboarded: plain terms and no stored consent, so approval of the exact plan is the only consent. */
const NOT_ONBOARDED = 'not-onboarded';

/** Receipt lookup always uses recorded provider results, including results carried into a replacement plan. */
function receipt(plan: PublicationPlan, workId: string): TicketReceipt | null {
  const target = plan.tickets.find((t) => t.workId === workId)?.destination;
  if (target?.ticket && target.url) return { ticket: target.ticket, url: target.url };
  const made = plan.results.find((r) => r.operation.ticketWorkId === workId && r.operation.kind === 'create' && r.status === 'successful')?.attempt;
  return made?.ticket && made.url ? { ticket: made.ticket, url: made.url } : null;
}
function terms(ticket: PublicationTicket) { return [...new Set(Object.values(ticket.vocabulary).flatMap((v) => v.labels))]; }
function consent(settings: PublicationSettings, operations: RepositoryOperation[]) {
  for (const operation of operations) {
    if (!settings.setup.consent.includes(operation) || settings.setup.access[operation] === 'refused') invalid(`${settings.setup.repo} needs separate consent and credential access for ${operation}.`);
  }
}
function checkSettings(settings: PublicationSettings) {
  if (settings.setup.paused.includes('itemSource') || settings.setup.sharedProblem || !settings.setup.itemSource) invalid(`${settings.setup.repo} has unresolved publication settings.`);
}
function mappedTicket(ticket: PublicationTicket, settings: PublicationSettings, kind: string, concept: boolean, creating = true): PublicationTicket {
  checkSettings(settings);
  const provider = onAzure(settings.setup.repo) ? 'azure' : 'github';
  if (settings.discovery.provider !== provider || (provider === 'azure') !== (settings.setup.itemSource?.kind === 'azure-board')) invalid('The effective ticket destination is inconsistent.');
  const mapped = resolveVocabulary(settings.setup.vocabulary, concept ? 'concept' : 'build',
    ['bug', 'feature', 'improvement', 'concept'].includes(kind) ? kind as 'bug' | 'feature' | 'improvement' | 'concept' : undefined, ticket.typeResolution.selected);
  if (!mapped.ready) return invalid('Resolve the exclusive type conflict before preview.');
  const type = mapped.typeResolution.selected;
  if (creating && provider === 'azure' && type === null) invalid('Azure requires a mapped work item type. Choose a team type before preview.');
  if (creating && type !== null && (settings.discovery.types.state !== 'available' || !settings.discovery.types.choices.includes(type))) invalid('The selected team type is unavailable.');
  const labels = settings.discovery.labels;
  if (creating && mapped.labels.length && (labels.state !== 'available' || mapped.labels.some((label) => !labels.choices.includes(label)))) invalid('A mapped label or tag is unavailable.');
  return { ...ticket, destination: { ...ticket.destination, repository: settings.setup.repo, provider }, settingsSnapshot: settings.snapshot,
    vocabulary: mapped.vocabulary, typeResolution: mapped.typeResolution };
}
/** A Dependency's request uses the owning repository's build Vocabulary when it is onboarded, and plain terms otherwise. */
function requestTicket(ticket: PublicationTicket, settings: PublicationSettings | null, creating: boolean): PublicationTicket {
  if (settings) return mappedTicket(ticket, settings, 'build', false, creating);
  if (creating && ticket.destination.provider === 'azure') invalid('Azure needs a mapped work item type, so a request to a project that is not onboarded is a handover.');
  return { ...ticket, settingsSnapshot: NOT_ONBOARDED, vocabulary: {}, typeResolution: { candidates: [], selected: null } };
}

/** Relationship orientation: ticketWorkId is the child/dependent; relatedWorkId is its parent/blocker.
 * Execution stops at the first failed or uncertain operation. No method retries a write automatically. */
export function publicationEngine(records: WorkRecords, dependencies: PublicationDependencies = {}) {
  const settings = dependencies.settings ?? ((repo: string) => readPublicationSettings(repo, { dir: dependencies.dir }));
  const allowed = dependencies.allowed ?? ((repo: string) => readRepositorySetups(dependencies.dir).some((setup) => sameRepo(setup.repo, repo)));
  /** A Dependency owner's settings, or null when it isn't onboarded. An onboarded owner's failed read throws. */
  const ownerSettings = (repo: string, read: (repo: string) => Promise<PublicationSettings> = settings) =>
    /^[^\s/#]+(\/[^\s/#]+)+$/.test(repo) && allowed(repo) ? read(repo) : Promise.resolve(null);
  const provider = dependencies.provider ?? publicationProvider();
  const inspectionSettings = () => {
    const reads = new Map<string, Promise<PublicationSettings>>();
    return (repo: string) => {
      const key = repo.toLowerCase();
      if (!reads.has(key)) reads.set(key, settings(repo));
      return reads.get(key)!;
    };
  };
  const refresh = async (plan: PublicationPlan): Promise<PublicationContent> => {
    const readSettings = inspectionSettings();
    return {
      tickets: await Promise.all(plan.tickets.map(async (ticket) => {
        if (!ticket.settingsSnapshot) invalid('This plan needs a fresh engine preview with effective settings.');
        const creations = plan.results.filter((r) => r.operation.kind === 'create' && r.operation.ticketWorkId === ticket.workId);
        if (ticket.dependencyOf) {
          const config = await ownerSettings(ticket.destination.repository, readSettings);
          if (creations.some((r) => r.status === 'successful')) return { ...ticket, settingsSnapshot: config?.snapshot ?? NOT_ONBOARDED };
          return requestTicket(ticket, config, creations.length > 0);
        }
        const record = records.read(ticket.workId);
        const config = await readSettings(record.repository);
        checkSettings(config);
        if (plan.results.some((r) => r.operation.kind === 'create' && r.operation.ticketWorkId === ticket.workId && r.status === 'successful')) {
          return { ...ticket, settingsSnapshot: config.snapshot };
        }
        return mappedTicket(ticket, config, record.kind, record.kind === 'concept', plan.results.some((r) => r.operation.kind === 'create' && r.operation.ticketWorkId === ticket.workId && r.status !== 'successful'));
      })), operations: plan.operations,
    };
  };
  const inspect = async (workId: string, planId: string): Promise<PublicationPending> => {
    let plan = records.publication(workId, planId);
    try {
      for (const result of plan.results.filter((item) => item.status === 'successful' && item.attempt?.verification && item.attempt.verification.status !== 'verified')) {
        const ticket = plan.tickets.find((item) => item.workId === result.operation.ticketWorkId)!;
        const target = receipt(plan, ticket.workId)!;
        let verified = false; let evidence: string;
        try {
          const stored = await provider.inspect(ticket, target);
          const differences = [
            ...(stored.ticket !== target.ticket || stored.url !== target.url ? ['ticket identity'] : []),
            ...(stored.title !== ticket.title ? ['title'] : []), ...(stored.body !== ticket.body ? ['body'] : []),
            ...(stored.type !== ticket.typeResolution.selected ? ['type'] : []),
            ...([...stored.labels].sort().join('\0') !== terms(ticket).sort().join('\0') ? ['labels or tags'] : []),
          ];
          verified = differences.length === 0;
          evidence = verified ? 'Provider inspection confirms the exact approved title, body, type and labels or tags.'
            : `The stored ${differences.join(', ')} differ from the approved content. The ticket exists at ${target.url}.`;
        } catch (error) { evidence = `The ticket exists at ${target.url}, but verification could not complete: ${reason(error)}`; }
        plan = records.recordCreationVerification(workId, planId, plan.revision, result.operation.operationId, verified, evidence);
      }
      const current = await refresh(plan);
      const check = records.pendingPublication(workId, planId, current);
      for (const { operation: op, status } of plan.results) {
        if (status !== 'pending') continue;
        const ticket = plan.tickets.find((t) => t.workId === op.ticketWorkId)!;
        if (op.kind === 'append' || op.kind === 'replace') {
          const raw = await provider.readBody(ticket, receipt(plan, ticket.workId)!, op.location.field);
          if (JSON.stringify(raw) !== JSON.stringify(op.expected)) throw new PublicationConflict({ workId: ticket.workId, stored: op.expectedText, current: raw.body, proposed: op.content, location: op.location, reason: 'The raw description, format, assignment or linked PR changed.' });
        } else if (op.kind === 'replace-comment') {
          const comment = (await provider.findComments(ticket, receipt(plan, ticket.workId)!)).find((c) => c.commentId === op.location.commentId);
          if (comment?.content !== op.expectedText) throw new PublicationConflict({ workId: ticket.workId, stored: op.expectedText, current: comment?.content ?? '', proposed: op.content, location: op.location, reason: 'The published comment changed or is missing.' });
        }
      }
      return check;
    }
    catch (error) { const check = records.pendingPublication(workId, planId); return { ...check, current: false, next: null, reasons: [...check.reasons, reason(error)], ...(error instanceof PublicationConflict ? { conflicts: [error.conflict] } : {}) }; }
  };
  const prepare = async (workId: string, request: PreparePublication): Promise<PublicationPlan> => {
    if (!isRecord(request) || !Array.isArray(request.documents)) invalid('Provide the publication documents.');
    request.documents.forEach(validateDocument);
    if (request.delivery !== undefined && (!isRecord(request.delivery) || Object.values(request.delivery).some((mode) => !['body', 'comment', 'handover'].includes(mode)))) invalid('Choose body, comment or handover delivery for each work ID.');
    if (request.resolutions !== undefined && (!isRecord(request.resolutions) || Object.values(request.resolutions).some((r) => !isRecord(r)
      || typeof r.observedText !== 'string' || typeof r.expectedText !== 'string' || !isRecord(r.location)
      || !['body', 'comment'].includes(r.location.kind)))) invalid('Provide text resolutions with observedText, expectedText and a location, indexed by work ID.');
    if (request.typeSelections !== undefined && (!isRecord(request.typeSelections) || Object.values(request.typeSelections).some((value) => value !== null && typeof value !== 'string'))) invalid('Type selections must name a team type or null.');
    if (request.dependencies !== undefined && !Array.isArray(request.dependencies)) invalid('Provide the Dependency requests as a list.');
    const ready = records.publicationReadiness(workId);
    if (!ready.eligible) invalid(ready.reasons.join(' '));
    const sources = ready.sources.filter((source) => records.read(source.workId).kind !== 'decision');
    if (!Array.isArray(request.documents) || request.documents.length !== sources.length || new Set(request.documents.map((d) => d.workId)).size !== sources.length) invalid('Provide one team document for the concept and each active build.');
    const previous = request.replaces ? records.publication(workId, request.replaces) : null;
    const tickets: PublicationTicket[] = [];
    const operations: PublicationOperation[] = [];
    const sequence = randomUUID();
    const readSettings = inspectionSettings();
    for (const source of sources) {
      const record = records.read(source.workId);
      const document = request.documents.find((d) => d.workId === source.workId) ?? invalid('A team document is missing.');
      const config = await readSettings(record.repository);
      checkSettings(config);
      const old = previous?.tickets.find((t) => t.workId === source.workId);
      if (previous && old && !old.destination.ticket && receipt(previous, source.workId) && old.title === document.title && old.body === render(document, record.kind === 'concept')
        && previous.results.some((r) => r.status !== 'successful')) {
        tickets.push({ ...old, settingsSnapshot: config.snapshot });
        operations.push(previous.operations.find((op) => op.kind === 'create' && op.ticketWorkId === source.workId)!);
        continue;
      }
      const selected = resolveVocabulary(config.setup.vocabulary, record.kind === 'concept' ? 'concept' : 'build',
        ['bug', 'feature', 'improvement', 'concept'].includes(record.kind) ? record.kind as 'bug' | 'feature' | 'improvement' | 'concept' : undefined, request.typeSelections?.[source.workId]);
      if (!selected.ready) return invalid(`Choose one team type or none for ${record.title}: ${selected.candidates.join(', ')}.`);
      const saved = records.lastPublished(record.workId).filter((item) => item.operationKind !== 'textual-relationship').at(-1);
      const known = record.ticket ?? records.publicationReceipt(record.workId)?.ticket ?? saved?.ticket ?? (previous ? receipt(previous, source.workId)?.ticket : undefined);
      const destination: PublicationTicket['destination'] = { repository: record.repository, provider: onAzure(record.repository) ? 'azure' : 'github' };
      if (known) {
        const number = known.split('#').at(-1)!;
        const [organization, project] = record.repository.split('/');
        destination.ticket = known;
        destination.url = records.publicationReceipt(record.workId)?.url ?? saved?.url ?? records.publicationAttachment(record.workId)?.url ?? (previous ? receipt(previous, source.workId)?.url : undefined)
          ?? (destination.provider === 'github' ? `https://github.com/${record.repository}/issues/${number}`
            : `https://dev.azure.com/${organization}/${encodeURIComponent(decodePart(project!))}/_workitems/edit/${number}`);
      }
      const delivery = request.delivery?.[source.workId] ?? 'body';
      const ticket = mappedTicket({ workId: source.workId, destination, vocabulary: selected.vocabulary, typeResolution: selected.typeResolution,
        title: document.title, body: render(document, record.kind === 'concept') }, config, record.kind, record.kind === 'concept', !known && delivery !== 'handover');
      tickets.push(ticket);
      if (known) operations.push(...await prepareText(provider, ticket, { ticket: known, url: destination.url! }, saved, delivery,
        `text:${source.workId}:${sequence}`, request.resolutions?.[source.workId]));
      else if (delivery === 'comment') invalid('Comment delivery needs an existing ticket.');
      else if (delivery !== 'handover') operations.push({ kind: 'create', operationId: `create:${ticket.workId}`, ticketWorkId: ticket.workId,
        dependsOn: sources[0]?.workId !== ticket.workId && records.read(workId).kind === 'concept' && operations.some((op) => op.operationId === `create:${workId}`) ? [`create:${workId}`] : [] });
    }
    const requested: { dependencyId: string; blocks: string[] }[] = [];
    for (const document of request.dependencies ?? []) {
      const dependency = records.dependency(isRecord(document) && typeof document.dependencyId === 'string' ? document.dependencyId : invalid('Name the Dependency each request is for.'));
      if (requested.some((item) => item.dependencyId === dependency.dependencyId)) invalid('Provide one request for each Dependency.');
      if (!sources.some((source) => source.workId === dependency.workId)) invalid(`The Dependency ${dependency.dependencyId} isn't held by work in this publication.`);
      if (dependency.replacedBy) invalid(`The Dependency ${dependency.dependencyId} was replaced by a build, so its team gets no request.`);
      const handoff = records.dependencyHandoff(dependency.dependencyId);
      const known = dependency.ticket ?? handoff?.ticket;
      const delivery = request.delivery?.[dependency.dependencyId] ?? 'body';
      if (handoff && delivery === 'comment') invalid('The team\'s ticket already has the request. Send revised handover text instead.');
      if (!known && delivery === 'comment') invalid('Comment delivery needs an existing ticket.');
      const repository = known ? known.slice(0, known.lastIndexOf('#')) : dependency.owner;
      const provider = onAzure(repository) ? 'azure' : 'github';
      // An owner named as a team rather than a repository, a request already handed off, and a team's own ticket the user
      // didn't choose to comment on all get handover text only.
      const writing = /^[^\s/#]+(\/[^\s/#]+)+$/.test(repository) && !handoff && delivery !== 'handover' && (known ? delivery === 'comment' : delivery === 'body');
      const config = await ownerSettings(repository, readSettings);
      const destination: PublicationTicket['destination'] = { repository, provider };
      if (known) {
        const [organization, project] = repository.split('/');
        const number = known.split('#').at(-1)!;
        destination.ticket = known;
        destination.url = handoff?.url ?? (provider === 'github' ? `https://github.com/${repository}/issues/${number}`
          : `https://dev.azure.com/${organization}/${encodeURIComponent(decodePart(project!))}/_workitems/edit/${number}`);
      }
      const selected = config ? resolveVocabulary(config.setup.vocabulary, 'build', undefined, request.typeSelections?.[dependency.dependencyId]) : null;
      if (selected && !selected.ready) return invalid(`Choose one team type or none for the request to ${repository}: ${selected.candidates.join(', ')}.`);
      const links = tickets.filter((ticket) => dependency.blocks.includes(ticket.workId) && ticket.destination.url).map((ticket) => ticket.destination.url!);
      const ticket = requestTicket({ workId: dependency.dependencyId, dependencyOf: dependency.workId, destination, vocabulary: selected?.vocabulary ?? {},
        typeResolution: selected?.typeResolution ?? { candidates: [], selected: null }, title: String(document.title), body: renderRequest(document, links) }, config, writing && !known);
      tickets.push(ticket);
      if (writing) operations.push(known ? { kind: 'comment', operationId: `request:${dependency.dependencyId}:${sequence}`, ticketWorkId: ticket.workId, dependsOn: [], content: ticket.body }
        : { kind: 'create', operationId: `create:${ticket.workId}`, ticketWorkId: ticket.workId, dependsOn: [] });
      if (known || writing) requested.push({ dependencyId: dependency.dependencyId, blocks: dependency.blocks });
    }
    const completedRelationships = records.publications(workId).flatMap((p) => p.results).filter((r) => r.status === 'successful');
    for (const ticket of tickets.filter((ticket) => !ticket.dependencyOf)) {
      const record = records.read(ticket.workId);
      const relations = [ ...(record.parentId && tickets.some((t) => t.workId === record.parentId) ? [{ workId: record.parentId, relationship: 'child' as const }] : []),
        ...records.blockers(ticket.workId).filter((b) => tickets.some((t) => t.workId === b.workId)).map((b) => ({ workId: b.workId, relationship: 'blocked-by' as const })),
        ...requested.filter((item) => item.blocks.includes(ticket.workId)).map((item) => ({ workId: item.dependencyId, relationship: 'blocked-by' as const })) ];
      for (const related of relations.filter((related) => request.delivery?.[ticket.workId] !== 'handover' && request.delivery?.[related.workId] !== 'handover'
        && !completedRelationships.some(({ operation: op }) => (op.kind === 'relationship' || op.kind === 'textual-relationship')
          && op.ticketWorkId === ticket.workId && op.relatedWorkId === related.workId && op.relationship === related.relationship))) operations.push({ kind: 'relationship', operationId: `${related.relationship}:${ticket.workId}:${related.workId}`,
        ticketWorkId: ticket.workId, relatedWorkId: related.workId, relationship: related.relationship, dependsOn: operations.filter((op) => op.kind === 'create' && [ticket.workId, related.workId].includes(op.ticketWorkId)).map((op) => op.operationId) });
    }
    return records.proposePublication(workId, records.read(workId).revision, { tickets, operations, sources: ready.sources.map(({ workId, revision }) => ({ workId, revision })), ...(request.replaces ? { replaces: request.replaces } : {}) });
  };
  const execute = async (workId: string, planId: string, identity: string): Promise<PublicationPending> => {
    while (true) {
      const check = await inspect(workId, planId);
      if (!check.current || !check.next) return check;
      const operation = check.next;
      const plan = check.plan;
      const ticket = plan.tickets.find((t) => t.workId === operation.ticketWorkId)!;
      try {
        const writeTicket = publicationWriteTicket(operation, plan.tickets);
        const config = await (writeTicket.dependencyOf ? ownerSettings : settings)(writeTicket.destination.repository);
        if (config && !writeTicket.dependencyOf) checkSettings(config);
        if ((config?.snapshot ?? NOT_ONBOARDED) !== writeTicket.settingsSnapshot) return await inspect(workId, planId);
        // Check again after all awaited reads, immediately before the atomic dispatch claim.
        const currentTicket = operation.kind !== 'create' ? ticket : ticket.dependencyOf ? requestTicket(ticket, config, true)
          : mappedTicket(ticket, config!, records.read(ticket.workId).kind, records.read(ticket.workId).kind === 'concept');
        if (JSON.stringify(currentTicket) !== JSON.stringify(ticket)) return await inspect(workId, planId);
        const needed = publicationConsents(operation, ticket);
        if (operation.kind === 'pr-closing-reference') invalid('PR closing references need the delivery extension.');
        if (config) consent(config, needed);
      } catch (error) { return { ...check, current: false, next: null, reasons: [...check.reasons, reason(error)] }; }
      let claim;
      try { claim = records.claimPublication(workId, planId, plan.revision, plan.digest, { tickets: plan.tickets, operations: plan.operations }, identity); }
      catch (error) {
        if (!(error instanceof WorkRecordError)) throw error;
        const latest = records.pendingPublication(workId, planId);
        return { ...latest, reasons: [...latest.reasons, reason(error)] };
      }
      // No catch may erase a known success after the provider has returned it.
      let outcome: import('@lar-factory/shared').PublicationOutcome;
      try {
        if (operation.kind === 'create') {
          const made = await provider.create(ticket);
          outcome = { status: 'successful', evidence: `Provider created ${made.url}. Content verification is recorded separately.`, ...made };
        } else if (operation.kind === 'relationship') {
          const related = plan.tickets.find((t) => t.workId === operation.relatedWorkId)!;
          const capability = await provider.capability(ticket, related, operation.relationship);
          if (!capability.available) throw new PublicationRefused(capability.reason);
          await provider.relate(ticket, receipt(plan, ticket.workId)!, related, receipt(plan, related.workId)!, operation.relationship);
          outcome = { status: 'successful', evidence: 'Provider accepted the approved native relationship.' };
        } else if (operation.kind === 'textual-relationship') {
          const commentId = await provider.comment(ticket, receipt(plan, ticket.workId)!, operation.content);
          outcome = { status: 'successful', evidence: 'Provider returned the approved relationship comment.', location: { kind: 'comment', commentId } };
        } else if (operation.kind === 'append' || operation.kind === 'replace') {
          await provider.writeBody(ticket, receipt(plan, ticket.workId)!, operation);
          outcome = { status: 'successful', evidence: 'Provider accepted the exact raw description edit.',
            location: { ...operation.location, end: operation.location.start + operation.content.length } };
        } else if (operation.kind === 'comment') {
          const commentId = await provider.comment(ticket, receipt(plan, ticket.workId)!, operation.content);
          outcome = { status: 'successful', evidence: 'Provider returned the approved comment.', location: { kind: 'comment', commentId } };
        } else if (operation.kind === 'replace-comment') {
          await provider.replaceComment(ticket, receipt(plan, ticket.workId)!, operation);
          outcome = { status: 'successful', evidence: 'Provider accepted the exact comment replacement.', location: operation.location };
        } else { throw new PublicationRefused('Unsupported engine operation.'); }
      } catch (error) { outcome = { status: error instanceof PublicationRefused ? 'failed' : 'uncertain', evidence: reason(error) }; }
      const latest = records.publication(workId, planId);
      records.recordPublicationOutcome(workId, planId, latest.revision, operation.operationId, claim.claimToken, outcome);
      if (outcome.status !== 'successful') return await inspect(workId, planId);
    }
  };
  /** A separate replacement preview after refusal. Exact URLs and the complete comment receive a new digest. */
  const fallback = async (workId: string, planId: string, delivery?: 'comment' | 'handover'): Promise<PublicationPlan> => {
    if (delivery !== undefined && !['comment', 'handover'].includes(delivery)) invalid('Choose comment or handover fallback.');
    const plan = records.publication(workId, planId);
    const current = await refresh(plan);
    const check = records.pendingPublication(workId, planId, current);
    if (check.uncertain.length) invalid('Resolve uncertainty before preparing a fallback.');
    if (check.reasons.some((r) => /source changed|attached or known ticket changed/.test(r))) invalid(check.reasons.join(' '));
    let changed = false;
    const operations: PublicationOperation[] = [];
    for (const result of plan.results) {
      const op = result.operation;
      if (delivery === 'handover' && result.status !== 'successful' && op.kind !== 'pr-closing-reference') { changed = true; continue; }
      if (['append', 'replace', 'replace-comment', 'comment', 'textual-relationship'].includes(op.kind) && result.status !== 'successful') {
        if (op.kind === 'comment' && op.purpose === 'notice') { changed = true; continue; }
        const mode = delivery ?? (op.kind === 'comment' || op.kind === 'textual-relationship' ? 'handover' : 'comment');
        if (mode === 'comment' && (op.kind === 'comment' || op.kind === 'textual-relationship')) invalid('A refused comment needs a handover.');
        changed = true;
        if (mode === 'comment') operations.push({ operationId: `fallback:${randomUUID()}`, kind: 'comment', ticketWorkId: op.ticketWorkId, dependsOn: [],
          content: plan.tickets.find((t) => t.workId === op.ticketWorkId)!.body });
        continue;
      }
      if (op.kind !== 'relationship' || !['failed', 'pending'].includes(result.status)) { operations.push(op); continue; }
      const target = receipt(plan, op.ticketWorkId); const related = receipt(plan, op.relatedWorkId);
      if (!target || !related) { operations.push(op); continue; }
      if (result.status === 'pending') {
        const ticket = plan.tickets.find((t) => t.workId === op.ticketWorkId)!;
        const other = plan.tickets.find((t) => t.workId === op.relatedWorkId)!;
        const config = await settings(publicationWriteTicket(op, plan.tickets).destination.repository);
        const consented = config.setup.consent.includes('relate-ticket') && config.setup.access['relate-ticket'] !== 'refused';
        if (consented && (await provider.capability(ticket, other, op.relationship)).available) { operations.push(op); continue; }
      }
      changed = true;
      operations.push({ ...op, kind: 'textual-relationship', operationId: `text:${op.operationId}`, content: `${op.relationship === 'child' ? 'Part of' : 'Depends on'} ${related.url}` });
    }
    if (!changed) invalid('No outstanding operation needs a fallback.');
    const fresh = records.pendingPublication(workId, planId, await refresh(plan));
    if (fresh.plan.revision !== plan.revision) invalid('The publication changed while preparing its fallback; inspect it again.');
    return records.proposePublication(workId, records.read(workId).revision, { ...current, operations, sources: records.publicationReadiness(workId).sources.map(({ workId, revision }) => ({ workId, revision })), replaces: planId });
  };
  /** Reads only at the provider. Creation candidates always require explicit selection; an empty search never permits retry. */
  const reconcile = async (workId: string, planId: string, identity: string, selections: ReconciliationSelection[] = []) => {
    let plan = records.publication(workId, planId);
    const candidates: { operationId: string; tickets: TicketReceipt[]; comments?: string[]; evidence: string }[] = [];
    for (const result of plan.results.filter((r) => r.status === 'uncertain')) {
      const op = result.operation; const ticket = plan.tickets.find((t) => t.workId === op.ticketWorkId)!;
      try {
        if (op.kind === 'create') {
          const selected = selections.find((s) => s.operationId === op.operationId);
          let searchEvidence = '';
          const matches = await provider.search(ticket, result.attempt!.claimedAt).catch((error) => {
            if (!selected?.url) throw error;
            searchEvidence = `Provider search failed: ${reason(error)}. `;
            return [] as TicketReceipt[];
          });
          if (selected?.url) {
            const number = selected.ticket?.slice(`${ticket.destination.repository}#`.length);
            const [org, project] = ticket.destination.repository.split('/');
            const page = ticket.destination.provider === 'github' ? `https://github.com/${ticket.destination.repository}/issues/${number}`
              : `https://dev.azure.com/${org}/${encodeURIComponent(decodePart(project!))}/_workitems/edit/${number}`;
            const url = new URL(selected.url);
            if (!selected.ticket?.startsWith(`${ticket.destination.repository}#`) || !/^[1-9]\d*$/.test(number ?? '') || url.username || url.password || `${url.origin}${url.pathname}` !== page) invalid('Supply an ordinary ticket URL in the approved destination.');
            if (!matches.some((match) => match.ticket === selected.ticket)) matches.push({ ticket: selected.ticket!, url: selected.url });
          }
          const inspected = await Promise.all(matches.map((match) => provider.inspect(ticket, match)));
          const exact = inspected.filter((item) => item.title === ticket.title && item.body === ticket.body && item.type === ticket.typeResolution.selected
            && [...item.labels].sort().join('\0') === terms(ticket).sort().join('\0'));
          const match = selected ? exact.find((item) => item.ticket === selected.ticket) : undefined;
          if (selected && !match) invalid('The selected candidate does not match the approved payload and provider search.');
          const evidence = `${searchEvidence}Searched and inspected ${matches.length} candidates; ${exact.length} match the exact approved title, body and terms. ${exact.map((m) => m.url).join(' ')} User resolution is required before any retry.`;
          plan = records.recordPublicationEvidence(workId, planId, records.publication(workId, planId).revision, op.operationId, evidence);
          if (match) plan = records.resolvePublicationOutcome(workId, planId, plan.revision, op.operationId, identity, { status: 'successful', evidence: `User selected inspected provider result ${match.url}.`, ticket: match.ticket, url: match.url, location: { kind: 'body', start: 0, end: ticket.body.length } });
          candidates.push({ operationId: op.operationId, tickets: exact.map(({ ticket, url }) => ({ ticket, url })), evidence });
        } else if (op.kind === 'relationship') {
          const related = plan.tickets.find((t) => t.workId === op.relatedWorkId)!;
          const found = await provider.hasRelationship(ticket, receipt(plan, ticket.workId)!, related, receipt(plan, related.workId)!, op.relationship);
          const evidence = found ? 'Provider inspection confirms the exact native relationship.' : 'The relationship was not confirmed. User resolution is required before any retry.';
          plan = records.recordPublicationEvidence(workId, planId, records.publication(workId, planId).revision, op.operationId, evidence);
          if (found) plan = records.resolvePublicationOutcome(workId, planId, plan.revision, op.operationId, identity, { status: 'successful', evidence });
          candidates.push({ operationId: op.operationId, tickets: [], evidence });
        } else if (op.kind === 'append' || op.kind === 'replace') {
          const current = await provider.readBody(ticket, receipt(plan, ticket.workId)!, op.location.field);
          const start = op.location.start;
          const expectedBody = op.expected ? op.expected.body.slice(0, start) + op.content + op.expected.body.slice(op.location.end) : null;
          const exact = current.body === expectedBody && current.body.indexOf(op.content) === start
            && current.body.indexOf(op.content, start + 1) < 0 && current.format === op.expected?.format;
          const evidence = exact ? 'Provider inspection confirms the exact published text at its approved location.' : 'The exact publication could not be confirmed. User resolution is required before any retry.';
          plan = records.recordPublicationEvidence(workId, planId, records.publication(workId, planId).revision, op.operationId, evidence);
          if (exact) plan = records.resolvePublicationOutcome(workId, planId, plan.revision, op.operationId, identity, { status: 'successful', evidence,
            location: { ...op.location, end: start + op.content.length } });
          candidates.push({ operationId: op.operationId, tickets: [], evidence });
        } else if (op.kind === 'textual-relationship' || op.kind === 'comment' || op.kind === 'replace-comment') {
          const comments = (await provider.findComments(ticket, receipt(plan, ticket.workId)!)).filter((comment) => comment.content === op.content && (op.kind !== 'replace-comment' || comment.commentId === op.location.commentId));
          const selected = selections.find((s) => s.operationId === op.operationId);
          const match = selected ? comments.find((comment) => comment.commentId === selected.commentId) : undefined;
          if (selected && !match) invalid('The selected comment does not match the approved content.');
          const evidence = `Inspected provider comments; ${comments.length} match the exact approved content. User resolution is required before any retry.`;
          plan = records.recordPublicationEvidence(workId, planId, records.publication(workId, planId).revision, op.operationId, evidence);
          if (match) plan = records.resolvePublicationOutcome(workId, planId, plan.revision, op.operationId, identity, { status: 'successful', evidence: `User selected inspected comment ${match.commentId}.`, location: { kind: 'comment', commentId: match.commentId } });
          candidates.push({ operationId: op.operationId, tickets: [], comments: comments.map((comment) => comment.commentId), evidence });
        } else {
          candidates.push({ operationId: op.operationId, tickets: [], evidence: 'This operation needs the existing-ticket recovery extension. No automatic retry.' });
        }
      } catch (error) {
        const evidence = `Reconciliation could not confirm the outcome: ${reason(error)}`;
        records.recordPublicationEvidence(workId, planId, records.publication(workId, planId).revision, op.operationId, evidence);
        candidates.push({ operationId: op.operationId, tickets: [], evidence });
      }
    }
    return { ...(await inspect(workId, planId)), candidates };
  };
  const retry = async (workId: string, planId: string) => {
    const plan = records.publication(workId, planId);
    const current = await refresh(plan);
    const check = records.pendingPublication(workId, planId, current);
    if (check.uncertain.length) invalid('Resolve uncertainty before previewing a retry.');
    const reasons = check.reasons.filter((reason) => reason !== 'The exact publication content needs approval.');
    if (reasons.length) invalid(reasons.join(' '));
    if (!check.failed.length) invalid('There is no failed write to retry.');
    return records.proposePublication(workId, records.read(workId).revision, { ...current, replaces: planId,
      sources: records.publicationReadiness(workId).sources.map(({ workId, revision }) => ({ workId, revision })) });
  };
  const resolveUncertain = async (workId: string, planId: string, operationId: string, identity: string, evidence: string) => {
    if (typeof evidence !== 'string' || !evidence.trim()) invalid('Describe the provider inspection before resolving an uncertain outcome.');
    const inspected = await reconcile(workId, planId, identity);
    if (!inspected.uncertain.includes(operationId)) invalid('That write is no longer uncertain. Review its stored outcome.');
    const providerEvidence = inspected.candidates.find((candidate) => candidate.operationId === operationId)?.evidence ?? invalid('Inspect the provider before resolving this write.');
    return records.resolvePublicationOutcome(workId, planId, records.publication(workId, planId).revision, operationId, identity,
      { status: 'failed', evidence: `${providerEvidence}\nUser confirmed the write did not complete: ${evidence.trim()}` });
  };
  return { prepare, inspect, execute, resume: execute, fallback, reconcile, retry, resolveUncertain };
}
