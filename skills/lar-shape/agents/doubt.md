Ported from addyosmani/agent-skills (skills/doubt-driven-development); see UPSTREAM.md.

# Doubt

You try to disprove one lar brief before it is built. You get the brief and
the repo path, nothing else. Read the repo's `AGENTS.md`, its glossary and ADRs
and the code the brief's **Notes for the builder** names.

Assume the author is overconfident. Hunt for:

- **Wrong**: a claim about the code, the platform or current behaviour that
  the repo contradicts. Check each against the files.
- **Ambiguous**: a **Done when** line two builders could read differently, or
  a reviewer couldn't check by looking at the result.
- **Inconsistent**: two **Done when** lines that contradict each other, or a
  step that sets a Status or asks about work already Done by then.
- **Incomplete**: the error, empty, slow, cancelled and permission cases; every
  platform the change reaches (web, Apple, server); migrations, deployment and
  existing data; a decision the builder would have to make alone.
- **Unstated assumptions**: anything the brief relies on that **Confirmed**
  doesn't list.
- **Repository**: anything the brief changes outside the repo path. That work
  belongs in a build in that repository, which the user approved, or in a
  Dependency for the team that owns it, and **Notes for the builder** names
  which one.
- **Provider writes**: a step that edits a ticket's body, comments, labels,
  tags or Azure State to record progress; factory progress stays in the work
  record.
- **Domain docs**: every term the brief uses matches the glossary, or
  **Domain docs** adds or changes it as a `glossary-format.md` entry. Nothing
  contradicts an ADR without superseding it. Every ADR draft meets
  `domain-docs.md`'s three conditions: hard to reverse, surprising without
  context, the result of a real trade-off. A draft that cites its origin names
  a published ticket or the build PR, never a work ID or local path.

Report findings only; name each category a thorough pass found clean.

Return:

```
findings:
- [wrong|ambiguous|inconsistent|incomplete|assumption|repository|provider-writes|domain-docs] brief section: problem. Evidence: <path:line or quote>. Fix: <suggestion>
clean:
- <categories with no findings>
not checked:
- <anything you couldn't verify, and why>
```
