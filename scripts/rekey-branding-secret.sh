#!/usr/bin/env bash
# rekey-branding-secret.sh
#
# Off-machine operator helper for FreshlyBakedNYC/automation#48
# (Helios branding opaque-slug producer, Decision A).
#
# WHAT THIS DOES
# --------------
# Provisions ONE shared FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET onto every FBUS host
# (vps-nixos-1, -2 and -3 by default) so the opaque landing-page refs match
# everywhere: Helios on vps-nixos-3 MINTS opaque_ref = HMAC(secret, sweedBrandId)
# when it runs `branding-opaque-manifest publish --env prod`, and the mss FBUS
# frontends on vps-nixos-1/2 VERIFY those refs. If the three hosts don't carry
# the identical plaintext, every opaque link breaks. (Helios publish must run on
# vps-nixos-3 — it writes the signed bundle to /cloud/lp, read-write on vps3 and
# a read-only sshfs mirror on vps2.)
#
# The historical agenix copies at secrets/vps-nixos-{1,2}/freshlybakedus-public-token.env.age
# were found to decrypt to EMPTY plaintext (a prior attempt mis-encrypted them),
# so there is no canonical secret to copy. This script therefore:
#
#   1. ephemerally clones virusdave/top-level (canon), then uses it to locate
#      and clone Nicponskis/nixos-sbc;
#   2. resolves ONE canonical plaintext, in priority order:
#        a. --plaintext-file <file>  → encrypt that local file's CONTENTS
#           (overrides --generate);
#        b. --generate → ALWAYS mint a fresh 32-byte random secret (ROTATION);
#           skips any existing blob, so `--generate` truly generates rather than
#           silently reusing the live value;
#        c. otherwise (DEFAULT, no --generate) → reuse an existing host blob (or
#           --source) that still decrypts (with YOUR `dave` age/ssh identity) to
#           a real FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET= line, so reruns REUSE the
#           live value instead of rotating it; fails if none can be decrypted;
#   3. encrypts that SAME plaintext to each requested host's
#      secrets/vps-nixos-N/freshlybakedus-public-token.env.age, targeted at the
#      `dave` + `vpsNixosN` recipients pulled straight from secrets.nix, then
#      decrypts each output again and verifies it is byte-for-byte identical to
#      the source (so a wrong-content / path-as-data blob can never be committed);
#   4. wires up vps-nixos-3 (Helios) in nixos-sbc (the mss hosts are already
#      wired, so only their .age blobs are replaced):
#        - adds the vps-nixos-3 publicKeys entry in secrets.nix,
#        - declares the `helios-freshlybakedus-public-token-env` agenix secret
#          in hosts/per-host/vps-nixos-3.nix (owner/group helios, mode 0400),
#        - appends it to services.helios.environmentFiles;
#   5. commits everything as ONE atomic change on master and (with --push)
#      pushes to origin/master.
#
# It does NOT touch the lp-bundle signing key: vps-nixos-3 already ships
# secrets/vps-nixos-3/helios-lp-bundle-signing-key.age, declared in
# secrets.nix and wired to LP_BUNDLE_SIGNING_KEY_FILE in vps-nixos-3.nix.
# Per the operator decision we reuse that existing key.
#
# It does NOT deploy. NixOS activation (`self-deploy` on vps-nixos-3) is an
# operator step; this script prints the exact follow-up commands.
#
# REQUIREMENTS (run on YOUR workstation, off the fleet)
# -----------------------------------------------------
#   - A GitHub SSH key that can read/write virusdave/top-level and
#     Nicponskis/nixos-sbc (your normal dev key).
#   - The `dave` age decryption identity: an ssh private key whose public half
#     is the `dave` line in nixos-sbc/secrets.nix. Defaults to ~/.ssh/id_ed25519;
#     override with --identity PATH.
#   - `git`, `ssh`, and `age`. If `age` is not on PATH, the script falls back to
#     `nix shell github:NixOS/nixpkgs/nixpkgs-unstable#age` (a fully-qualified
#     flake URL, so it works even with an empty flake registry; override the
#     ref with NIXPKGS_FLAKE, or forbid the fallback entirely with --no-nix).
#
# USAGE
# -----
#   scripts/rekey-branding-secret.sh --generate # ROTATE: always mint a fresh
#                                               #   secret, provision all 3 hosts
#                                               #   (required), keep the clone,
#                                               #   stop before push
#   scripts/rekey-branding-secret.sh --generate --push   # ...and push to master
#   scripts/rekey-branding-secret.sh            # reuse an existing secret only
#                                               #   (fails if none can be decrypted
#                                               #   and --generate was not given)
#   scripts/rekey-branding-secret.sh --hosts '1 2 3'     # which hosts to target
#                                               #   (default: 1 2 3)
#   scripts/rekey-branding-secret.sh --identity ~/.ssh/id_ed25519_dave
#   scripts/rekey-branding-secret.sh --source secrets/vps-nixos-1/freshlybakedus-public-token.env.age
#   scripts/rekey-branding-secret.sh --plaintext-file ./fbus-secret.env  # encrypt this file's contents
#   scripts/rekey-branding-secret.sh --keep     # keep the ephemeral clones
#   scripts/rekey-branding-secret.sh --wrap-bare # source blob is a BARE secret
#                                               #   value (no VAR=); wrap it as
#                                               #   FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=<value>
#   scripts/rekey-branding-secret.sh --force    # provision even if the var-name
#                                               #   sanity check can't confirm it
#
# IMPORTANT (rotation safety): --generate ALWAYS rotates — it mints a brand-new
# secret every run, even when a valid one already exists. That invalidates every
# already-issued opaque landing-page ref derived from the OLD key until all hosts
# are redeployed with the new value. So pass --generate only when you actually
# intend to rotate (or to bootstrap when no secret exists yet). The DEFAULT
# (no --generate) is the safe, idempotent rerun path: it REUSES the existing
# decryptable value and makes no change when every host already holds it.
#
# The decrypted source is auto-normalized first: UTF-16 → UTF-8, and any UTF-8
# BOM / CRLF stripped (those silently hide a valid VAR= from byte-wise checks
# and from systemd's env-file parser). If the var still can't be confirmed the
# script prints leak-safe structure only (byte/line/key-name counts, NEVER the
# value) so you can tell a bare value from a wrong blob.
#
# Re-running is safe in the DEFAULT (reuse) mode and with the SAME
# --plaintext-file: every mutation is idempotent (no churn when the hosts
# already hold the canonical plaintext) and the script aborts loudly (without
# writing a partial commit) if any expected anchor is missing. --generate is the
# deliberate exception: it is NOT idempotent — each run rotates to a new secret.

