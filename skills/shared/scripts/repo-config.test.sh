#!/usr/bin/env bash
# Tests repo-config.sh's forms against a fake gh, a fake az and a temporary HOME. No network.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo_config_sh="$here/repo-config.sh"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# A fake gh that answers only the raw read of .lar-factory.json from the default
# branch. It prints the file "$FAKE_FILES/<owner>/<name>", or GitHub's 404 when
# that file is missing. With FAKE_LOGGED_OUT set it fails as a logged-out gh does.
bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT
export FAKE_FILES="$bin/files"
cat >"$bin/gh" <<'GH'
#!/bin/bash
if [[ -n ${FAKE_LOGGED_OUT:-} ]]; then
    printf 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n' >&2
    exit 4
fi
if [[ "$*" =~ ^api\ -H\ Accept:\ application/vnd\.github\.raw\ repos/([^/]+)/([^/]+)/contents/\.lar-factory\.json$ ]]; then
    file="$FAKE_FILES/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    if [[ -f $file ]]; then cat "$file"; exit 0; fi
    echo '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/contents#get-repository-content","status":"404"}'
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
fi
echo "fake gh: unexpected $*" >&2
exit 1
GH
# A fake az that answers only the git items read of .lar-factory.json, without a
# version, so from the default branch. It logs its arguments to $FAKE_AZ_LOG and
# prints the item with the file "$FAKE_FILES/<org>/<project>/<repo>" as its
# content, or Azure's TF401174 when that file is missing. With FAKE_LOGGED_OUT set
# it fails as a logged-out az does, and with FAKE_NO_EXTENSION as one without the
# azure-devops extension.
cat >"$bin/az" <<'AZ'
#!/bin/bash
printf '%s\n' "$*" >>"$FAKE_AZ_LOG"
if [[ -n ${FAKE_NO_EXTENSION:-} ]]; then
    echo "ERROR: 'devops' is misspelled or not recognized by the system." >&2
    exit 2
fi
if [[ -n ${FAKE_LOGGED_OUT:-} ]]; then
    echo "ERROR: Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials." >&2
    exit 1
fi
pattern='^devops invoke --area git --resource items --organization https://dev\.azure\.com/([^ ]+) --route-parameters project=(.+) repositoryId=([^ ]+) --query-parameters path=/\.lar-factory\.json includeContent=true --api-version 7\.1 --output json$'
if [[ "$*" =~ $pattern ]]; then
    file="$FAKE_FILES/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"
    if [[ -f $file ]]; then jq -n --rawfile content "$file" '{objectId: "abc", path: "/.lar-factory.json", content: $content}'; exit 0; fi
    echo "ERROR: TF401174: The item '/.lar-factory.json' could not be found in the repository '${BASH_REMATCH[3]}' at the version specified by '<Default branch>'." >&2
    exit 1
fi
echo "fake az: unexpected $*" >&2
exit 1
AZ
chmod +x "$bin/gh" "$bin/az"
export FAKE_AZ_LOG="$bin/az-log"
export PATH="$bin:$PATH" HOME="$bin/home"
data="$HOME/Library/Application Support/Lar Factory"
list_file="$data/repository-settings.json"

# file <owner/name> <json>: puts .lar-factory.json on that repository's default branch.
file() { mkdir -p "$FAKE_FILES/${1%/*}"; printf '%s' "$2" >"$FAKE_FILES/$1"; }
# run <args>: runs repo-config.sh, sets $output, $errors and $status.
run() {
    status=0
    output=$(bash "$repo_config_sh" "$@" 2>"$bin/err") || status=$?
    errors=$(cat "$bin/err")
}
# check <name> <expected JSON>: passes when the run succeeded and printed that JSON.
check() {
    if ((status == 0)) && [[ -z $errors ]] && jq -e --argjson want "$2" '. == $want' <<<"$output" >/dev/null 2>&1; then
        pass "$1"
    else
        fail "$1: $status $output / $errors"
    fi
}
# falls_back <name> <expected JSON> <text>: passes when the run succeeded, printed that JSON and named the text on stderr.
falls_back() {
    if ((status == 0)) && [[ $errors == *"$3"* ]] && jq -e --argjson want "$2" '. == $want' <<<"$output" >/dev/null 2>&1; then
        pass "$1"
    else
        fail "$1: $status $output / $errors"
    fi
}
# refuses <name> <text>: passes when the run failed, printed nothing and named the text on stderr.
refuses() {
    if ((status != 0)) && [[ -z $output && $errors == *"$2"* ]]; then
        pass "$1"
    else
        fail "$1: $status $output / $errors"
    fi
}

