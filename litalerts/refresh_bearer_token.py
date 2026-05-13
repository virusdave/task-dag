#!/usr/bin/env python3
"""Refresh LitAlerts bearer token using Cognito GetTokensFromRefreshToken.

Per docs/litalerts/foundations.md, this encapsulates the ~24h Cognito
access-token rotation so the workspace can recover from expired LitAlerts
credentials without paging the operator.

Inputs (both must exist with mode 0600):
  ~/.secret/litalerts/refresh-token - long-lived Cognito refresh token
  
Outputs:
  ~/.secret/litalerts/bearer-token - freshly minted AccessToken (mode 0600)

Exits non-zero on any failure.
"""

import json
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Force IPv4 to dodge intermittent Cloudflare IPv6 challenges
_original_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

COGNITO_ENDPOINT = "https://cognito-idp.us-east-2.amazonaws.com/"
COGNITO_CLIENT_ID = "696jmvfc56kqe1bb38j55er8in"
LITALERTS_VERIFY_URL = "https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY"

SECRET_DIR = Path.home() / ".secret" / "litalerts"
REFRESH_TOKEN_PATH = SECRET_DIR / "refresh-token"
BEARER_TOKEN_PATH = SECRET_DIR / "bearer-token"


def main():
    # Read refresh token
    if not REFRESH_TOKEN_PATH.exists():
        print(f"ERROR: {REFRESH_TOKEN_PATH} not found", file=sys.stderr)
        print("You must provision a refresh token from a fresh brands.litalerts.com HAR", file=sys.stderr)
        return 1
    
    refresh_token = REFRESH_TOKEN_PATH.read_text().strip()
    if not refresh_token:
        print(f"ERROR: {REFRESH_TOKEN_PATH} is empty", file=sys.stderr)
        return 1
    
    # Call Cognito GetTokensFromRefreshToken
    print(f"[refresh] Calling Cognito GetTokensFromRefreshToken...")
    cognito_body = json.dumps({
        "ClientId": COGNITO_CLIENT_ID,
        "RefreshToken": refresh_token,
    }).encode('utf-8')
    
    cognito_request = urllib.request.Request(
        COGNITO_ENDPOINT,
        data=cognito_body,
        headers={
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
            "X-Amz-User-Agent": "aws-amplify/6.16.4 framework/0",
        },
        method="POST",
    )
    
    try:
        with urllib.request.urlopen(cognito_request, timeout=30) as response:
            cognito_response = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f"ERROR: Cognito returned HTTP {e.code}", file=sys.stderr)
        print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: Cognito request failed: {e}", file=sys.stderr)
        return 1
    
    # Extract AccessToken
    auth_result = cognito_response.get("AuthenticationResult")
    if not auth_result:
        print("ERROR: Cognito response missing AuthenticationResult", file=sys.stderr)
        print(json.dumps(cognito_response, indent=2), file=sys.stderr)
        return 1
    
    access_token = auth_result.get("AccessToken")
    if not access_token:
        print("ERROR: AuthenticationResult missing AccessToken", file=sys.stderr)
        print(json.dumps(auth_result, indent=2), file=sys.stderr)
        return 1
    
    print(f"[refresh] Got AccessToken (expires in {auth_result.get('ExpiresIn', 'unknown')}s)")
    
    # Verify against LitAlerts
    print(f"[verify] Testing token against {LITALERTS_VERIFY_URL}...")
    verify_request = urllib.request.Request(
        LITALERTS_VERIFY_URL,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    
    try:
        with urllib.request.urlopen(verify_request, timeout=30) as response:
            if response.status == 200:
                print(f"[verify] Token verified (HTTP {response.status})")
            else:
                print(f"WARNING: Unexpected HTTP {response.status}", file=sys.stderr)
    except urllib.error.HTTPError as e:
        print(f"ERROR: LitAlerts verification failed with HTTP {e.code}", file=sys.stderr)
        print(e.read().decode('utf-8', errors='replace')[:500], file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: LitAlerts verification request failed: {e}", file=sys.stderr)
        return 1
    
    # Write bearer token
    SECRET_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    BEARER_TOKEN_PATH.write_text(access_token)
    BEARER_TOKEN_PATH.chmod(0o600)
    print(f"[success] Wrote bearer token to {BEARER_TOKEN_PATH}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
