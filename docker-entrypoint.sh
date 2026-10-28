#!/bin/sh
set -eu

# SQLite cannot safely use Windows bind-mounted files from Linux containers.
# Keep the runtime database in a Docker volume and seed it on first start:
#   1) an existing local database mounted at /app/data/writerx.db, or
#   2) the bundled seed shipped in the image.
db_path="${FABULA_DB_PATH:-/app/runtime/writerx.db}"
export FABULA_DB_PATH="$db_path"
mkdir -p "$(dirname "$db_path")" /app/data
if [ ! -f "$db_path" ]; then
  if [ -f /app/data/writerx.db ]; then
    cp /app/data/writerx.db "$db_path"
  elif [ -f /app/resources/writerx.seed.db ]; then
    cp /app/resources/writerx.seed.db "$db_path"
  fi
fi

exec "$@"
