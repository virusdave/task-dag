#!/usr/bin/env python3
import json
import socket
import sys
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

SECRET_DIR = Path.home() / ".secret" / "litalerts"
REFRESH_TOKEN_PATH = SECRET_DIR / "refresh-token"
BEARER_TOKEN_PATH = SECRET_DIR / "bearer-token"

refresh_token = REFRESH_TOKEN_PATH.read_text().strip()

cognito_request = urllib.request.Request(
    COGNITO_ENDPOINT,
    data=json.dumps({
        "ClientId": COGNITO_CLIENT_ID,
        "RefreshToken": refresh_token,
    }).encode('utf-8'),
    headers={
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.GetTokensFromRefreshToken",
        "X-Amz-User-Agent": "aws-amplify/6.16.4 framework/0",
    },
    method="POST",
)

with urllib.request.urlopen(cognito_request, timeout=30) as response:
    cognito_response = json.loads(response.read().decode('utf-8'))

access_token = cognito_response["AuthenticationResult"]["AccessToken"]
BEARER_TOKEN_PATH.write_text(access_token)
BEARER_TOKEN_PATH.chmod(0o600)
print(f"[success] Refreshed bearer token")
