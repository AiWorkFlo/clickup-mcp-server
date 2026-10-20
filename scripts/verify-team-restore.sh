#!/bin/sh
# Restores into an isolated temporary database, verifies table counts, then removes it.
set -eu
umask 077
container=0gaxbfswtrj7yqdv7xesjqxl
database="clickup_restore_$(date -u +%Y%m%d%H%M%S)_$$"
backup=${1:?Pass an absolute backup dump path}
case "$backup" in /data/backups/clickup-api/clickup-team-*.dump) ;; *) exit 2 ;; esac
test -f "$backup"
docker exec "$container" createdb -U clickup_team "$database"
trap 'docker exec "$container" dropdb -U clickup_team --if-exists "$database" >/dev/null' EXIT HUP INT TERM
docker exec -i "$container" pg_restore -U clickup_team --dbname="$database" --no-owner --exit-on-error <"$backup"
for table in team_users team_grants team_settings; do
  docker exec "$container" psql -U clickup_team -d "$database" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM $table" >/dev/null
done
printf '%s\n' 'ClickUp backup restoration verified in an isolated database.'
