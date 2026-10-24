#!/bin/sh
set -eu

# SQLite cannot safely use Windows bind-mounted files from Linux containers.
# Keep the runtime database in a Docker volume and seed it from the existing
# local database on the first container start.
db_path="${FABULA_DB_PATH:-/app/runtime/writerx.db}"
mkdir -p "$(dirname "$db_path")"
if [ ! -f "$db_path" ] && [ -f /app/data/writerx.db ]; then
  cp /app/data/writerx.db "$db_path"
fi

exec "$@"