set -euo pipefail
umask 077

# Innocuous --help / -h: print this tool's header usage and exit 0 before any
# effect (canon: rules/QUALITY_GATES.md "Every tool must have an innocuous
# --help"). Handled first, ahead of all defaults, option parsing, and every
# network/git/agenix side effect, so probing the interface is always safe.
for _arg in "$@"; do
  case "$_arg" in
    -h|--help)
      sed -n '2,108p' "$0"
      exit 0
      ;;
  esac
done

# ── Defaults / config (override via env or flags) ────────────────────────────
TOP_LEVEL_URL="${TOP_LEVEL_URL:-git@github.com:virusdave/top-level.git}"
NIXOS_SBC_URL="${NIXOS_SBC_URL:-git@github.com:Nicponskis/nixos-sbc.git}"
IDENTITY="${IDENTITY:-$HOME/.ssh/id_ed25519}"
BRANCH="master"
DO_PUSH=0
KEEP=0
ALLOW_NIX=1
FORCE=0
WRAP_BARE=0
GENERATE=0
SOURCE_EXPLICIT=0
# Which hosts to provision the SAME secret to. mss FBUS runs on vps-nixos-1 and
# vps-nixos-2 (they verify the opaque tokens) and Helios on vps-nixos-3 mints
# them, so all three must share one plaintext or the opaque refs won't match.
HOSTS="${HOSTS:-1 2 3}"

