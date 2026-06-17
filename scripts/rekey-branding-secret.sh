#!/usr/bin/env bash
# rekey-branding-secret.sh
#
# Off-machine operator helper for FreshlyBakedNYC/automation#48
# (Helios branding opaque-slug producer, Decision A).
#
# WHAT THIS DOES
# --------------
# Provisions FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET into the Helios runtime on
# vps-nixos-3 so the branding manifest producer can derive prod-correct
# opaque landing-page refs (opaque_ref = HMAC(secret, sweedBrandId)) when it
# runs `branding-opaque-manifest publish --env prod`. The branding publish
# oneshot must run on vps-nixos-3 (it writes the signed bundle to /cloud/lp,
# which is read-write on vps3 and a read-only sshfs mirror on vps2).
#
# The required plaintext is IDENTICAL to the value already encrypted for the
# mss FBUS frontends at secrets/vps-nixos-{1,2}/freshlybakedus-public-token.env.age
# (a single `FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=...` env line). So instead of
# hand-copying a raw production secret across systems, this script:
#
#   1. ephemerally clones virusdave/top-level (canon), then uses it to locate
#      and clone Nicponskis/nixos-sbc;
#   2. decrypts secrets/vps-nixos-2/freshlybakedus-public-token.env.age with
#      YOUR age/ssh identity (the `dave` recipient);
#   3. re-encrypts the SAME plaintext to a new
#      secrets/vps-nixos-3/freshlybakedus-public-token.env.age, targeted at the
#      `dave` + `vpsNixos3` recipients pulled straight from secrets.nix;
#   4. wires it up in nixos-sbc:
#        - adds the publicKeys entry in secrets.nix,
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
#     `nix shell nixpkgs#age` (pass --no-nix to forbid that).
#
# USAGE
# -----
#   scripts/rekey-branding-secret.sh            # do everything, stop before push
#   scripts/rekey-branding-secret.sh --push     # ...and push to origin/master
#   scripts/rekey-branding-secret.sh --identity ~/.ssh/id_ed25519_dave
#   scripts/rekey-branding-secret.sh --keep     # keep the ephemeral clones
#
# Re-running is safe: every mutation is idempotent and the script aborts loudly
# (without writing a partial commit) if any expected anchor is missing.

set -euo pipefail
umask 077

# ── Defaults / config (override via env or flags) ────────────────────────────
TOP_LEVEL_URL="${TOP_LEVEL_URL:-git@github.com:virusdave/top-level.git}"
NIXOS_SBC_URL="${NIXOS_SBC_URL:-git@github.com:Nicponskis/nixos-sbc.git}"
IDENTITY="${IDENTITY:-$HOME/.ssh/id_ed25519}"
BRANCH="master"
DO_PUSH=0
KEEP=0
ALLOW_NIX=1

SRC_REL="secrets/vps-nixos-2/freshlybakedus-public-token.env.age"
DST_REL="secrets/vps-nixos-3/freshlybakedus-public-token.env.age"
HOST_NIX="hosts/per-host/vps-nixos-3.nix"
SECRETS_NIX="secrets.nix"
AGENIX_ATTR="helios-freshlybakedus-public-token-env"
COMMIT_MSG="helios(branding): provision FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET on vps-nixos-3 (FreshlyBakedNYC/automation#48)"

# ── Arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)         DO_PUSH=1 ;;
    --keep)         KEEP=1 ;;
    --no-nix)       ALLOW_NIX=0 ;;
    --identity)     IDENTITY="${2:?--identity needs a path}"; shift ;;
    --identity=*)   IDENTITY="${1#*=}" ;;
    -h|--help)      sed -n '2,80p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Tooling: git, ssh, age ───────────────────────────────────────────────────
command -v git >/dev/null || die "git not found on PATH"
command -v ssh >/dev/null || die "ssh not found on PATH"

if command -v age >/dev/null 2>&1; then
  AGE() { age "$@"; }
