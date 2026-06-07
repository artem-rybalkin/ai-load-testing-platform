#!/bin/sh
# Run by PostgreSQL on first init — creates the replication user
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Allow alt_user (already a superuser) to stream replication
  ALTER USER alt_user REPLICATION;
EOSQL