# Source the real plaintext from the vps-nixos-1 copy by default: it is the
# documented canonical FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET env file and was not
# touched by this task. The vps-nixos-2 blob was found to decrypt to a *path*
# (a prior provisioning attempt encrypted a filename instead of the file's
# contents), so it is no longer a trustworthy source. Override with SRC_REL=…,
# or bypass agenix entirely with --plaintext-file (encrypts a local file's
# CONTENTS directly).
SRC_REL="${SRC_REL:-secrets/vps-nixos-1/freshlybakedus-public-token.env.age}"
PLAINTEXT_FILE="${PLAINTEXT_FILE:-}"
DST_REL="secrets/vps-nixos-3/freshlybakedus-public-token.env.age"
HOST_NIX="hosts/per-host/vps-nixos-3.nix"
SECRETS_NIX="secrets.nix"
AGENIX_ATTR="helios-freshlybakedus-public-token-env"
COMMIT_MSG="helios(branding): provision shared FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET across vps-nixos-1/2/3 (FreshlyBakedNYC/automation#48)"

# ── Arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)         DO_PUSH=1 ;;
    --keep)         KEEP=1 ;;
    --force)        FORCE=1 ;;
    --wrap-bare)    WRAP_BARE=1 ;;
    --generate)     GENERATE=1 ;;
    --no-nix)       ALLOW_NIX=0 ;;
    --identity)     IDENTITY="${2:?--identity needs a path}"; shift ;;
    --identity=*)   IDENTITY="${1#*=}" ;;
    --plaintext-file)   PLAINTEXT_FILE="${2:?--plaintext-file needs a path}"; shift ;;
    --plaintext-file=*) PLAINTEXT_FILE="${1#*=}" ;;
    --source)       SRC_REL="${2:?--source needs a path}"; SOURCE_EXPLICIT=1; shift ;;
    --source=*)     SRC_REL="${1#*=}"; SOURCE_EXPLICIT=1 ;;
    --hosts)        HOSTS="${2:?--hosts needs a value like '1 2 3'}"; shift ;;
    --hosts=*)      HOSTS="${1#*=}" ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# A --generate run mints a NEW secret and commits it into an EPHEMERAL clone. If
# we neither push nor keep, that rotation commit is deleted on exit and silently
# lost — easy to misread as success. So when rotating without --push, force
# --keep so the operator can inspect/push the commit afterwards.
if [[ "$GENERATE" == 1 && "$DO_PUSH" != 1 && "$KEEP" != 1 ]]; then
  KEEP=1
  warn "--generate without --push: keeping the ephemeral clone so the new-secret commit is not discarded (use --push to push automatically)."
fi

# ── Tooling: git, ssh, age ───────────────────────────────────────────────────
command -v git >/dev/null || die "git not found on PATH"
command -v ssh >/dev/null || die "ssh not found on PATH"

# Fully-qualified nixpkgs flake ref (a github: URL) so the nix fallback does
# NOT depend on a `nixpkgs` entry existing in the local flake registry — a
# bare `nixpkgs#age` fails with "cannot find flake 'flake:nixpkgs'" on hosts
# whose registry is empty. Override with NIXPKGS_FLAKE if you want pinning.
NIXPKGS_FLAKE="${NIXPKGS_FLAKE:-github:NixOS/nixpkgs/nixpkgs-unstable}"

if command -v age >/dev/null 2>&1; then
  AGE() { age "$@"; }
elif [[ "$ALLOW_NIX" == 1 ]] && command -v nix >/dev/null 2>&1; then
  log "age not on PATH; using 'nix shell ${NIXPKGS_FLAKE}#age'"
  AGE() { nix shell "${NIXPKGS_FLAKE}#age" -c age "$@"; }
else
  die "age not found (install age, or allow the nix fallback by not passing --no-nix)"
fi

[[ -f "$IDENTITY" ]] || die "age identity not found: $IDENTITY (pass --identity PATH)"

