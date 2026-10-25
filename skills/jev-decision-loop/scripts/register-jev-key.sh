#!/usr/bin/env bash
set -euo pipefail

service_prefix="claude-code-jev"

usage() {
  cat >&2 <<'EOF'
Usage:
  register-jev-key.sh register typesafe|openrouter
  register-jev-key.sh run typesafe|openrouter -- command [args...]

The key is read without echo and stored in the macOS Keychain. It is never
accepted as a command-line argument or printed.
EOF
  exit 2
}

provider="${2:-}"
[[ "$provider" == "typesafe" || "$provider" == "openrouter" ]] || usage
service="$service_prefix-$provider"

case "${1:-}" in
  register)
    if [[ "$provider" == "typesafe" ]]; then
      printf 'TypeSafe API key: ' >&2
    else
      printf 'OpenRouter API key: ' >&2
    fi
    IFS= read -r -s key
    printf '\n' >&2
    [[ -n "$key" ]] || { echo 'Refusing to store an empty key.' >&2; exit 1; }
    security add-generic-password -U \
      -a "$USER" \
      -s "$service" \
      -w "$key" >/dev/null
    unset key
    echo "Stored the $provider key in macOS Keychain as $service."
    ;;
  run)
    [[ "${3:-}" == "--" ]] || usage
    shift 3
    [[ $# -gt 0 ]] || usage
    key="$(security find-generic-password -a "$USER" -s "$service" -w)"
    if [[ "$provider" == "typesafe" ]]; then
      env TYPESAFE_API_KEY="$key" "$@"
    else
      env OPENROUTER_API_KEY="$key" "$@"
    fi
    unset key
    ;;
  *)
    usage
    ;;
esac