# --list

run --list
check "with no repository-settings.json, --list prints []" '[]'

mkdir -p "$data"
echo '{"repositories":[{"repo":"maddec01/lar-factory"},{"repo":"maddec01/lar-server","onboarding":{"step":"setup","done":["project"],"answers":{"projectId":"lar-server"}}}]}' >"$list_file"
run --list
check "--list prints the repositories array, an entry still onboarding with its progress" '[{"repo":"maddec01/lar-factory"},{"repo":"maddec01/lar-server","onboarding":{"step":"setup","done":["project"],"answers":{"projectId":"lar-server"}}}]'

FAKE_LOGGED_OUT=1 run --list
check "--list doesn't need gh" '[{"repo":"maddec01/lar-factory"},{"repo":"maddec01/lar-server","onboarding":{"step":"setup","done":["project"],"answers":{"projectId":"lar-server"}}}]'

entry='{"repo":"maddec01/lar-web","settings":{"overrides":{"role":"web"},"consent":["open-pr"]}}'
echo "{\"repositories\":[$entry]}" >"$list_file"
run --list
check "--list prints each entry with its local settings" "[$entry]"

old="$data/repositories.json"
echo '{"repositories":[{"repo":"maddec01/lar-old"}]}' >"$old"
run --list
check "--list never reads the old repositories.json" "[$entry]"

LAR_FACTORY_DATA_DIR="$bin/elsewhere" run --list
check "--list reads the data folder LAR_FACTORY_DATA_DIR names" '[]'
LAR_FACTORY_DATA_DIR=relative run --list
check "a relative LAR_FACTORY_DATA_DIR is ignored" "[$entry]"
rm "$old"

# --connections

echo '{"repositories":[{"repo":"maddec01/lar-factory"},{"repo":"maddec01/lar-server"},{"repo":"maddec01/Lar-Web"}],
  "connections":[["maddec01/lar-server","maddec01/lar-factory"],["maddec01/lar-web","maddec01/LAR-FACTORY"],
  ["maddec01/lar-factory","maddec01/lar-server"],["maddec01/lar-factory","maddec01/gone"],["maddec01/lar-factory"],
  ["maddec01/lar-factory","maddec01/lar-factory"],"maddec01/lar-server"]}' >"$list_file"
run --connections maddec01/LAR-factory
check "--connections prints each listed repository paired with the repository once, named as the list names it" \
    '["maddec01/lar-server","maddec01/Lar-Web"]'
run --connections maddec01/lar-server
check "a Connection is one pair, read from either end" '["maddec01/lar-factory"]'
echo '{"repositories":[{"repo":"maddec01/lar-factory"}]}' >"$list_file"
run --connections maddec01/lar-factory
check "a list with no connections prints []" '[]'
run --connections maddec01/elsewhere
refuses "--connections refuses a repository that isn't onboarded" "maddec01/elsewhere isn't onboarded"
run --connections
refuses "--connections needs a repository" "usage: repo-config.sh"

echo '{"repositories": [' >"$list_file"
run --list
refuses "a repository-settings.json that isn't JSON names the file" "$list_file isn't valid JSON"

echo '[]' >"$list_file"
run --list
refuses "a repository-settings.json that isn't an object names the file and the problem" "$list_file: expected an object with a repositories array"

echo '{"repositories":{}}' >"$list_file"
run --list
refuses "a repositories that isn't an array names the file and the problem" "$list_file: expected an object with a repositories array"

echo '{"repositories":[{"repo":"maddec01/lar-factory"},"maddec01/lar-server"]}' >"$list_file"
run --list
refuses "an entry that isn't an object names the file and the entry" "$list_file: repositories[1] needs a repo of the form owner/name"

echo '{"repositories":[{"repo":"lar-server"}]}' >"$list_file"
run --list
refuses "an entry without owner/name names the file and the entry" "$list_file: repositories[0] needs a repo of the form owner/name"

echo '{"repositories":[{"repo":"maddec01/.."}]}' >"$list_file"
run --list
refuses "an entry whose name is .. names the file and the entry" "$list_file: repositories[0] needs a repo of the form owner/name"