# ── Ephemeral workspace ──────────────────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rekey-branding.XXXXXX")"
cleanup() {
  if [[ "$KEEP" == 1 ]]; then
    warn "keeping ephemeral workspace: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# ── 1. Clone top-level (canon), then use it to reach nixos-sbc ───────────────
log "Ephemerally cloning top-level (canon) → $WORK/top-level"
git clone --quiet --depth 1 --branch "$BRANCH" "$TOP_LEVEL_URL" "$WORK/top-level" \
  || die "could not clone top-level from $TOP_LEVEL_URL (SSH key access?)"

# top-level/docs/agent-kb/repos/index.md is the canonical repo map. Confirm
# nixos-sbc is the system-closures repo before we clone it, so this script
# tracks canon rather than a hardcoded assumption.
REPO_INDEX="$WORK/top-level/docs/agent-kb/repos/index.md"
if [[ -f "$REPO_INDEX" ]] && grep -q "Nicponskis/nixos-sbc" "$REPO_INDEX"; then
  log "Confirmed Nicponskis/nixos-sbc in top-level repo index"
else
  warn "top-level repo index did not mention Nicponskis/nixos-sbc; proceeding with $NIXOS_SBC_URL"
fi

log "Cloning nixos-sbc → $WORK/nixos-sbc"
git clone --quiet --branch "$BRANCH" "$NIXOS_SBC_URL" "$WORK/nixos-sbc" \
  || die "could not clone nixos-sbc from $NIXOS_SBC_URL (SSH key access?)"

REPO="$WORK/nixos-sbc"
cd "$REPO"

# ── Sanity checks on the tree ────────────────────────────────────────────────
[[ -f "$SECRETS_NIX" ]] || die "$SECRETS_NIX missing in nixos-sbc clone"
[[ -f "$HOST_NIX"    ]] || die "$HOST_NIX missing in nixos-sbc clone"
# NOTE: $SRC_REL is now only an OPTIONAL candidate (the script can reuse an
# existing host blob or --generate a fresh secret), so its absence is not fatal.

# ── 2. Pull recipients straight from secrets.nix (single source of truth) ────
sed_pub() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\\(ssh-[^\"]*\\)\".*/\\1/p" "$SECRETS_NIX" | head -1; }
DAVE_PUB="$(sed_pub dave)"
[[ -n "$DAVE_PUB" ]] || die "could not read 'dave' pubkey from $SECRETS_NIX"
for h in $HOSTS; do
  [[ "$h" =~ ^[123]$ ]] || die "invalid host '$h' in --hosts (expected 1, 2, and/or 3)"
  [[ -n "$(sed_pub "vpsNixos${h}")" ]] || die "could not read 'vpsNixos${h}' pubkey from $SECRETS_NIX"
done
log "Recipients parsed from $SECRETS_NIX: dave + vpsNixos{$(echo $HOSTS | tr ' ' ,)}"

# ── 3. Resolve ONE canonical plaintext, fan it out to every host ─────────────
# The SAME FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET must land on every host in $HOSTS:
# Helios on vps-nixos-3 mints opaque landing-page refs as HMAC(secret, brandId)
# and the mss FBUS frontends on vps-nixos-1/2 verify them, so any mismatch
# breaks every opaque link. We therefore resolve exactly one plaintext and
# encrypt that identical value to each host's recipients.
#
# IMPORTANT: every `age` call passes its input as a FILE, so age operates on the
# file's CONTENTS, never on a path *as data* (the bug that corrupted a prior
# blob — it encrypted the string "/tmp/…/plaintext.env" instead of its bytes).
# The per-host round-trip verification below makes that impossible to commit.
PLAIN="$WORK/plaintext.env"

# normalize_env <in> <out>: transcode UTF-16 → UTF-8 and strip a UTF-8 BOM /
# trailing CR (any of which hide a valid VAR= from byte-wise greps and from
# systemd's env-file parser). Non-destructive: only overwrites when the rewrite
# produced non-empty output, and runs under LC_ALL=C so macOS/BSD sed never
# aborts with "RE error: illegal byte sequence" on raw BOM bytes.
normalize_env() {
  local in="$1" out="$2" b nb
  b=$(wc -c < "$in" | tr -d ' ')
  nb=$(LC_ALL=C tr -d '\000' < "$in" | wc -c | tr -d ' ')
  if [[ "$b" -ne "$nb" ]]; then
    iconv -f UTF-16 -t UTF-8 "$in" > "$out" 2>/dev/null \
      || iconv -f UTF-16LE -t UTF-8 "$in" > "$out" 2>/dev/null \
      || cp "$in" "$out"
    [[ -s "$out" ]] || cp "$in" "$out"
  else
    cp "$in" "$out"
  fi
  if LC_ALL=C sed -e $'1s/^\xef\xbb\xbf//' -e $'s/\r$//' "$out" > "$out.tmp" 2>/dev/null && [[ -s "$out.tmp" ]]; then
    mv "$out.tmp" "$out"
  else
    rm -f "$out.tmp"
  fi
}

# try_existing_secret <age-file> <out>: decrypt with $IDENTITY; succeed only if
# the result is non-empty AND carries FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=. Used
# to (a) source an already-canonical secret and (b) in the DEFAULT (no
# --generate) mode make reruns REUSE the provisioned value instead of minting a
# fresh one (which would rotate the live key out from under already-deployed
# hosts). --generate deliberately bypasses this reuse path to force a rotation.
try_existing_secret() {
  local src="$1" out="$2"
  [[ -f "$src" ]] || return 1
  AGE -d -i "$IDENTITY" -o "$out.raw" "$src" 2>/dev/null || { rm -f "$out.raw"; return 1; }
  normalize_env "$out.raw" "$out"; rm -f "$out.raw"
  [[ -s "$out" ]] && grep -q 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=' "$out"
}

# require_all_rotation_hosts: --generate rotates the ONE shared HMAC key, so it
# must land on every host or the opaque refs go out of sync. Writing a fresh key
# to only a subset is exactly the mismatch this tool exists to prevent, so we
# refuse a rotation that does not target all of vps-nixos-{1,2,3}. (Subset
# REPAIR is still possible without --generate: reuse mode / --plaintext-file
# re-encrypt the *existing* canonical value to a subset.)
require_all_rotation_hosts() {
  local h have1=0 have2=0 have3=0
  [[ -n "${HOSTS//[[:space:]]/}" ]] || die "--hosts cannot be empty"
  for h in $HOSTS; do
    case "$h" in
      1) have1=1 ;;
      2) have2=1 ;;
      3) have3=1 ;;
      *) die "invalid host '$h' in --hosts (expected 1, 2, and/or 3)" ;;
    esac
  done
  [[ "$have1$have2$have3" == 111 ]] || die \
    "--generate rotates the shared HMAC key and must target all hosts (--hosts '1 2 3'). Use reuse mode or --plaintext-file to repair a subset."
}

