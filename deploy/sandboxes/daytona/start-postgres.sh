#!/usr/bin/env bash
set -euo pipefail

postgres_bin=$(pg_config --bindir)
export PATH="$postgres_bin:$PATH"

PGDATA=${PGDATA:-$HOME/.deputies/postgres}
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-deputies}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-deputies}
POSTGRES_DB=${POSTGRES_DB:-deputies}
TEST_POSTGRES_DB=${TEST_POSTGRES_DB:-deputies_test}
POSTGRES_LOG=${POSTGRES_LOG:-$PGDATA/postgres.log}

mkdir -p "$PGDATA"

if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  initdb -D "$PGDATA" --username="$POSTGRES_USER" --pwfile=<(printf '%s\n' "$POSTGRES_PASSWORD") --auth-host=scram-sha-256 --auth-local=trust >/dev/null
  {
    printf "listen_addresses = '%s'\n" "$PGHOST"
    printf "port = %s\n" "$PGPORT"
    printf "unix_socket_directories = '%s'\n" "$PGDATA"
  } >> "$PGDATA/postgresql.conf"
fi

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -l "$POSTGRES_LOG" start >/dev/null
fi

for _ in {1..60}; do
  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export PGPASSWORD="$POSTGRES_PASSWORD"

for database in "$POSTGRES_DB" "$TEST_POSTGRES_DB"; do
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -qx 1; then
    createdb -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" "$database"
  fi
done

printf 'Postgres is ready at postgres://%s:%s@%s:%s/%s\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$PGHOST" "$PGPORT" "$POSTGRES_DB"