echo '{"repositories":[{"repo":"maddec01/lar?x"}]}' >"$list_file"
run --list
refuses "an entry with a ? in its name names the file and the entry" "$list_file: repositories[0] needs a repo of the form owner/name"

printf '%s' '{"repositories":[{"repo":"maddec01/lar-server\n"}]}' >"$list_file"
run --list
refuses "an entry ending in a newline names the file and the entry" "$list_file: repositories[0] needs a repo of the form owner/name"

echo '{"repositories":[{"repo":"maddec01/lar-factory"},{"repo":"contoso/Fabrikam%20Fiber/lar-api"}]}' >"$list_file"
run --list
check "lists an Azure DevOps repository as organization/project/repository" '[{"repo":"maddec01/lar-factory"},{"repo":"contoso/Fabrikam%20Fiber/lar-api"}]'

for bad in contoso/Fabrikam/lar-api/x contoso/../lar-api contoso/Fabrikam/.. 'contoso/Fabrikam Fiber/lar-api'; do
    echo "{\"repositories\":[{\"repo\":\"$bad\"}]}" >"$list_file"
    run --list
    refuses "an Azure DevOps entry $bad names the file and the entry" "$list_file: repositories[0] needs a repo of the form owner/name"
done

# <owner/repo>

rm "$list_file"

file maddec01/lar-factory '{"role":"factory"}'
run maddec01/lar-factory
check "fills in the defaults" '{"version":1,"role":"factory","itemSource":{"kind":"issues"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}'

file maddec01/lar-server '{"version":1,"role":"server","itemSource":{"kind":"issues"},"show":"opted-in","labels":["area-api"],"domainDocs":{"kind":"private"},"skills":[]}'
run maddec01/lar-server
check "keeps the fields the file sets" '{"version":1,"role":"server","itemSource":{"kind":"issues"},"labels":["area-api"],"domainDocs":{"kind":"private"},"skills":[]}'

run maddec01/lar-apple
refuses "a repository with neither local settings nor .lar-factory.json says it isn't onboarded" "maddec01/lar-apple isn't onboarded on this Mac and has no .lar-factory.json on its default branch"

file maddec01/broken '{"role": '
run maddec01/broken
refuses "a file that doesn't parse names the repository" "maddec01/broken: .lar-factory.json isn't valid JSON"

file maddec01/broken '["factory"]'
run maddec01/broken
refuses "a file that isn't an object names the repository" "maddec01/broken: .lar-factory.json isn't a JSON object"

file maddec01/broken '{"show":"all"}'
run maddec01/broken
refuses "a file without role, and no local role, names the missing role" "maddec01/broken has no role in its local overrides or .lar-factory.json"

file maddec01/broken '{"role":"factory","itemSource":{"kind":"azure-boards"}}'
run maddec01/broken
refuses "an unknown item source kind asks for onboarding" "maddec01/broken has an unsupported item source. Run onboarding again."

file maddec01/broken '{"role":"factory","show":"some"}'
run maddec01/broken
check "ignores the old show setting, whatever its value" '{"version":1,"role":"factory","itemSource":{"kind":"issues"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}'

file maddec01/broken '{"role":"factory","labels":"area-api"}'
run maddec01/broken
refuses "labels that aren't an array of strings names labels" "maddec01/broken: .lar-factory.json field labels"

file maddec01/broken '{"version":"1","role":"factory"}'
run maddec01/broken
refuses "a version that isn't a number names version" "maddec01/broken: .lar-factory.json field version"

# A repository whose .lar-factory.json can't be used falls back to the last usable copy the board kept, and says why.
echo '{"repositories":[{"repo":"maddec01/broken","settings":{"shared":{"role":"kept","show":"opted-in"},"overrides":{"labels":["web"]}}}]}' >"$list_file"
kept='{"version":1,"role":"kept","itemSource":{"kind":"issues"},"labels":["web"],"domainDocs":{"kind":"private"},"skills":[]}'
file maddec01/broken '{"role": '
run maddec01/broken
falls_back "a file that doesn't parse falls back to the last usable copy, saying why" "$kept" \
    "maddec01/broken: .lar-factory.json isn't valid JSON. Using the last usable copy on this Mac."
file maddec01/broken '{"role":"factory","labels":"area-api"}'
run maddec01/broken
falls_back "a file with a wrong field falls back to the last usable copy, naming the field" "$kept" "maddec01/broken: .lar-factory.json field labels"
FAKE_LOGGED_OUT=1 run maddec01/broken
refuses "with gh logged out, there is no fallback" "gh auth login"
rm "$list_file"

