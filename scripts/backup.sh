#!/bin/sh
# Dumps the database every BACKUP_INTERVAL_HOURS into /backups and deletes
# dumps older than BACKUP_KEEP_DAYS. Connection from PGHOST, PGUSER,
# PGPASSWORD and PGDATABASE. Restore with:
#   pg_restore --clean --if-exists -d drawdb <file>
set -u
interval=$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))
keep=${BACKUP_KEEP_DAYS:-14}

until pg_isready -q; do sleep 2; done
while true; do
  file="/backups/drawdb-$(date -u +%Y%m%d-%H%M%S).dump"
  if pg_dump -Fc -f "$file.part"; then
    mv "$file.part" "$file"
    echo "Backed up to $file"
  else
    rm -f "$file.part"
    echo "Backup failed" >&2
  fi
  find /backups -name 'drawdb-*.dump' -mtime +"$keep" -delete
  sleep "$interval"
done