SECRET_ORIGIN=""
if [[ -n "$PLAINTEXT_FILE" ]]; then
  # An explicit plaintext file is the strongest source of truth; it overrides
  # --generate (warn so the ignored flag is never silently surprising).
  [[ "$GENERATE" == 1 ]] && warn "--generate ignored because --plaintext-file was supplied; encrypting the file's CONTENTS, not a fresh secret."
  [[ -f "$PLAINTEXT_FILE" ]] || die "--plaintext-file not found: $PLAINTEXT_FILE"
  log "Using operator-supplied plaintext file (encrypting its CONTENTS): $PLAINTEXT_FILE"
  normalize_env "$PLAINTEXT_FILE" "$PLAIN"
  SECRET_ORIGIN="operator file $PLAINTEXT_FILE"
elif [[ "$GENERATE" == 1 ]]; then
  # ROTATE: --generate ALWAYS mints a fresh secret, even when a valid one
  # already decrypts. (The reuse-existing scan below is the DEFAULT, no-flag
  # behaviour; --generate deliberately skips it so the operator's `--generate`
  # actually generates rather than silently reusing the live value.) Refuse a
  # rotation that does not cover every host (subset rotation = guaranteed
  # mismatch), and reject --source which has no meaning when we are not reading
  # any existing blob.
  [[ "$SOURCE_EXPLICIT" == 1 ]] && die "--source cannot be combined with --generate; --generate mints a fresh secret and ignores existing blobs. Omit --generate to reuse a source, or use --plaintext-file to supply exact contents."
  require_all_rotation_hosts
  command -v openssl >/dev/null || die "--generate needs openssl (not found on PATH)"
  warn "GENERATING a fresh FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET (32 random bytes) — this ROTATES the live HMAC key."
  warn "Every already-issued opaque landing-page ref derived from the OLD key stops resolving until vps-nixos-{$(echo "$HOSTS" | tr ' ' ,)} are all redeployed with the new value."
  printf 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)" > "$PLAIN"
  SECRET_ORIGIN="freshly generated rotation"