FAKE_LOGGED_OUT=1 run maddec01/lar-factory
refuses "with gh logged out, says to run gh auth login" "gh auth login"

run lar-factory
refuses "a repository not of the form owner/name shows the usage" "usage: repo-config.sh"

for bad in ../lar-factory maddec01/.. maddec01/. 'maddec01/lar?x' 'maddec01/lar#x' $'maddec01/lar-factory\n'; do
    run "$bad"
    refuses "a repository $bad shows the usage" "usage: repo-config.sh"
done

run
refuses "no argument shows the usage" "usage: repo-config.sh"

# An Azure repository

sprint='{"role":"web","itemSource":{"kind":"azure-board","team":"Web Team"},"show":"all"}'
file contoso/Fabrikam/web "$sprint"
want='{"version":1,"role":"web","itemSource":{"kind":"azure-board","team":"Web Team"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}'
for origin in https://dev.azure.com/contoso/Fabrikam/_git/web https://contoso@dev.azure.com/contoso/Fabrikam/_git/web \
    git@ssh.dev.azure.com:v3/contoso/Fabrikam/web https://contoso.visualstudio.com/Fabrikam/_git/web contoso/Fabrikam/web; do
    : >"$FAKE_AZ_LOG"
    run "$origin"
    check "reads an Azure repository's file with az from $origin" "$want"
done
if [[ $(wc -l <"$FAKE_AZ_LOG") -eq 1 ]]; then pass "reads the file in one az call"; else fail "reads the file in one az call: $(cat "$FAKE_AZ_LOG")"; fi

file "contoso/Fabrikam Fiber/web" "$sprint"
run "https://dev.azure.com/contoso/Fabrikam%20Fiber/_git/web"
check "passes a percent-encoded project name to az as its name" "$want"

file contoso/Fabrikam/api '{"role":"api","itemSource":{"kind":"azure-board","team":"API"},"show":"opted-in","labels":["area-api"]}'
run contoso/Fabrikam/api
check "keeps a combined Azure board source" '{"version":1,"role":"api","itemSource":{"kind":"azure-board","team":"API"},"labels":["area-api"],"domainDocs":{"kind":"private"},"skills":[]}'

file contoso/Fabrikam/board '{"role":"api","itemSource":{"kind":"azure-board","team":"API"}}'
run contoso/Fabrikam/board
check "reads the combined Azure board" '{"version":1,"role":"api","itemSource":{"kind":"azure-board","team":"API"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}'

run contoso/Fabrikam/missing
refuses "an Azure repository with neither local settings nor a file says it isn't onboarded" "contoso/Fabrikam/missing isn't onboarded on this Mac and has no .lar-factory.json on its default branch"

file contoso/Fabrikam/broken '{"role": '
run contoso/Fabrikam/broken
refuses "an Azure file that doesn't parse names the repository" "contoso/Fabrikam/broken: .lar-factory.json isn't valid JSON"

file contoso/Fabrikam/broken '{"role":"web"}'
run contoso/Fabrikam/broken
refuses "an Azure repository has no default item source" "contoso/Fabrikam/broken has an unsupported item source. Run onboarding again."

file contoso/Fabrikam/broken '{"role":"web","itemSource":{"kind":"issues"}}'
run contoso/Fabrikam/broken
refuses "an Azure repository can't read GitHub issues" "contoso/Fabrikam/broken has an unsupported item source. Run onboarding again."

file contoso/Fabrikam/broken '{"role":"web","itemSource":{"kind":"azure-board"}}'
run contoso/Fabrikam/broken
refuses "an azure-board without team names itemSource.team" "contoso/Fabrikam/broken has no itemSource.team to name the team for an azure-board"
file contoso/Fabrikam/broken '{"role":"web","itemSource":{"kind":"azure-board","team":""}}'
run contoso/Fabrikam/broken
refuses "an azure-board with an empty team names itemSource.team" "has no itemSource.team to name the team"

file maddec01/broken '{"role":"factory","itemSource":{"kind":"azure-board","team":"Web"}}'
run maddec01/broken
refuses "a GitHub repository can't read an Azure sprint" "maddec01/broken has an unsupported item source. Run onboarding again."

FAKE_LOGGED_OUT=1 run contoso/Fabrikam/web
refuses "with az logged out, says to run az login" "az is logged out. Run az login"

