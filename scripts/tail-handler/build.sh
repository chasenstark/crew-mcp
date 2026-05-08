#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_dir="${script_dir}/build"
app_path="${build_dir}/CrewTail.app"
plist_path="${app_path}/Contents/Info.plist"

rm -rf "${app_path}"
mkdir -p "${build_dir}"

osacompile -o "${app_path}" "${script_dir}/handler.applescript"

plist_set_or_add_string() {
  local key="$1"
  local value="$2"
  if /usr/libexec/PlistBuddy -c "Print :${key}" "${plist_path}" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plist_path}"
  else
    /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${plist_path}"
  fi
}

plist_set_or_add_bool() {
  local key="$1"
  local value="$2"
  if /usr/libexec/PlistBuddy -c "Print :${key}" "${plist_path}" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plist_path}"
  else
    /usr/libexec/PlistBuddy -c "Add :${key} bool ${value}" "${plist_path}"
  fi
}

plist_set_or_add_string "CFBundleIdentifier" "com.crew.tail"
plist_set_or_add_string "CFBundleName" "CrewTail"
plist_set_or_add_bool "LSUIElement" "true"

/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "${plist_path}" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.crew.tail" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string crew-tail" "${plist_path}"

codesign --sign - --force --deep "${app_path}"

printf '%s\n' "${app_path}"
