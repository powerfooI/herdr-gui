#!/usr/bin/env bash
set -euo pipefail

public_root="$(cd "$(dirname "$0")/../server/public" && pwd)"
max_file_count=160
max_total_bytes=$((12 * 1024 * 1024))

file_count="$(find "$public_root" -type f | wc -l | tr -d ' ')"
total_bytes="$(find "$public_root" -type f -exec cat {} + | wc -c | tr -d ' ')"
total_mib="$(awk -v bytes="$total_bytes" 'BEGIN { printf "%.1f", bytes / 1024 / 1024 }')"

if ((file_count > max_file_count || total_bytes > max_total_bytes)); then
  printf 'web asset budget exceeded: %s/%s files, %s/12 MiB\n' \
    "$file_count" "$max_file_count" "$total_mib" >&2
  exit 1
fi

printf 'web asset budget: %s/%s files, %s/12 MiB\n' \
  "$file_count" "$max_file_count" "$total_mib"
