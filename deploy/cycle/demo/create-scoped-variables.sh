#!/usr/bin/env bash
# Creates the scoped variables Deputies needs in a Cycle environment.
# Usage: ENVIRONMENT_ID=<24-char id> ./create-scoped-variables.sh
#
# Reads CYCLE_API_KEY, CYCLE_HUB_ID, CYCLE_API_BASE_URL, ANTHROPIC_API_KEY and
# DAYTONA_API_KEY from the environment. Generates fresh random values for the
# database password, login password, session secret and sandbox-secret key
# unless PGPW, LOGINPW, SESSSECRET and SANDBOXKEY are already set.
# Prints only identifiers; the login is written to ./deputies-login.txt (mode 600).
set -euo pipefail
: "${ENVIRONMENT_ID:?set ENVIRONMENT_ID}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
: "${DAYTONA_API_KEY:?set DAYTONA_API_KEY}"
umask 077
here=$(cd "$(dirname "$0")" && pwd)

PGPW=${PGPW:-$(openssl rand -hex 24)}
LOGINPW=${LOGINPW:-$(openssl rand -hex 12)}
SESSSECRET=${SESSSECRET:-$(openssl rand -hex 32)}
SANDBOXKEY=${SANDBOXKEY:-$(openssl rand -base64 32)}

post() {
  curl -sS -X POST "$CYCLE_API_BASE_URL/environments/$ENVIRONMENT_ID/scoped-variables" \
    -H "Authorization: Bearer $CYCLE_API_KEY" -H "X-Hub-Id: $CYCLE_HUB_ID" \
    -H 'Content-Type: application/json' --data @- |
    jq -c '{identifier: .data.identifier, error: .error.title}'
}

secret() { # identifier container env-key value
  jq -n --arg id "$1" --arg c "$2" --arg k "$3" --arg v "$4" '{
      identifier: $id,
      scope: {containers: {global: false, identifiers: [$c]}},
      access: {env_variable: {key: $k}},
      source: {type: "raw", details: {value: $v, secret: {}}}
    }' | post
}

secret postgres-password postgres POSTGRES_PASSWORD "$PGPW"
secret database-url api DATABASE_URL "postgres://deputies:$PGPW@postgres:5432/deputies"
secret auth-password api AUTH_STATIC_PASSWORD "$LOGINPW"
secret auth-session-secret api AUTH_SESSION_SECRET "$SESSSECRET"
secret sandbox-secret-encryption-key api SANDBOX_SECRET_ENCRYPTION_KEY "$SANDBOXKEY"
secret anthropic-api-key api ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
secret daytona-api-key api DAYTONA_API_KEY "$DAYTONA_API_KEY"

# Only Deputies 0.27.x reads this: its Pi (0.83.0) predates Claude Haiku 5.5,
# and deputies-app-stack-0.27.1.json points PI_CODING_AGENT_DIR here. 0.28.0
# knows the model natively and ignores the file.
jq -n --rawfile v "$here/pi-models.json" '{
    identifier: "pi-models",
    scope: {containers: {global: false, identifiers: ["api"]}},
    access: {file: {path: "/home/node/.pi/agent/models.json", uid: 1000, gid: 1000, permissions: "0644"}},
    source: {type: "raw", details: {value: $v, blob: true}}
  }' | post

printf 'username: deputies\npassword: %s\n' "$LOGINPW" > deputies-login.txt
echo "Login written to $(pwd)/deputies-login.txt"
