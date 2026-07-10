#!/usr/bin/env bash
# Install a bare-repository pre-receive assertion used by completion fixtures.
# When <bare>/enforce-completion-order exists, deletion of a leaf scheduling
# ref is rejected unless current remote master already carries a canonical,
# tree-equal first-parent-spine completion witness for that task.
set -euo pipefail
bare=${1:?usage: install-completion-order-hook.sh BARE_REPO}
cat > "$bare/hooks/pre-receive" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -f "$GIT_DIR/enforce-completion-order" ] || { cat >/dev/null; exit 0; }
updates=$(mktemp); trap 'rm -f "$updates"' EXIT
cat > "$updates"
zero=0000000000000000000000000000000000000000
master=$(git rev-parse refs/heads/master)
while read -r old new ref; do
    [ "$new" = "$zero" ] || continue
    task=""
    case "$ref" in
        refs/heads/tasks/frontier/*) task="$old" ;;
        refs/heads/tasks/active/*) task=$(git show -s --format='%P' "$old" | awk '{print $1}') ;;
        refs/heads/tasks/blocked/*|refs/heads/tasks/blocked-meta/*) task="${ref##*/}" ;;
        *) continue ;;
    esac
    witness=$(git rev-list --first-parent --parents "$master" \
        | awk -v task="$task" '
            first == "" {for (i=3; i<=NF; i++) if ($i == task) first=$1}
            END {if (first != "") print first}')
    [ -n "$witness" ] || { echo "completion-order hook: $ref deleted before $task was durable on master" >&2; exit 1; }
    first=$(git rev-parse "$witness^1")
    [ "$(git rev-parse "$witness^{tree}")" = "$(git rev-parse "$first^{tree}")" ] \
        || { echo "completion-order hook: witness $witness is not tree-equal" >&2; exit 1; }
    printf '%s %s\n' "$task" "$ref" >> "$GIT_DIR/completion-order.log"
done < "$updates"
SH
chmod +x "$bare/hooks/pre-receive"
