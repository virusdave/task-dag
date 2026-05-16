#!/usr/bin/env python3
"""Authenticate to LitAlerts with email/password and MFA support."""

import json
import socket
import sys
import os
import urllib.error
import urllib.request
from pathlib import Path

_original_getaddrinfo = socket.getaddrinfo
def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_only_getaddrinfo

COGNITO_ENDPOINT = "https://cognito-idp.us-east-2.amazonaws.com/"
COGNITO_CLIENT_ID = "696jmvfc56kqe1bb38j55er8in"
LITALERTS_VERIFY_URL = "https://public-api.litalerts.com/Manufacturers/real?page=0&pagesize=1&state=NY"

PASSWORD_FILE = Path("/tmp/litalerts.pw")
SECRET_DIR = Path.home() / ".secret" / "litalerts"
REFRESH_TOKEN_PATH = SECRET_DIR / "refresh-token"
BEARER_TOKEN_PATH = SECRET_DIR / "bearer-token"

def cognito_request(target, body):
    request = urllib.request.Request(
        COGNITO_ENDPOINT,
        data=json.dumps(body).encode('utf-8'),
        headers={
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": f"AWSCognitoIdentityProviderService.{target}",
            "X-Amz-User-Agent": "aws-amplify/6.16.4 framework/0",
        },
        method="POST",
    )
    
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode('utf-8'))

def main():
    email = os.getenv("LITALERTS_EMAIL") or (sys.argv[1] if len(sys.argv) > 1 else None)
    otp_code = sys.argv[2] if len(sys.argv) > 2 else None
    
    if not email:
        print("ERROR: Email required", file=sys.stderr)
        print("Usage: ./authenticate_with_password.py <email> [otp-code]", file=sys.stderr)
        return 1

    password = PASSWORD_FILE.read_text().strip()
    
    print(f"[auth] Authenticating as {email}...")
    
    # InitiateAuth
    try:
        auth_response = cognito_request("InitiateAuth", {
            "AuthFlow": "USER_PASSWORD_AUTH",
            "ClientId": COGNITO_CLIENT_ID,
            "AuthParameters": {"USERNAME": email, "PASSWORD": password},
        })
    except urllib.error.HTTPError as e:
        print(f"ERROR: Auth failed HTTP {e.code}", file=sys.stderr)
        print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
        return 1

    # Check for MFA challenge
    if "ChallengeName" in auth_response:
        challenge = auth_response["ChallengeName"]
        session = auth_response["Session"]
        
        if challenge == "EMAIL_OTP":
            print(f"[mfa] EMAIL_OTP challenge required")
            print(f"[mfa] Code sent to: {auth_response['ChallengeParameters'].get('CODE_DELIVERY_DESTINATION', 'email')}")
            
            if not otp_code:
                print("\nERROR: OTP code required", file=sys.stderr)
                print("Usage: ./authenticate_with_password.py <email> <otp-code>", file=sys.stderr)
                return 1
            
            print(f"[mfa] Submitting OTP code...")
            
            # RespondToAuthChallenge with correct parameter name
            try:
                challenge_response = cognito_request("RespondToAuthChallenge", {
                    "ChallengeName": challenge,
                    "ClientId": COGNITO_CLIENT_ID,
                    "Session": session,
                    "ChallengeResponses": {
                        "EMAIL_OTP_CODE": otp_code,
                        "USERNAME": email
                    },
                })
                auth_response = challenge_response
            except urllib.error.HTTPError as e:
                print(f"ERROR: MFA challenge failed HTTP {e.code}", file=sys.stderr)
                print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
                return 1

    # Extract tokens
    auth_result = auth_response.get("AuthenticationResult")
    if not auth_result:
        print("ERROR: Missing AuthenticationResult", file=sys.stderr)
        return 1

    access_token = auth_result.get("AccessToken")
    refresh_token = auth_result.get("RefreshToken")
    
    if not access_token:
        print("ERROR: Missing AccessToken", file=sys.stderr)
        return 1

    print(f"[auth] Got tokens (expires in {auth_result.get('ExpiresIn', 'unknown')}s)")

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
    
    print(f"✅ Authentication complete")
    return 0

if __name__ == "__main__":
    sys.exit(main())
