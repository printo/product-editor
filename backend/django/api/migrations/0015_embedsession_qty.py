from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Store the ordered quantity on the embed session.

    `qty` shipped (PR #106) as a plain URL parameter on the iframe —
    `?token=<uuid>&qty=12` — read once on mount and enforced entirely in the
    browser. The customer's browser owns that URL, so the cap was advisory:
    editing the number, or posting straight at /api/editor/render, bypassed it.

    Nullable rather than 0-defaulted, because "the caller did not send a
    quantity" and "the caller ordered nothing" must stay distinguishable. Every
    session created before this migration reads NULL, which means the render
    submission is not qty-checked at all — the same behaviour those sessions
    already had. The editor keeps honouring the URL param as a fallback, so
    nothing breaks while printo.in moves the value into the session body.
    """

    dependencies = [
        ('api', '0014_audit_trail'),
    ]

    operations = [
        migrations.AddField(
            model_name='embedsession',
            name='qty',
            field=models.PositiveIntegerField(blank=True, default=None, null=True),
        ),
    ]