FAKE_NO_EXTENSION=1 run contoso/Fabrikam/web
refuses "without the azure-devops extension, says to add it" "az extension add --name azure-devops"

echo '{"repositories":[{"repo":"contoso/Fabrikam/web","settings":{"shared":{"role":"kept","itemSource":{"kind":"azure-board","team":"Web Team"}}}}]}' >"$list_file"
FAKE_LOGGED_OUT=1 run contoso/Fabrikam/web
falls_back "with az logged out, an Azure repository falls back to the last usable copy, saying to run az login" \
    '{"version":1,"role":"kept","itemSource":{"kind":"azure-board","team":"Web Team"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}' \
    "az is logged out. Run az login"
rm "$list_file"

for bad in https://dev.azure.com/contoso/Fabrikam/web https://dev.azure.com/contoso/../_git/web contoso/../web 'contoso/Fabrikam/we b' a/b/c/d \
    contoso/Fabrikam%2F..%2Fx/web contoso/%2E%2E/web contoso/Fabrikam/%5Cweb; do
    run "$bad"
    refuses "an Azure repository $bad shows the usage" "usage: repo-config.sh"
done

for kind in github-project azure-sprint azure-backlog unknown; do
    for repo in maddec01/broken contoso/Fabrikam/broken; do
        file "$repo" "{\"role\":\"web\",\"itemSource\":{\"kind\":\"$kind\",\"team\":\"Team\"}}"
        run "$repo"
        refuses "removed or unknown $kind asks for onboarding on $repo" "$repo has an unsupported item source. Run onboarding again."
    done
done

# Local overrides over optional shared defaults

rm -rf "$FAKE_FILES"
echo '{"repositories":[{"repo":"maddec01/no-files","settings":{"projectId":"p1","overrides":{"role":"app","show":"opted-in","skills":["web"]}}}]}' >"$list_file"
run maddec01/no-files
check "a repository with local overrides and no .lar-factory.json works from them" '{"version":1,"role":"app","itemSource":{"kind":"issues"},"labels":[],"domainDocs":{"kind":"private"},"skills":["web"]}'

file maddec01/no-files '{"role":"shared role","show":"all","labels":["area-api"],"skills":["tdd"],"domainDocs":{"kind":"repository","glossary":"GLOSSARY.md","adrs":"docs/adr"}}'
run maddec01/no-files
check "each local override replaces its shared default, and the rest inherit" '{"version":1,"role":"app","itemSource":{"kind":"issues"},"labels":["area-api"],"domainDocs":{"kind":"repository","glossary":"GLOSSARY.md","adrs":"docs/adr"},"skills":["web"]}'

echo '{"repositories":[{"repo":"maddec01/no-files","settings":{"overrides":{"skills":["web"]}}}]}' >"$list_file"
run maddec01/no-files
check "removing a local override inherits the shared default again" '{"version":1,"role":"shared role","itemSource":{"kind":"issues"},"labels":["area-api"],"domainDocs":{"kind":"repository","glossary":"GLOSSARY.md","adrs":"docs/adr"},"skills":["web"]}'

rm -rf "$FAKE_FILES"
run maddec01/no-files
refuses "local overrides without a role, and no file, name the missing role" "maddec01/no-files has no role in its local overrides or .lar-factory.json"

echo '{"repositories":[{"repo":"maddec01/no-files","settings":{"overrides":{"role":"app","labels":"x"}}}]}' >"$list_file"
run maddec01/no-files
refuses "a bad local override names the settings file and the field" "maddec01/no-files: its local overrides in $list_file: field labels"

echo '{"repositories":[{"repo":"contoso/Fabrikam/local","settings":{"overrides":{"role":"web","itemSource":{"kind":"azure-board","team":"Web Team"}}}}]}' >"$list_file"
run https://dev.azure.com/contoso/Fabrikam/_git/local
check "an Azure repository with local overrides and no file works from them" '{"version":1,"role":"web","itemSource":{"kind":"azure-board","team":"Web Team"},"labels":[],"domainDocs":{"kind":"private"},"skills":[]}'

echo '{"repositories": [' >"$list_file"
file maddec01/lar-factory '{"role":"factory"}'
run maddec01/lar-factory
refuses "a settings file that isn't JSON stops a repository read too" "$list_file isn't valid JSON"
rm "$list_file"

((failures == 0))
