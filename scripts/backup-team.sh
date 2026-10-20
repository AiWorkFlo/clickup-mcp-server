#!/bin/sh
# Run as root on the Coolify host. No application secret is passed on the command line.
set -eu
umask 077
container=0gaxbfswtrj7yqdv7xesjqxl
directory=/data/backups/clickup-api
install -d -m 700 "$directory"
exec 9>"$directory/.backup.lock"
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$directory/.backup-$stamp.tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
docker exec "$container" pg_dump -U clickup_team -d clickup_team --format=custom >"$temporary"
test -s "$temporary"
docker exec -i "$container" pg_restore --list <"$temporary" >/dev/null
mv "$temporary" "$directory/clickup-team-$stamp.dump"
find "$directory" -maxdepth 1 -type f -name 'clickup-team-*.dump' -mtime +6 -delete
printf '%s\n' 'ClickUp authentication database backup complete.'
