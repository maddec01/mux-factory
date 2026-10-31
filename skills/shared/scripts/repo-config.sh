#!/bin/bash
# Usage: repo-config.sh <owner/repo> | <Azure repository> | --list | --connections <repository>
# <owner/repo> prints the GitHub repository's settings: its local overrides on this
# Mac over its optional .lar-factory.json, the shared defaults read from its default
# branch with gh, never from a checkout, over the built-in defaults (version 1,
# itemSource {"kind": "issues"}, labels [], domainDocs {"kind": "private"},
# skills []). role has no default, and it drops the old show setting. The local
# overrides are settings.overrides in the repository's entry of the list --list
# reads, as the board writes it; each replaces its shared default, and an absent one
# inherits it. A repository with local
# overrides needs no .lar-factory.json. When its .lar-factory.json can't be read or
# used, it falls back to the last usable copy the board kept, settings.shared, and
# says why on stderr; a logged-out gh has no fallback.
# An Azure repository is its origin URL or <org>/<project>/<repo>; its file is read
# with az the same way. Its itemSource names the team’s backlog and current sprint
# together: {"kind": "azure-board", "team": ...}.
# --list prints the onboarded repositories with their local settings, the
# repositories array of repository-settings.json in the board's data folder
# (LAR_FACTORY_DATA_DIR when it names an absolute folder, else
# ~/Library/Application Support/Lar Factory). A missing file means none: [].
# --connections <repository> prints the onboarded repositories connected to that
# onboarded one, as a JSON array named as the list names them. A Connection is a
# pair in the file's connections array, matched case-insensitively from either end;
# a pair naming a repository off the list is left out, as the board leaves it out.
# Each error exits nonzero with its reason on stderr.
set -euo pipefail

usage="usage: repo-config.sh <owner/repo> | <Azure repository> | --list | --connections <repository>"
# owner/name, each part of letters, digits, ".", "_" or "-", and neither "." nor "..". A jq regex: bash's has no lookahead.
repo_form='^(?!\.\.?/)[A-Za-z0-9._-]+/(?!\.\.?\z)[A-Za-z0-9._-]+\z'
# An Azure repository on the list: <org>/<project>/<repo> as its origin URL has them, each part as azure.sh's azure_repo
# takes it, and none "." nor "..".
azure_form='^(?!\.\.?/)[A-Za-z0-9._%~-]+/(?!\.\.?/)[A-Za-z0-9._%~-]+/(?!\.\.?\z)[A-Za-z0-9._%~-]+\z'
arg=${1:-}

