"""
Squash-safe migration for canvas_data and render_jobs tables.

Background: CanvasData and RenderJob were added to 0001_initial.py as part of a
migration squash. On fresh deployments 0001 creates these tables (including
callback_url). On existing deployments that had the old 0001 (without these
models), this migration creates the tables and adds callback_url safely using
CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so it is idempotent in
all three scenarios:

  1. Fresh install: 0001 created everything → all IF NOT EXISTS are no-ops.
  2. Existing prod without canvas_data/render_jobs: tables are created here.
  3. Existing prod with tables but without callback_url: only the column is added.
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(
            sql="""
                -- ── canvas_data ───────────────────────────────────────────────
                CREATE TABLE IF NOT EXISTS canvas_data (
                    id                     UUID                     NOT NULL PRIMARY KEY,
                    order_id               VARCHAR(100)             NOT NULL,
                    layout_name            VARCHAR(255)             NOT NULL,
                    image_paths            JSONB                    NOT NULL,
                    fit_mode               VARCHAR(20)              NOT NULL DEFAULT 'cover',
                    export_format          VARCHAR(20)              NOT NULL DEFAULT 'png',
                    soft_proof             BOOLEAN                  NOT NULL DEFAULT FALSE,
                    callback_url           VARCHAR(2000)            NULL,
                    created_at             TIMESTAMPTZ              NOT NULL,
                    expires_at             TIMESTAMPTZ              NOT NULL,
                    requires_manual_review BOOLEAN                  NOT NULL DEFAULT FALSE,
                    api_key_id             BIGINT                   NOT NULL
                        REFERENCES api_keys(id) DEFERRABLE INITIALLY DEFERRED,
                    CONSTRAINT canvas_data_order_id_key UNIQUE (order_id)
                );

                CREATE INDEX IF NOT EXISTS canvas_data_order_i_86b782_idx
                    ON canvas_data (order_id);
                CREATE INDEX IF NOT EXISTS canvas_data_created_07f7ab_idx
                    ON canvas_data (created_at);
                CREATE INDEX IF NOT EXISTS canvas_data_api_key_id_9d341ce4
                    ON canvas_data (api_key_id);

                -- ── render_jobs ───────────────────────────────────────────────
                CREATE TABLE IF NOT EXISTS render_jobs (
                    id                  UUID         NOT NULL PRIMARY KEY,
                    celery_task_id      VARCHAR(255) NULL,
                    status              VARCHAR(20)  NOT NULL DEFAULT 'queued',
                    queue_name          VARCHAR(50)  NOT NULL,
                    output_paths        JSONB        NULL,
                    error_message       TEXT         NULL,
                    created_at          TIMESTAMPTZ  NOT NULL,
                    started_at          TIMESTAMPTZ  NULL,
                    completed_at        TIMESTAMPTZ  NULL,
                    generation_time_ms  INTEGER      NULL,
                    retry_count         INTEGER      NOT NULL DEFAULT 0,
                    canvas_data_id      UUID         NOT NULL
                        REFERENCES canvas_data(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
                    CONSTRAINT render_jobs_celery_task_id_key UNIQUE (celery_task_id)
                );

                CREATE INDEX IF NOT EXISTS render_jobs_celery__8d3cd8_idx
                    ON render_jobs (celery_task_id);
                CREATE INDEX IF NOT EXISTS render_jobs_status_8b4c5f_idx
                    ON render_jobs (status, created_at);
                CREATE INDEX IF NOT EXISTS render_jobs_canvas_data_id_37941e14
                    ON render_jobs (canvas_data_id);

                -- ── callback_url column (existing tables without it) ──────────
                ALTER TABLE canvas_data
                    ADD COLUMN IF NOT EXISTS callback_url VARCHAR(2000) NULL;
            """,
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
