"""
A new column must not break code that has never heard of it.

deploy.sh migrates the database BEFORE it swaps containers, and a rollback
runs an older image on the newer schema. In both cases code that predates a
column INSERTs rows without it. If that column is NOT NULL and has no default
in the database, Postgres refuses the row: on 2026-11-05 two such columns went
out (`api_keys.allowed_photo_hosts`, `uploaded_files.source_key`), and a
rollback that day would have failed every photo upload.

So a new column is either nullable or carries a database default
(`db_default=` on the field). This test fails on one that is neither.

`GRANDFATHERED` is every NOT NULL column without a database default that
existed when the rule was written. Each is set by all code that has ever
inserted into its table, so none can strand an older image. Do not add to it:
give the new column `null=True` or `db_default=` instead.

Needs Postgres, like the rest of api/tests/.
"""
from django.db import connection
from django.test import TestCase

TABLES = (
    'api_keys', 'api_requests', 'uploaded_files', 'exported_results', 'embed_sessions',
    'canvas_data', 'render_jobs', 'layout_catalogue', 'layout_templates', 'layout_tags',
)

GRANDFATHERED = frozenset({
    ('api_keys', 'can_access_exports'),
    ('api_keys', 'can_generate_layouts'),
    ('api_keys', 'can_list_layouts'),
    ('api_keys', 'created_at'),
    ('api_keys', 'description'),
    ('api_keys', 'is_active'),
    ('api_keys', 'is_ops_team'),
    ('api_keys', 'key'),
    ('api_keys', 'name'),
    ('api_keys', 'updated_at'),
    ('api_requests', 'auth_source'),
    ('api_requests', 'created_at'),
    ('api_requests', 'endpoint'),
    ('api_requests', 'method'),
    ('api_requests', 'request_metadata'),
    ('api_requests', 'response_time_ms'),
    ('api_requests', 'status_code'),
    ('api_requests', 'user_agent'),
    ('canvas_data', 'api_key_id'),
    ('canvas_data', 'created_at'),
    ('canvas_data', 'expires_at'),
    ('canvas_data', 'export_format'),
    ('canvas_data', 'fit_mode'),
    ('canvas_data', 'id'),
    ('canvas_data', 'image_paths'),
    ('canvas_data', 'layout_name'),
    ('canvas_data', 'order_id'),
    ('canvas_data', 'requires_manual_review'),
    ('canvas_data', 'updated_at'),
    ('embed_sessions', 'api_key_id'),
    ('embed_sessions', 'callback_url'),
    ('embed_sessions', 'created_at'),
    ('embed_sessions', 'expires_at'),
    ('embed_sessions', 'include_uploads'),
    ('embed_sessions', 'is_revoked'),
    ('embed_sessions', 'order_id'),
    ('embed_sessions', 'orientation'),
    ('embed_sessions', 'token'),
    ('exported_results', 'api_key_id'),
    ('exported_results', 'created_at'),
    ('exported_results', 'export_file_path'),
    ('exported_results', 'file_size_bytes'),
    ('exported_results', 'generation_time_ms'),
    ('exported_results', 'input_files'),
    ('exported_results', 'is_deleted'),
    ('exported_results', 'layout_name'),
    ('layout_catalogue', 'category'),
    ('layout_catalogue', 'created_at'),
    ('layout_catalogue', 'definition'),
    ('layout_catalogue', 'display_name'),
    ('layout_catalogue', 'imported_by'),
    ('layout_catalogue', 'is_deprecated'),
    ('layout_catalogue', 'is_public'),
    ('layout_catalogue', 'name'),
    ('layout_catalogue', 'product_type'),
    ('layout_catalogue', 'updated_at'),
    ('layout_catalogue', 'version'),
    ('layout_tags', 'created_at'),
    ('layout_tags', 'is_active'),
    ('layout_tags', 'key'),
    ('layout_tags', 'name'),
    ('layout_tags', 'updated_at'),
    ('layout_templates', 'created_at'),
    ('layout_templates', 'decoration'),
    ('layout_templates', 'display_name'),
    ('layout_templates', 'is_deleted'),
    ('layout_templates', 'layout_name'),
    ('layout_templates', 'layout_version'),
    ('layout_templates', 'orientation'),
    ('layout_templates', 'status'),
    ('layout_templates', 'template_id'),
    ('layout_templates', 'thumbnail_url'),
    ('layout_templates', 'updated_at'),
    ('render_jobs', 'canvas_data_id'),
    ('render_jobs', 'created_at'),
    ('render_jobs', 'id'),
    ('render_jobs', 'queue_name'),
    ('render_jobs', 'retry_count'),
    ('render_jobs', 'status'),
    ('uploaded_files', 'api_key_id'),
    ('uploaded_files', 'created_at'),
    ('uploaded_files', 'file_path'),
    ('uploaded_files', 'file_size_bytes'),
    ('uploaded_files', 'file_type'),
    ('uploaded_files', 'is_deleted'),
    ('uploaded_files', 'order_id'),
    ('uploaded_files', 'original_filename'),
})


def _required_without_default():
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND is_nullable = 'NO' AND column_default IS NULL
              AND is_identity = 'NO' AND table_name = ANY(%s)
            """,
            [list(TABLES)],
        )
        return {(table, column) for table, column in cur.fetchall()}


def _default_of(table, column):
    with connection.cursor() as cur:
        cur.execute(
            "SELECT column_default FROM information_schema.columns WHERE table_name = %s AND column_name = %s",
            [table, column],
        )
        row = cur.fetchone()
    return row[0] if row else None


class RollbackSafeColumnsTest(TestCase):

    def test_no_new_required_column_lacks_a_database_default(self):
        added = _required_without_default() - GRANDFATHERED
        self.assertEqual(
            added, set(),
            "These columns are NOT NULL with no default in the database, so code that predates them "
            "cannot insert a row (the deploy migrates before it swaps containers, and a rollback runs "
            "older code on this schema). Give each `null=True` or `db_default=...`: "
            + ", ".join(f"{t}.{c}" for t, c in sorted(added)),
        )

    def test_the_grandfathered_list_holds_nothing_that_is_gone(self):
        self.assertEqual(GRANDFATHERED - _required_without_default(), set())

    def test_the_two_columns_from_2026_11_05_have_a_database_default(self):
        self.assertIsNotNone(_default_of('api_keys', 'allowed_photo_hosts'))
        self.assertIsNotNone(_default_of('uploaded_files', 'source_key'))

    def test_code_that_has_never_heard_of_them_can_still_insert(self):
        """What an older image does: an INSERT that names neither new column."""
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO api_keys (name, key, description, is_active, is_ops_team, can_generate_layouts,
                                      can_list_layouts, can_access_exports, created_at, updated_at)
                VALUES ('older-code-key', 'older-code-key-value', '', true, false, true, true, true, now(), now())
                RETURNING id, allowed_photo_hosts
                """
            )
            key_id, hosts = cur.fetchone()
            self.assertEqual(hosts, '')
            cur.execute(
                """
                INSERT INTO uploaded_files (api_key_id, file_path, original_filename, file_size_bytes, file_type,
                                            order_id, created_at, is_deleted)
                VALUES (%s, '/tmp/older-code.jpg', 'older-code.jpg', 1, 'image', 'JOB-1', now(), false)
                RETURNING source_key
                """,
                [key_id],
            )
            self.assertEqual(cur.fetchone()[0], '')
