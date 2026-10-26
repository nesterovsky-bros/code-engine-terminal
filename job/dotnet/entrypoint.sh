#!/bin/sh
set -eu

if [ "${TERMINAL_SCRIPT_MODE:-inline}" = "path" ]; then
  if [ "$#" -ne 1 ]; then
    printf '%s\n' "Expected one script path argument" >&2
    exit 64
  fi
  script_path=$1
  if [ ! -r "$script_path" ]; then
    printf 'Script is not readable: %s\n' "$script_path" >&2
    exit 66
  fi
  exec /bin/bash "$script_path"
fi

if [ "$#" -ne 1 ]; then
  printf '%s\n' "Expected one inline script argument" >&2
  exit 64
fi

script_file=$(mktemp)
printf '%s' "$1" > "$script_file"
/bin/bash "$script_file"