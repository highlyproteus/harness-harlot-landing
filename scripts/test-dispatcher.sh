#!/bin/sh
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/hh-dispatcher-test.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$work/bin"

cat > "$work/bin/uname" <<'EOF'
#!/bin/sh
printf '%s\n' "${HH_TEST_UNAME:?}"
EOF
cat > "$work/bin/curl" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = -fsS ]
url=$2
[ "$3" = -o ]
output=$4
printf '%s\n' "$url" > "${HH_TEST_URL_LOG:?}"
cat > "$output" <<'SCRIPT'
#!/bin/sh
printf '%s\n' "$*" > "${HH_TEST_ARGS_LOG:?}"
SCRIPT
EOF
chmod 755 "$work/bin/uname" "$work/bin/curl"

run_platform() {
  platform=$1
  expected_url=$2
  HH_TEST_UNAME=$platform \
  HH_TEST_URL_LOG="$work/$platform-url" \
  HH_TEST_ARGS_LOG="$work/$platform-args" \
  PATH="$work/bin:$PATH" \
    "$repository_root/public/install" --verify-only
  [ "$(cat "$work/$platform-url")" = "$expected_url" ]
  [ "$(cat "$work/$platform-args")" = "--verify-only" ]
}
run_platform Darwin https://harnessharlot.com/install-macos
run_platform Linux https://harnessharlot.com/install-linux

if HH_TEST_UNAME=FreeBSD \
   HH_TEST_URL_LOG="$work/unexpected-url" \
   HH_TEST_ARGS_LOG="$work/unexpected-args" \
   PATH="$work/bin:$PATH" \
     "$repository_root/public/install" > "$work/unsupported.out" 2>&1; then
  echo "dispatcher accepted an unsupported operating system" >&2
  exit 1
fi
grep -F 'unsupported operating system: FreeBSD' "$work/unsupported.out" >/dev/null
[ ! -e "$work/unexpected-url" ]

echo "universal installer dispatches macOS and Linux without redirects"
