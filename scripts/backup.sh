#!/usr/bin/env sh
# Backup Postgres + MinIO objects from the running compose stack.
#   scripts/backup.sh [compose-file]            → ./backups/<timestamp>/
# Restore with scripts/restore.sh. Test restores regularly (§7.8 "tested backups").
set -eu
export MSYS_NO_PATHCONV=1  # Git Bash on Windows: do not rewrite container paths
COMPOSE_FILE="${1:-docker-compose.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/$STAMP"
mkdir -p "$OUT"
DC="docker compose -f $COMPOSE_FILE"

echo "→ Postgres dump"
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d gembadocs --format=custom --no-owner' > "$OUT/playbook.dump"

echo "→ MinIO objects"
MINIO_CID="$($DC ps -q minio)"
docker run --rm --volumes-from "$MINIO_CID" alpine:3 tar -C /data -cf - . > "$OUT/minio-data.tar"

( cd "$OUT" && sha256sum playbook.dump minio-data.tar > SHA256SUMS )
echo "Backup written to $OUT"
