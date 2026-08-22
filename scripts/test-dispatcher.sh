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
[ "$1" = --max-filesize ]
[ "$2" = 1048576 ]
[ "$3" = -fsS ]
url=$4
[ "$5" = -o ]
output=$6
printf '%s\n' "$url" > "${HH_TEST_URL_LOG:?}"
case ${HH_TEST_CURL_MODE:-success} in
  fail) exit 22 ;;
  invalid) printf '%s\n' '#!/bin/sh' 'if then' > "$output"; exit 0 ;;
esac
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

for mode in fail invalid; do
  if HH_TEST_UNAME=Linux \
     HH_TEST_CURL_MODE=$mode \
     HH_TEST_URL_LOG="$work/$mode-url" \
     HH_TEST_ARGS_LOG="$work/$mode-args" \
     PATH="$work/bin:$PATH" \
       "$repository_root/public/install" > "$work/$mode.out" 2>&1; then
    echo "dispatcher accepted a $mode platform-installer download" >&2
    exit 1
  fi
  [ ! -e "$work/$mode-args" ]
done

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
