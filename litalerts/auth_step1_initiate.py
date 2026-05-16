#!/usr/bin/env python3
"""Step 1: Initiate LitAlerts auth and request OTP"""

import json
import socket
import urllib.request
from pathlib import Path

_original_getaddrinfo = socket.getaddrinfo
def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _ipv4_only_getaddrinfo

COGNITO_ENDPOINT = "https://cognito-idp.us-east-2.amazonaws.com/"
COGNITO_CLIENT_ID = "696jmvfc56kqe1bb38j55er8in"
PASSWORD_FILE = Path("/tmp/litalerts.pw")
SESSION_FILE = Path("/tmp/litalerts-session.json")

email = "dave.freshlybakednyc"
password = PASSWORD_FILE.read_text().strip()

print(f"[step1] Initiating auth for {email}...")

auth_request = urllib.request.Request(
    COGNITO_ENDPOINT,
    data=json.dumps({
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": COGNITO_CLIENT_ID,
        "AuthParameters": {"USERNAME": email, "PASSWORD": password},
    }).encode('utf-8'),
    headers={
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        "X-Amz-User-Agent": "aws-amplify/6.16.4 framework/0",
    },
    method="POST",
)

with urllib.request.urlopen(auth_request, timeout=30) as response:
    auth_response = json.loads(response.read().decode('utf-8'))

# Save session for step 2
SESSION_FILE.write_text(json.dumps(auth_response, indent=2))
print(f"[step1] Session saved to {SESSION_FILE}")
print(f"[step1] Challenge: {auth_response.get('ChallengeName')}")
print(f"[step1] OTP sent to: {auth_response.get('ChallengeParameters', {}).get('CODE_DELIVERY_DESTINATION')}")
print(f"\nNow run: ./auth_step2_complete.py <otp-code>")
