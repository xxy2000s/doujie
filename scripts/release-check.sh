#!/usr/bin/env bash
set -euo pipefail

phase="prepare"
expected_version=""
remote_host=""

usage() {
  cat <<'EOF'
Usage: scripts/release-check.sh [--phase prepare|published] [--version X.Y.Z] [--remote SSH_HOST]

Read-only release gate. It does not install, commit, tag, push, switch branches,
change files, or restart services.
EOF
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

while (($#)); do
  case "$1" in
    --)
      shift
      ;;
    --phase)
      (($# >= 2)) || fail '--phase requires a value'
      phase="$2"
      shift 2
      ;;
    --version)
      (($# >= 2)) || fail '--version requires a value'
      expected_version="$2"
      shift 2
      ;;
    --remote)
      (($# >= 2)) || fail '--remote requires an SSH host'
      remote_host="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$phase" == "prepare" || "$phase" == "published" ]] || fail 'phase must be prepare or published'

for command in git node pnpm rg; do
  command -v "$command" >/dev/null || fail "required command not found: $command"
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'not inside a Git repository'
cd "$repo_root"

[[ "$(git branch --show-current)" == "master" ]] || fail 'release checks must run on master'
[[ -z "$(git status --porcelain=v1)" ]] || fail 'working tree is not clean'
pass 'master working tree is clean'

package_version=$(node -p "require('./package.json').version")
[[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || fail "invalid package version: $package_version"
if [[ -n "$expected_version" ]]; then
  [[ "$package_version" == "$expected_version" ]] || fail "package version $package_version does not match expected $expected_version"
fi
expected_version=${expected_version:-$package_version}
tag="v$expected_version"

rg -q "^## \[$expected_version\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || fail "CHANGELOG.md has no dated $expected_version section"
rg -q "^\[$expected_version\]: " CHANGELOG.md || fail "CHANGELOG.md has no $expected_version link"
pass "package and Changelog agree on $expected_version"

pinned_pnpm=$(node -p "require('./package.json').packageManager || ''")
[[ "$pinned_pnpm" == pnpm@* ]] || fail 'package.json must pin packageManager to pnpm@<version>'
actual_pnpm=$(pnpm --version)
[[ "pnpm@$actual_pnpm" == "$pinned_pnpm" ]] || fail "pnpm $actual_pnpm does not match $pinned_pnpm"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[[ "$node_major" == "20" ]] || fail "Node 20 is required; found $(node --version)"
rg -q '^allowBuilds:$' pnpm-workspace.yaml || fail 'pnpm-workspace.yaml must declare allowBuilds'
rg -q '^  better-sqlite3: true$' pnpm-workspace.yaml || fail 'better-sqlite3 build is not explicitly allowed'
rg -q '^  esbuild: true$' pnpm-workspace.yaml || fail 'esbuild build is not explicitly allowed'
pass "runtime tools match Node $(node --version) and $pinned_pnpm"

tracked_sensitive=$(git ls-files \
  | rg '(^|/)(\.env($|\.)|.*\.(db|sqlite|sqlite3|log)$|config\.ya?ml$|id_rsa$|id_ed25519$)' \
  | rg -v '(^|/)\.env\.(example|sample|template)$' \
  || true)
[[ -z "$tracked_sensitive" ]] || fail "sensitive runtime-like files are tracked: $tracked_sensitive"

secret_files=$(git ls-files -z | xargs -0 rg -l --no-messages '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(app_secret|access_token|tenant_access_token)[[:space:]]*[:=][[:space:]]*[^$<{[:space:]])' || true)
[[ -z "$secret_files" ]] || fail "possible secrets found in tracked files: $secret_files"
pass 'tracked-file secret and runtime-artifact scan passed'

if [[ "$phase" == "prepare" ]]; then
  ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "tag $tag already exists"
  pass "tag $tag is available"
else
  git rev-parse -q --verify "refs/tags/$tag^{}" >/dev/null || fail "annotated tag $tag does not exist"
  git fetch --dry-run origin >/dev/null 2>&1 || fail 'origin is not reachable'
  local_head=$(git rev-parse HEAD)
  remote_master=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  remote_release=$(git ls-remote origin refs/heads/release | awk '{print $1}')
  tag_commit=$(git rev-parse "$tag^{}")
  [[ -n "$remote_master" && "$local_head" == "$remote_master" ]] || fail 'local master and origin/master differ'
  [[ "$local_head" == "$remote_release" ]] || fail 'origin/release does not equal master'
  [[ "$local_head" == "$tag_commit" ]] || fail "$tag does not point to master"
  pass "master, release, and $tag resolve to $local_head"
fi

printf '\nRunning quality gates...\n'
pnpm typecheck
pnpm test
pnpm build
pass 'typecheck, test, and build passed'

if [[ -n "$remote_host" ]]; then
  printf '\nInspecting remote environment (read-only)...\n'
  ssh "$remote_host" 'set -eu
    repo=/root/service/doujie
    test -d "$repo/.git"
    cd "$repo"
    test "$(id -un)" = root
    test "$(git branch --show-current)" = release
    test "$(systemctl show doujie -p User --value)" = root
    test "$(systemctl show doujie -p WorkingDirectory --value)" = "$repo"
    test "$(systemctl is-active doujie)" = active
    test "$(pgrep -P "$(systemctl show doujie -p MainPID --value)" -f "lark-cli event .*subscribe" | wc -l)" -eq 1
    test "$(pgrep -P "$(systemctl show doujie -p MainPID --value)" -f "codex exec" | wc -l)" -eq 0
    PATH=/opt/node20/bin:$PATH
    test "$(node -p "process.versions.node.split(\".\")[0]")" = 20
    test "$(pnpm --version)" = "$(node -p "require(\"./package.json\").packageManager.split(\"@\")[1]")"
    printf "Remote environment: active root service, one listener, no Codex child, Node %s, pnpm %s\n" "$(node --version)" "$(pnpm --version)"
  '
  pass "remote environment $remote_host passed read-only checks"
fi

printf '\nRelease check passed for %s (%s phase).\n' "$tag" "$phase"
