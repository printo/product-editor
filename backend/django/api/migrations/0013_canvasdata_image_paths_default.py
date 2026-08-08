from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Give CanvasData.image_paths a default so a new order's first autosave can
    create its row.

    CanvasStateView.put deliberately omits image_paths from update_or_create's
    `defaults` — the autosave payload never carries server-side file paths, and
    writing `image_paths or []` blanked them every 2 seconds, which is what
    broke DPDP erasure (docs/DPDP_ERASURE_GAP_PRD.md).

    But the column is NOT NULL with no default, so that correct decision failed
    on INSERT: the first autosave for a new order wrote NULL and Postgres
    rejected it with a 500. No row was created, so every subsequent autosave hit
    the same path — a new order never got its editor state persisted.

    A Django-level default applies on INSERT only and never on UPDATE, so
    creates now succeed while autosave still cannot clobber paths recorded at
    submit time.

    This was masked on the dashboard by a 502 in the internal proxy (the request
    never reached Django) and was live on the embed path, whose proxy already
    forwarded bodies correctly.
    """

    dependencies = [
        ('api', '0012_stamp_file_expiry'),
    ]

    operations = [
        migrations.AlterField(
            model_name='canvasdata',
            name='image_paths',
            field=models.JSONField(default=list, help_text='List of uploaded file paths'),
        ),
    ]
