# LayoutTag: the ops-managed tag list, seeded with the nine tags that used to
# be hard-coded in the frontend (lib/product-tags.ts). Every layout's `tags`
# (names) becomes `tagKeys` (keys); a name that matches no seed tag becomes a
# tag of its own, so nothing a layout carried is lost. Reversible: the reverse
# writes the names back as `tags`.

from django.db import migrations, models

SEED_TAGS = [
    ('photo_prints', 'Photo Prints'),
    ('canvas_prints', 'Canvas Prints'),
    ('magnets', 'Magnets'),
    ('coasters', 'Coasters'),
    ('mugs', 'Mugs'),
    ('stationery', 'Stationery'),
    ('gifts', 'Gifts'),
    ('calendar', 'Calendar'),
    ('photobook', 'Photobook'),
]


def _key_for(name, taken):
    import re
    base = '_'.join(re.findall(r'[a-z0-9]+', name.lower()))[:44].strip('_') or 'tag'
    key, n = base, 2
    while key in taken:
        key = f'{base}_{n}'
        n += 1
    return key


def forwards(apps, schema_editor):
    LayoutTag = apps.get_model('api', 'LayoutTag')
    LayoutCatalogue = apps.get_model('api', 'LayoutCatalogue')

    key_by_name = {}
    for key, name in SEED_TAGS:
        LayoutTag.objects.get_or_create(key=key, defaults={'name': name})
        key_by_name[name.lower()] = key
    taken = set(LayoutTag.objects.values_list('key', flat=True))

    for layout in LayoutCatalogue.objects.all():
        definition = layout.definition if isinstance(layout.definition, dict) else None
        if definition is None or 'tagKeys' in definition:
            continue
        names = definition.get('tags')
        keys = []
        for raw in names if isinstance(names, list) else []:
            name = ' '.join(str(raw or '').split())[:60]
            if not name:
                continue
            key = key_by_name.get(name.lower())
            if key is None:
                key = _key_for(name, taken)
                LayoutTag.objects.create(key=key, name=name)
                taken.add(key)
                key_by_name[name.lower()] = key
            if key not in keys:
                keys.append(key)
        definition = {k: v for k, v in definition.items() if k != 'tags'}
        definition['tagKeys'] = keys
        # .update(): not a design change, so no version bump and no
        # "layout changed" flag on its templates.
        LayoutCatalogue.objects.filter(pk=layout.pk).update(definition=definition)


def backwards(apps, schema_editor):
    LayoutTag = apps.get_model('api', 'LayoutTag')
    LayoutCatalogue = apps.get_model('api', 'LayoutCatalogue')
    name_by_key = dict(LayoutTag.objects.values_list('key', 'name'))
    for layout in LayoutCatalogue.objects.all():
        definition = layout.definition if isinstance(layout.definition, dict) else None
        if definition is None or 'tagKeys' not in definition:
            continue
        keys = definition.get('tagKeys') or []
        definition = {k: v for k, v in definition.items() if k != 'tagKeys'}
        definition['tags'] = [name_by_key.get(k, k) for k in keys]
        LayoutCatalogue.objects.filter(pk=layout.pk).update(definition=definition)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0023_embedsession_orientation'),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutTag',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(db_index=True, help_text="e.g. 'photo_prints'. Lowercase letters, digits and single underscores. Immutable.", max_length=50, unique=True)),
                ('name', models.CharField(help_text="What people see, e.g. 'Photo Prints'. Renameable.", max_length=60)),
                ('is_active', models.BooleanField(db_index=True, default=True, help_text='Switched-off tags stay on the layouts that carry them but leave the picker.')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'layout_tags',
                'ordering': ['name', 'key'],
            },
        ),
        migrations.RunPython(forwards, backwards),
    ]
