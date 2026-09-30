#!/usr/bin/env sh
# Restore a backup produced by scripts/backup.sh INTO A STOPPED-TRAFFIC STACK.
#   scripts/restore.sh backups/<timestamp> [compose-file]
# WARNING: replaces the current database and object store contents.
set -eu
export MSYS_NO_PATHCONV=1  # Git Bash on Windows: do not rewrite container paths
DIR="$1"
COMPOSE_FILE="${2:-docker-compose.yml}"
DC="docker compose -f $COMPOSE_FILE"
( cd "$DIR" && sha256sum -c SHA256SUMS )

echo "→ Stopping app containers"
$DC stop api worker web || true

echo "→ Restoring Postgres"
$DC exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists gembadocs && createdb -U "$POSTGRES_USER" gembadocs'
$DC exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d gembadocs --no-owner' < "$DIR/gembadocs.dump"

echo "→ Restoring MinIO objects"
MINIO_CID="$($DC ps -q minio)"
$DC stop minio
docker run --rm -i --volumes-from "$MINIO_CID" alpine:3 sh -c 'rm -rf /data/* /data/.minio.sys; tar -C /data -xf -' < "$DIR/minio-data.tar"
$DC start minio

echo "→ Starting app containers"
$DC start api worker web
echo "Restore complete."