else
  # DEFAULT (no --generate): reuse an already-provisioned secret if any
  # candidate blob still decrypts to a real one, so the value stays stable
  # across reruns. Candidates: the --source override (or its default) plus each
  # requested host's destination blob.
  CANDIDATES="$SRC_REL"
  for h in $HOSTS; do CANDIDATES="$CANDIDATES secrets/vps-nixos-${h}/freshlybakedus-public-token.env.age"; done
  for c in $CANDIDATES; do
    if try_existing_secret "$c" "$PLAIN"; then
      log "Reusing the existing canonical secret found in $c"
      SECRET_ORIGIN="existing $c"
      break
    fi
  done
  # Nothing usable on disk and no --generate. We refuse rather than mint, so a
  # stale/wrong identity that merely FAILED to decrypt a good blob can never
  # silently rotate the live secret.
  [[ -n "$SECRET_ORIGIN" ]] || die "no FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET could be decrypted from any host blob with $IDENTITY, and --generate was not given. Re-run with --generate to mint a fresh secret (rotation), or pass --plaintext-file <file> / --identity <key> to supply the real one."
fi

# Final guard: confirm the resolved plaintext carries the var (covers the
# --plaintext-file / bare-value cases). Leak-safe diagnostics on failure:
# structure only, NEVER the secret value.
rawbytes=$(wc -c < "$PLAIN" | tr -d ' ')
[[ "$rawbytes" -gt 0 ]] || die "resolved plaintext is empty ($SECRET_ORIGIN)"
if ! grep -q 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=' "$PLAIN"; then
  warn "resolved plaintext ($SECRET_ORIGIN) has no FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET= assignment."
  b=$(wc -c < "$PLAIN" | tr -d ' ')
  l=$(wc -l < "$PLAIN" | tr -d ' ')
  keys="$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$PLAIN")"
  bare=0; [[ -z "$keys" && "$b" -gt 0 ]] && bare=1
  warn "  structure (no values shown): bytes=$b lines=$l"
  if [[ -n "$keys" ]]; then
    warn "  env key names present (values redacted):"
    printf '      %s\n' $keys >&2
  elif [[ "$bare" == 1 ]]; then
    warn "  no KEY=value assignment — this looks like a BARE secret value, not an env file."
    warn "  Re-run with --wrap-bare to wrap it as FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=<value>."
  fi
  if [[ "$WRAP_BARE" == 1 && "$bare" == 1 ]]; then
    warn "--wrap-bare given: wrapping the bare value as FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=…"
    val="$(tr -d '\r\n' < "$PLAIN")"
    printf 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=%s\n' "$val" > "$PLAIN"
  elif [[ "$FORCE" == 1 ]]; then
    warn "--force given: provisioning this plaintext as-is anyway."
  else
    die "refusing to provision without the expected var (use --wrap-bare for a bare value, or --force to override)"
  fi
fi
log "Canonical plaintext resolved ($SECRET_ORIGIN); fanning out to vps-nixos-{$(echo "$HOSTS" | tr ' ' ,)}"

# Encrypt the SAME plaintext to each requested host (recipients dave + vpsNixosN
# straight from secrets.nix), then round-trip verify each blob decrypts back to
# the exact plaintext. The cmp guard makes a "path-as-data" / wrong-content blob
# impossible to commit.
for h in $HOSTS; do
  dst="secrets/vps-nixos-${h}/freshlybakedus-public-token.env.age"
  hostpub="$(sed_pub "vpsNixos${h}")"
  mkdir -p "$(dirname "$dst")"
  # age ciphertext is non-deterministic, so blindly re-encrypting churns the
  # blob (and git history) on every run even when the secret is unchanged. Skip
  # the rewrite when $dst already decrypts to the exact canonical plaintext.
  if [[ -f "$dst" ]] && try_existing_secret "$dst" "$WORK/cur.${h}.env" && cmp -s "$PLAIN" "$WORK/cur.${h}.env"; then
    rm -f "$WORK/cur.${h}.env"
    log "$dst already holds the canonical plaintext — leaving as-is"
    continue
  fi
  rm -f "$WORK/cur.${h}.env"
  log "Re-encrypting → $dst (dave + vpsNixos${h})"
  AGE -r "$DAVE_PUB" -r "$hostpub" -o "$dst" "$PLAIN" \
    || die "re-encryption failed for $dst"
  verify="$WORK/verify.${h}.env"
  AGE -d -i "$IDENTITY" -o "$verify" "$dst" \
    || die "could not decrypt the file we just wrote ($dst) with $IDENTITY (recipient mismatch?)"
  cmp -s "$PLAIN" "$verify" \
    || die "re-encrypted $dst does NOT match the source plaintext — refusing to commit"
  grep -q 'FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=' "$verify" \
    || die "verification: $dst is missing FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET="
  rm -f "$verify"
  log "Verified $dst contents match the canonical plaintext."
