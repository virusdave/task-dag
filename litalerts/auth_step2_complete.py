#!/usr/bin/env python3
"""Step 2: Complete LitAlerts auth with OTP code"""

import json
import socket
import sys
import urllib.request
from pathlib import Path

_original_getaddrinfo = socket.getaddrinfo
def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_only_getaddrinfo

COGNITO_ENDPOINT = "https://cognito-idp.us-east-2.amazonaws.com/"
COGNITO_CLIENT_ID = "696jmvfc56kqe1bb38j55er8in"
LITALERTS_VERIFY_URL = "https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY"

SESSION_FILE = Path("/tmp/litalerts-session.json")
SECRET_DIR = Path.home() / ".secret" / "litalerts"
REFRESH_TOKEN_PATH = SECRET_DIR / "refresh-token"
BEARER_TOKEN_PATH = SECRET_DIR / "bearer-token"

if len(sys.argv) < 2:
    print("Usage: ./auth_step2_complete.py <otp-code>")
    sys.exit(1)

otp_code = sys.argv[1]

# Load session
session_data = json.loads(SESSION_FILE.read_text())
session = session_data["Session"]
email = session_data["ChallengeParameters"]["USER_ID_FOR_SRP"]

print(f"[step2] Submitting OTP for {email}...")

# RespondToAuthChallenge
challenge_request = urllib.request.Request(
    COGNITO_ENDPOINT,
    data=json.dumps({
        "ChallengeName": "EMAIL_OTP",
        "ClientId": COGNITO_CLIENT_ID,
        "Session": session,
        "ChallengeResponses": {
            "EMAIL_OTP_CODE": otp_code,
            "USERNAME": email
        },
    }).encode('utf-8'),
    headers={
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
        "X-Amz-User-Agent": "aws-amplify/6.16.4 framework/0",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(challenge_request, timeout=30) as response:
        challenge_response = json.loads(response.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print(f"ERROR: HTTP {e.code}", file=sys.stderr)
    print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
    sys.exit(1)

# Extract tokens
auth_result = challenge_response.get("AuthenticationResult")
if not auth_result:
    print("ERROR: Missing AuthenticationResult", file=sys.stderr)
    print(json.dumps(challenge_response, indent=2), file=sys.stderr)
    sys.exit(1)

access_token = auth_result["AccessToken"]
refresh_token = auth_result.get("RefreshToken")

print(f"[step2] Got tokens (expires in {auth_result.get('ExpiresIn')}s)")

# Verify
verify_request = urllib.request.Request(
    LITALERTS_VERIFY_URL,
    headers={"Authorization": f"Bearer {access_token}"},
)
with urllib.request.urlopen(verify_request, timeout=30) as response:
    print(f"[verify] Token verified (HTTP {response.status})")

# Save tokens
SECRET_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)

if refresh_token:
    REFRESH_TOKEN_PATH.write_text(refresh_token)
    REFRESH_TOKEN_PATH.chmod(0o600)
    print(f"[save] Refresh token saved")

BEARER_TOKEN_PATH.write_text(access_token)
BEARER_TOKEN_PATH.chmod(0o600)
print(f"[save] Bearer token saved")

print(f"✅ Authentication complete!")