data_dir="$HOME/Library/Application Support/Lar Factory"
[[ ${LAR_FACTORY_DATA_DIR:-} != /* ]] || data_dir=$LAR_FACTORY_DATA_DIR
list_file="$data_dir/repository-settings.json"
# list: prints the repositories array of list_file, [] when it is missing.
list() {
    local problem
    if [[ ! -e $list_file ]]; then
        echo '[]'
        return 0
    fi
    if ! jq empty "$list_file" 2>/dev/null; then
        echo "$list_file isn't valid JSON." >&2
        return 1
    fi
    problem=$(jq -r '
        if type != "object" or (.repositories | type) != "array" then
            "expected an object with a repositories array, like {\"repositories\": [{\"repo\": \"owner/name\"}]}"
        else
            first(.repositories | to_entries[]
                | select((.value | type) != "object" or (.value.repo | type) != "string"
                    or (.value.repo | test($repo_form) or test($azure_form) | not))
                | "repositories[\(.key)] needs a repo of the form owner/name") // empty
        end' --arg repo_form "$repo_form" --arg azure_form "$azure_form" "$list_file")
    if [[ -n $problem ]]; then
        echo "$list_file: $problem." >&2
        return 1
    fi
    jq '.repositories' "$list_file"
}

if [[ $arg == --list ]]; then
    list
    exit 0
fi

if [[ $arg == --connections ]]; then
    repo=${2:-}
    if [[ -z $repo ]]; then
        echo "$usage" >&2
        exit 1
    fi
    repositories=$(list)
    if ! jq -e --arg repo "$repo" 'any(.[]; .repo | ascii_downcase == ($repo | ascii_downcase))' <<<"$repositories" >/dev/null; then
        echo "$repo isn't onboarded." >&2
        exit 1
    fi
    jq --arg repo "$repo" --argjson repos "$repositories" '
        def listed($name): first($repos[] | .repo | select(ascii_downcase == ($name | ascii_downcase))) // null;
        [(.connections // []) | if type == "array" then .[] else empty end
            | select(type == "array" and length == 2 and all(.[]; type == "string"))
            | map(listed(.)) | select(all(.[]; . != null) and (.[0] | ascii_downcase) != (.[1] | ascii_downcase))
            | if (.[0] | ascii_downcase) == ($repo | ascii_downcase) then .[1]
              elif (.[1] | ascii_downcase) == ($repo | ascii_downcase) then .[0] else empty end]
        | unique_by(ascii_downcase) as $found | [$repos[] | .repo | select(IN($found[]))]' "$list_file"
    exit 0
fi

err=$(mktemp)
trap 'rm -f "$err"' EXIT
read_status=0
# Why the shared file can't be used, when it can't; the last usable copy stands in for it.
shared_problem=
if jq -en --arg repo "$arg" --arg repo_form "$repo_form" '$repo | test($repo_form)' >/dev/null; then
    provider=github repo=$arg
    # Without ref, the contents API reads the default branch.
    raw=$(gh api -H "Accept: application/vnd.github.raw" "repos/$repo/contents/.lar-factory.json" 2>"$err") || read_status=$?
    if ((read_status != 0)); then
        if [[ $read_status == 4 || $(cat "$err") == *"gh auth login"* ]]; then
            echo "gh is logged out. Run gh auth login, then rerun." >&2
            exit 1
        elif [[ $(cat "$err") != *"HTTP 404"* ]]; then
            shared_problem="could not read .lar-factory.json. $(cat "$err")"
        fi
        raw=null
    fi
else
    # shellcheck source-path=SCRIPTDIR source=azure.sh
    source "$(dirname "$0")/azure.sh"
    if ! azure_repo "$arg"; then
        echo "$usage" >&2
        exit 1
    fi
    provider=azure repo="${az_org##*/}/$az_project/$az_repo"
    # Without versionDescriptor, the items API reads the default branch.
    raw=$(az devops invoke --area git --resource items --organization "$az_org" \
        --route-parameters "project=$(percent_decode "$az_project")" "repositoryId=$(percent_decode "$az_repo")" \
        --query-parameters path=/.lar-factory.json includeContent=true \
        --api-version 7.1 --output json 2>"$err") || read_status=$?
    if ((read_status != 0)); then
        # TF401174 is Azure's "item could not be found".
        if [[ $(cat "$err") != *TF401174* ]]; then
            shared_problem=$(az_failure "could not read .lar-factory.json" "$(cat "$err")")
        fi
        raw=null
    elif ! raw=$(jq -er '.content | strings' <<<"$raw" 2>/dev/null); then
        shared_problem="could not read .lar-factory.json. az returned no file content"
        raw=null
    fi
fi

if [[ -z $shared_problem ]] && ! jq empty <<<"$raw" 2>/dev/null; then
    shared_problem=".lar-factory.json isn't valid JSON"
    raw=null
fi
repositories=$(list)
entry=$(jq --arg repo "$repo" 'first(.[] | select(.repo | ascii_downcase == ($repo | ascii_downcase))) // null' <<<"$repositories")
local_settings=$(jq 'if . == null then null else .settings.overrides // {} end' <<<"$entry")
# problem: why one source's fields can't be settings, or nothing when they can.
fields='def problem:
    if type != "object" then "isn'"'"'t a JSON object"
    elif has("version") and (.version | type) != "number" then "field version must be a number"
    elif has("role") and ((.role | type) != "string" or .role == "") then "field role must be a non-empty string"
    elif has("itemSource") and (.itemSource | type) != "object" then "field itemSource must be an object"
    elif has("labels") and ((.labels | type) != "array" or any(.labels[]; type != "string")) then
        "field labels must be an array of strings"
    elif has("domainDocs") and (.domainDocs | type != "object" or (.kind != "private"
        and (.kind != "repository" or (.glossary | type) != "string" or (.adrs | type) != "string"))) then
        "field domainDocs must be {\"kind\": \"private\"} or name the repository'"'"'s glossary and adrs paths"
    elif has("skills") and ((.skills | type) != "array" or any(.skills[]; type != "string")) then
        "field skills must be an array of strings"
    else empty end;'
if [[ -z $shared_problem ]]; then
    shared_problem=$(jq -rn --argjson shared "$raw" "$fields"'
        if $shared != null and ($shared | problem) then ".lar-factory.json \($shared | problem)" else empty end')
fi
if [[ -n $shared_problem ]]; then
    raw=$(jq '.settings.shared // null' <<<"$entry")
    if [[ $raw == null ]]; then
        echo "$repo: ${shared_problem%.}." >&2
        exit 1
    fi
    echo "$repo: ${shared_problem%.}. Using the last usable copy on this Mac." >&2
fi
if [[ $raw == null && $local_settings == null ]]; then
    echo "$repo isn't onboarded on this Mac and has no .lar-factory.json on its default branch." >&2
    exit 1
fi
problem=$(jq -rn --argjson shared "$raw" --argjson local "$local_settings" --arg list_file "$list_file" "$fields"'
    if $shared != null and ($shared | problem) then "its last usable .lar-factory.json in \($list_file): \($shared | problem)"
    elif $local != null and ($local | problem) then "its local overrides in \($list_file): \($local | problem)"
    else empty end')
if [[ -n $problem ]]; then
    echo "$repo: $problem." >&2
    exit 1
fi
settings=$(jq -n --argjson shared "$raw" --argjson local "$local_settings" '
    {version: 1, role: null, itemSource: {kind: "issues"}, labels: [], domainDocs: {kind: "private"}, skills: []}
    + ($shared // {} | del(.show)) + ($local // {} | with_entries(select(.key | IN("role", "itemSource", "labels", "domainDocs", "skills"))))')
problem=$(jq -r --arg provider "$provider" '
    if (.role | type) != "string" then "no role in its local overrides or .lar-factory.json"
    elif ($provider == "github" and .itemSource.kind != "issues") or ($provider == "azure" and .itemSource.kind != "azure-board") then
        "an unsupported item source. Run onboarding again"
    elif $provider == "azure" and ((.itemSource.team | type) != "string" or .itemSource.team == "") then
        "no itemSource.team to name the team for an azure-board"
    else empty end' <<<"$settings")
if [[ -n $problem ]]; then
    echo "$repo has $problem." >&2
    exit 1
fi
echo "$settings"
