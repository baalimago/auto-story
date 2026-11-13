# Sourced by every bash command the agents run (BASH_ENV, see server/bash_operations.mjs).
# The sandbox has bash, basic file commands and Node only, so the tools agents reach for by habit
# either get a Node stand-in or say plainly what to use instead.
__AUTO_STORY_TOOLS="${AUTO_STORY_TOOLS:-$(dirname "${BASH_SOURCE[0]}")}"

grep() { command node "$__AUTO_STORY_TOOLS/search.mjs" grep "$@"; }
egrep() { command node "$__AUTO_STORY_TOOLS/search.mjs" grep -E "$@"; }
fgrep() { command node "$__AUTO_STORY_TOOLS/search.mjs" grep -F "$@"; }
rg() { command node "$__AUTO_STORY_TOOLS/search.mjs" rg "$@"; }

__auto_story_missing() {
  echo "$1 is not installed in this sandbox. Node.js is the only runtime: use node -e '…', or write a .mjs file under .tmp/ and run node .tmp/name.mjs." >&2
  return 127
}
python() { __auto_story_missing python; }
python3() { __auto_story_missing python3; }
pip() { __auto_story_missing pip; }
pip3() { __auto_story_missing pip3; }
perl() { __auto_story_missing perl; }
ruby() { __auto_story_missing ruby; }
jq() { __auto_story_missing jq; }

# Edge.js cannot read a module from stdin (`node --input-type=module <<'JS'` drops into its REPL),
# so a script piped in with --input-type is saved next to the workspace files and run as a file.
node() {
  local type="" args=() a
  for a in "$@"; do
    case "$a" in
      --input-type=module) type=mjs ;;
      --input-type=commonjs) type=cjs ;;
      *) args+=("$a") ;;
    esac
  done
  if [ -z "$type" ]; then command node "$@"; return; fi
  if [ ${#args[@]} -eq 0 ] || { [ ${#args[@]} -eq 1 ] && [ "${args[0]}" = "-" ]; }; then
    local file=".stdin-$$-$RANDOM.$type" status src
    IFS= read -r -d '' src
    printf '%s\n' "$src" > "$file"
    command node "$file"; status=$?
    command rm -f "$file"
    return $status
  fi
  command node "$@"
}
