#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_app="${1:-${script_dir}/build/CrewTail.app}"
install_dir="${CREW_TAIL_INSTALL_DIR:-${HOME}/Applications}"
target_app="${install_dir}/CrewTail.app"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ ! -d "${source_app}" ]]; then
  printf 'CrewTail.app not found at %s. Run build.sh first.\n' "${source_app}" >&2
  exit 1
fi

mkdir -p "${install_dir}"
rm -rf "${target_app}"
/usr/bin/ditto "${source_app}" "${target_app}"
"${lsregister}" -f "${target_app}"

printf '%s\n' "${target_app}"
