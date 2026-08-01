#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

failures=0
for command_name in bash git python3; do
  if command -v "$command_name" >/dev/null 2>&1; then
    printf 'ok   %-10s %s\n' "$command_name" "$(command -v "$command_name")"
  else
    printf 'miss %-10s required\n' "$command_name"
    failures=$((failures + 1))
  fi
done

if command -v pip3 >/dev/null 2>&1 || python3 -m pip --version >/dev/null 2>&1; then
  printf 'ok   %-10s available\n' pip3
else
  printf 'miss %-10s required by Mozilla bootstrap\n' pip3
  if command -v pacman >/dev/null 2>&1; then
    printf 'hint %-10s sudo pacman -S python-pip\n' install
  elif command -v apt-get >/dev/null 2>&1; then
    printf 'hint %-10s sudo apt-get install python3-pip\n' install
  fi
  failures=$((failures + 1))
fi

python_version=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)
if python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' 2>/dev/null; then
  printf 'ok   %-10s %s\n' version "$python_version"
else
  printf 'miss %-10s Python 3.9+ required (found %s)\n' version "${python_version:-unknown}"
  failures=$((failures + 1))
fi

available_kb=$(df -Pk "$PROJECT_ROOT" | awk 'NR == 2 { print $4 }')
available_gb=$((available_kb / 1024 / 1024))
if ((available_gb >= 30)); then
  printf 'ok   %-10s %s GB free\n' disk "$available_gb"
else
  printf 'warn %-10s %s GB free; Firefox recommends at least 30 GB\n' disk "$available_gb"
fi

if [[ -x "$FIREFOX_DIR/mach" ]]; then
  current=$(git -C "$FIREFOX_DIR" rev-parse HEAD 2>/dev/null || true)
  if [[ $current == "$FIREFOX_REVISION" ]]; then
    printf 'ok   %-10s %s\n' checkout "${current:0:12}"
  else
    printf 'warn %-10s expected %s, found %s\n' checkout "${FIREFOX_REVISION:0:12}" "${current:-unknown}"
  fi
else
  printf 'info %-10s not fetched yet\n' checkout
fi

((failures == 0)) || die "$failures required prerequisite(s) missing"
note "Host checks passed"