elif [[ "$ALLOW_NIX" == 1 ]] && command -v nix >/dev/null 2>&1; then
  log "age not on PATH; using 'nix shell nixpkgs#age'"
  AGE() { nix shell nixpkgs#age -c age "$@"; }
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
[[ -f "$SRC_REL"     ]] || die "source secret missing: $SRC_REL"

# ── 2. Pull recipients straight from secrets.nix (single source of truth) ────
sed_pub() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\\(ssh-[^\"]*\\)\".*/\\1/p" "$SECRETS_NIX" | head -1; }
DAVE_PUB="$(sed_pub dave)"
VPS3_PUB="$(sed_pub vpsNixos3)"
[[ -n "$DAVE_PUB" ]] || die "could not read 'dave' pubkey from $SECRETS_NIX"
[[ -n "$VPS3_PUB" ]] || die "could not read 'vpsNixos3' pubkey from $SECRETS_NIX"
log "Recipients: dave + vpsNixos3 (parsed from $SECRETS_NIX)"

# ── 3. Decrypt vps-nixos-2 copy, re-encrypt to vps-nixos-3 recipients ────────
PLAIN="$WORK/plaintext.env"
log "Decrypting $SRC_REL with identity $IDENTITY"
AGE -d -i "$IDENTITY" -o "$PLAIN" "$SRC_REL" \
  || die "decryption failed — is $IDENTITY the 'dave' key?"

# Defensive: confirm the plaintext is the expected single env var.
if ! grep -q '^FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET=' "$PLAIN"; then
  die "decrypted plaintext does not contain FRESHLYBAKEDUS_PUBLIC_TOKEN_SECRET= (refusing to proceed)"
fi

log "Re-encrypting → $DST_REL (dave + vpsNixos3)"
AGE -r "$DAVE_PUB" -r "$VPS3_PUB" -o "$DST_REL" "$PLAIN" \
  || die "re-encryption failed"
rm -f "$PLAIN"

# ── 4a. secrets.nix: add the vps-nixos-3 publicKeys entry (idempotent) ───────
SECRETS_LINE="  \"$DST_REL\".publicKeys = [ dave vpsNixos3 ];"
if grep -qF "\"$DST_REL\".publicKeys" "$SECRETS_NIX"; then
  log "secrets.nix already declares $DST_REL — leaving as-is"
else
  log "Adding $DST_REL to secrets.nix"
  ANCHOR='vps-nixos-3/helios-lp-bundle-signing-key.age".publicKeys'
  awk -v ins="$SECRETS_LINE" -v anchor="$ANCHOR" '
    { print }
    (!done && index($0, anchor)) { print ins; done=1 }
    END { if (!done) { print "ANCHOR_MISS" > "/dev/stderr"; exit 3 } }
  ' "$SECRETS_NIX" > "$SECRETS_NIX.tmp" 2>"$WORK/awk.err" \
    || die "could not find the vps-nixos-3 anchor in $SECRETS_NIX; hand-edit needed"
  mv "$SECRETS_NIX.tmp" "$SECRETS_NIX"
fi

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

# ── 5. Stage, show diff, commit, (push) ──────────────────────────────────────
git add "$DST_REL" "$SECRETS_NIX" "$HOST_NIX"

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

cat >&2 <<EOF

────────────────────────────────────────────────────────────────────────────
Next steps (operator, on the fleet):

  1. Deploy vps-nixos-3 so agenix materialises the new secret and the helios
     units pick it up:

       ssh -p 22223 vps-nixos-3 self-deploy        # NixOS system rebuild

  2. Verify the secret is present for Helios:

       ssh -p 22223 vps-nixos-3 'systemctl show -p EnvironmentFiles helios-server.service | tr ":" "\n" | grep freshlybakedus'
       ssh -p 22223 vps-nixos-3 'ls -l /run/agenix/$AGENIX_ATTR'

  3. Build the branding manifest against prod and confirm it no longer fails
     closed on the secret (runs on vps-nixos-3, where /cloud/lp is writable):

       branding-opaque-manifest publish --env prod   # (or build first to dry-run)

The lp-bundle signing key is already provisioned on vps-nixos-3
(secrets/vps-nixos-3/helios-lp-bundle-signing-key.age →
LP_BUNDLE_SIGNING_KEY_FILE); this script intentionally left it untouched.
────────────────────────────────────────────────────────────────────────────
EOF