done
rm -f "$PLAIN"

# ── 4a. secrets.nix: ensure a publicKeys entry per host blob (idempotent) ────
# The mss hosts (vps-nixos-1/2) already declare their freshlybakedus blobs, so
# their entries are left untouched. Only vps-nixos-3 (Helios) is newly added —
# inserted right after the existing vps-nixos-3 lp-bundle signing-key entry.
for h in $HOSTS; do
  dst="secrets/vps-nixos-${h}/freshlybakedus-public-token.env.age"
  if grep -qF "\"$dst\".publicKeys" "$SECRETS_NIX"; then
    log "secrets.nix already declares $dst — leaving as-is"
    continue
  fi
  if [[ "$h" != 3 ]]; then
    die "secrets.nix has no publicKeys entry for $dst (expected to already exist for the mss host vps-nixos-${h}); hand-edit needed"
  fi
  log "Adding $dst to secrets.nix"
  SECRETS_LINE="  \"$dst\".publicKeys = [ dave vpsNixos3 ];"
  ANCHOR='vps-nixos-3/helios-lp-bundle-signing-key.age".publicKeys'
  awk -v ins="$SECRETS_LINE" -v anchor="$ANCHOR" '
    { print }
    (!done && index($0, anchor)) { print ins; done=1 }
    END { if (!done) { print "ANCHOR_MISS" > "/dev/stderr"; exit 3 } }
  ' "$SECRETS_NIX" > "$SECRETS_NIX.tmp" 2>"$WORK/awk.err" \
    || die "could not find the vps-nixos-3 anchor in $SECRETS_NIX; hand-edit needed"
  mv "$SECRETS_NIX.tmp" "$SECRETS_NIX"
done

# Helper: insert a block (read from a file, no escape mangling) BEFORE the
# first line containing a literal anchor substring. Idempotent guard handled
# by the caller.
insert_block_before() { # <target> <anchor-substr> <blockfile>
  local target="$1" anchor="$2" blockfile="$3"
  awk -v anchor="$anchor" -v bf="$blockfile" '
    (!done && index($0, anchor)) {
      while ((getline l < bf) > 0) print l
      close(bf); done=1
    }
    { print }
    END { if (!done) exit 3 }
  ' "$target" > "$target.tmp" \
    && mv "$target.tmp" "$target"
}

# Helper: insert a single line AFTER the first line containing an anchor.
insert_line_after() { # <target> <anchor-substr> <line>
  local target="$1" anchor="$2" line="$3"
  awk -v anchor="$anchor" -v ins="$line" '
    { print }
    (!done && index($0, anchor)) { print ins; done=1 }
    END { if (!done) exit 3 }
  ' "$target" > "$target.tmp" \
    && mv "$target.tmp" "$target"
}

# ── 4b/4c. Helios wiring on vps-nixos-3 (only when host 3 is targeted) ───────
# vps-nixos-1/2 already wire their freshlybakedus secret into mss, so the Nix
# host-module edits below are vps-nixos-3-specific (declare the agenix secret +
# add it to services.helios.environmentFiles). Skip them entirely if 3 is not
# in $HOSTS.
if [[ " $HOSTS " == *" 3 "* ]]; then

# ── 4b. vps-nixos-3.nix: declare the agenix secret (idempotent) ──────────────
if grep -qF "$AGENIX_ATTR = {" "$HOST_NIX"; then
  log "$HOST_NIX already declares $AGENIX_ATTR — leaving as-is"
else
  log "Declaring agenix secret $AGENIX_ATTR in $HOST_NIX"
  BLOCK="$WORK/decl.block"
  cat > "$BLOCK" <<EOF
    # FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET — same plaintext as the mss FBUS
    # copies on vps-nixos-1/2 (secrets/vps-nixos-{1,2}/freshlybakedus-public-token.env.age).
    # Helios on vps-nixos-3 reads it to derive the opaque landing-page brand
    # refs (HMAC(secret, sweedBrandId)) when it builds/publishes the branding
    # manifest. See FreshlyBakedNYC/automation#48 and
    # automation:helios/src/server/branding/secret.ts. Provisioned via
    # automation:scripts/rekey-branding-secret.sh.
    $AGENIX_ATTR = {
      file = ../../$DST_REL;
      owner = "helios";
      group = "helios";
      mode = "0400";
    };
