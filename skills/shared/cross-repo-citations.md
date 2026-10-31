# Cross-repository citations

When a commit message, PR title or PR body refers to work in another
repository, cite it this way:

- Cite that work's PR (`owner/repo#n`, or on Azure DevOps its web URL), open or
  merged, or its published ticket when it has no PR yet.
- Never cite a work ID or a local path: the reader has neither the record nor
  the machine. Never cite a commit SHA or a branch name either: a rebase drops
  SHAs, and a branch can be renamed or deleted after merge.
- On Azure DevOps a PR's web URL is its `repository.webUrl` from
  `az repos pr show --id <PR id> --organization <org>`, then
  `/pullrequest/<PR id>`.
- Work in another repository becomes a build there or a Dependency, per
  [Other repositories](issue-tracker/work-records.md#other-repositories). Once
  a Dependency's request reaches the owning team, cite that team's ticket. An
  implementer that finds work another repository needs, with
  no PR or published ticket covering it, reports
  `needs <owner/repo>: <the work>` and cites nothing.
