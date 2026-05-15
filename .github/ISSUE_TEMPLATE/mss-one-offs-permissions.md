# mss-one-offs: Cannot upload files without sudo due to permission issues

## Problem

The `mss-one-offs` daemon is designed to allow users in the `mss-one-offs` group to upload files by:
1. Creating a directory in `/var/lib/mss-one-offs/incoming/<uploadId>`
2. Copying files into that directory  
3. Calling the control socket API to claim the slot

However, step 3 fails with `EACCES` permission denied because the daemon cannot rename the directory from `incoming/` to `slots/`.

## Reproduction

```bash
# User amp-local is in mss-one-offs group
$ groups
mss-one-offs agents

# Can write to incoming (has setgid bit)
$ UPLOAD_ID="test-$(date +%s)"
$ mkdir -p "/var/lib/mss-one-offs/incoming/${UPLOAD_ID}"
$ echo "test" > "/var/lib/mss-one-offs/incoming/${UPLOAD_ID}/index.html"

# Claim slot via control socket
$ curl --unix-socket /run/mss-one-offs/control.sock \
  -X POST http://localhost/v1/slots \
  -H 'content-type: application/json' \
  -d "{\"uploadId\":\"${UPLOAD_ID}\",\"ttlSeconds\":3600,\"requestedBy\":\"amp\"}"

# Error:
{"error":"EACCES: permission denied, rename '/var/lib/mss-one-offs/incoming/test-...' -> '/var/lib/mss-one-offs/slots/.../www'"}
```

## Root Cause

Directory permissions:
```bash
$ ls -ld /var/lib/mss-one-offs/{incoming,slots}/
drwxrws--- 4 mss-one-offs mss-one-offs  105 /var/lib/mss-one-offs/incoming/
drwxr-x--- 8 mss-one-offs mss-one-offs 4096 /var/lib/mss-one-offs/slots/
```

The `/var/lib/mss-one-offs/slots/` directory is only writable by the `mss-one-offs` **user**, not the group.

The daemon runs as `mss-one-offs:mss-one-offs` and uses Node.js's `fs.rename()` which requires write permission on the target directory. Since the target directory (`slots/`) is not group-writable, the rename fails even though the daemon's effective group is `mss-one-offs`.

## Expected Behavior

Users in the `mss-one-offs` group should be able to upload files without requiring `sudo`, by:
1. Writing to `/var/lib/mss-one-offs/incoming/<uploadId>/`
2. Calling the control socket API

The daemon should successfully claim the slot and serve the files.

## Proposed Fix

### Option 1: Make slots directory group-writable (Simple)

```bash
chmod 2770 /var/lib/mss-one-offs/slots/
```

### Option 2: Update NixOS service configuration (Persistent)

Modify the mss-one-offs NixOS module to set permissions on start:

```nix
systemd.services.mss-one-offs = {
  preStart = ''
    chmod 2770 /var/lib/mss-one-offs/slots
  '';
};
```

### Option 3: Change daemon behavior (Complex)

Have the daemon run with elevated privileges for the rename operation, or use a different upload mechanism that doesn't require group write access to slots.

## Current Workaround

Requires `sudo` for every upload:

```bash
sudo mkdir -p "${INCOMING_DIR}"
sudo cp file.html "${INCOMING_DIR}/index.html"
sudo chgrp -R mss-one-offs "${INCOMING_DIR}"
sudo chmod -R g+w "${INCOMING_DIR}"  
sudo curl --unix-socket /run/mss-one-offs/control.sock ...
```

This defeats the purpose of having users in the `mss-one-offs` group.

## Impact

- ❌ **Amp automation cannot upload files** without manual intervention
- ❌ **Scripts cannot upload** without sudo (not suitable for automated workflows)
- ❌ **Group membership is useless** for the intended upload use case
- ✅ Only benefit: group members can read existing slots

## Priority

**High** - Blocks automation workflows from uploading review HTML files.

## Labels

`bug`, `permissions`, `mss-one-offs`, `infrastructure`
