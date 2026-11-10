#!/usr/bin/env bash
# PostgreSQL with the pg_cron/pg_net test stubs, on a GitHub-hosted runner.
#
# A stock postgres:17 service image has neither pg_cron nor pg_net, both of
# which the repository's own migrations create extensions for and call
# directly (cron.schedule/cron.unschedule -- everything else, including every
# net.http_get/http_post call, only ever appears as text inside a pg_cron job
# body, never executed at migration-apply time). The real pg_cron also
# requires shared_preload_libraries and restricts scheduling to one fixed
# database via cron.database_name -- structurally incompatible with a
# per-run throwaway database. Installing Postgres natively (rather than as a
# Docker service) lets the stand-ins in supabase/test/fake-extensions go in
# before the server ever starts, with no preload/restart dance and no
# database-name restriction.
#
# Used by the migrations job, which builds and tests fresh databases, and the
# release job, which builds one to compare production's catalog with.
set -euo pipefail

sudo systemctl start postgresql.service
PGVER=$(ls /usr/share/postgresql/)
sudo cp supabase/test/fake-extensions/*.control supabase/test/fake-extensions/*.sql "/usr/share/postgresql/$PGVER/extension/"
sudo systemctl restart postgresql.service
sudo -u postgres psql -c "alter user postgres password 'postgres';"
pg_isready -h localhost -p 5432 -U postgres