EOF
  insert_block_before "$HOST_NIX" "helios-veriscan-webhook-token-env = {" "$BLOCK" \
    || die "could not find the agenix-secrets anchor (helios-veriscan-webhook-token-env) in $HOST_NIX; hand-edit needed"
fi

# ── 4c. vps-nixos-3.nix: add to services.helios.environmentFiles (idempotent)─
ENV_LINE="    config.age.secrets.$AGENIX_ATTR.path"
if grep -qF "config.age.secrets.$AGENIX_ATTR.path" "$HOST_NIX"; then
  log "$HOST_NIX environmentFiles already includes $AGENIX_ATTR — leaving as-is"
else
  log "Adding $AGENIX_ATTR to services.helios.environmentFiles"
  insert_line_after "$HOST_NIX" "config.age.secrets.helios-runtime-tokens-env.path" "$ENV_LINE" \
    || die "could not find the environmentFiles anchor (helios-runtime-tokens-env.path) in $HOST_NIX; hand-edit needed"
fi

fi  # end host-3-only Helios wiring

# ── 5. Stage, show diff, commit, (push) ──────────────────────────────────────
git add "$SECRETS_NIX" "$HOST_NIX"
for h in $HOSTS; do
  git add "secrets/vps-nixos-${h}/freshlybakedus-public-token.env.age"
done

if git diff --cached --quiet; then
  log "No changes to commit — nixos-sbc already fully provisioned. Nothing to do."
  exit 0
fi

echo >&2
log "Staged change (review before pushing):"
git --no-pager diff --cached --stat >&2
echo >&2
git --no-pager diff --cached -- "$SECRETS_NIX" "$HOST_NIX" >&2
echo >&2

git commit --quiet -m "$COMMIT_MSG"
log "Committed on $BRANCH: $(git rev-parse --short HEAD)"

if [[ "$DO_PUSH" == 1 ]]; then
  log "Pushing to origin/$BRANCH"
  git push origin "HEAD:$BRANCH" || die "push failed"
  log "Pushed."
else
  warn "Not pushed (re-run with --push, or push manually):"
  echo "    cd $REPO && git push origin HEAD:$BRANCH" >&2
  [[ "$KEEP" == 1 ]] || warn "NOTE: the clone at $REPO is deleted on exit; use --keep to push manually later."
fi

DEPLOY_HOSTS=""
for h in $HOSTS; do DEPLOY_HOSTS="$DEPLOY_HOSTS vps-nixos-${h}"; done
DEPLOY_HOSTS="${DEPLOY_HOSTS# }"

cat >&2 <<EOF

────────────────────────────────────────────────────────────────────────────
Next steps (operator, on the fleet):

  1. Deploy EVERY affected host so agenix materialises the (identical) secret.
     The opaque refs only match if vps-nixos-1, -2 and -3 all carry the same
     plaintext, so deploy all of them:

EOF
for h in $HOSTS; do
  echo "       ssh -p 22223 vps-nixos-${h} self-deploy" >&2
done
cat >&2 <<EOF

  2. Verify the secret is present for Helios (vps-nixos-3):

       ssh -p 22223 vps-nixos-3 'systemctl show -p EnvironmentFiles helios-server.service | tr ":" "\n" | grep freshlybakedus'
       ssh -p 22223 vps-nixos-3 'ls -l /run/agenix/$AGENIX_ATTR'

  3. Build the branding manifest against prod and confirm it no longer fails
     closed on the secret (runs on vps-nixos-3, where /cloud/lp is writable):

       branding-opaque-manifest publish --env prod   # (or build first to dry-run)

Affected hosts this run: $DEPLOY_HOSTS

The lp-bundle signing key is already provisioned on vps-nixos-3
(secrets/vps-nixos-3/helios-lp-bundle-signing-key.age →
LP_BUNDLE_SIGNING_KEY_FILE); this script intentionally left it untouched.
────────────────────────────────────────────────────────────────────────────
EOF
