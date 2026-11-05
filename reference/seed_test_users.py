"""Seed known test credentials into the SCRATCH DB (exact_rust_test) after a restore.

Test-only passwords; never run against a real DB (guarded by DB name).
Roles covered: superuser, staff, team admin, plain team member, outsider (other team only).
"""
import django, os, sys
django.setup()
from django.conf import settings
from django.contrib.auth import get_user_model
from exact.users.models import Team, TeamMembership

assert settings.DATABASES['default']['NAME'] in ('exact_rust_test', 'exact_rust_e2e', 'exact_django_test', 'exact_coexist', 'exact_coexist_pristine'), 'refusing: not a scratch DB'
PW = 'rust-test-pw'
U = get_user_model()

def user(name, **kw):
    u, _ = U.objects.get_or_create(username=name, defaults=dict(email=f'{name}@example.invalid', **kw))
    for k, v in kw.items():
        setattr(u, k, v)
    u.is_active = True
    u.set_password(PW)
    u.save()
    return u

su = U.objects.get(username='aubreville'); su.set_password(PW); su.save()
st = U.objects.get(username='brummel'); st.set_password(PW); st.save()
t1 = Team.objects.get(pk=1); t3 = Team.objects.get(pk=3)
for name, team, admin in [('rt_teamadmin', t1, True), ('rt_member', t1, False), ('rt_outsider', t3, False)]:
    u = user(name)
    TeamMembership.objects.update_or_create(team=team, user=u, defaults={'is_admin': admin})
# --- more accounts: other hash formats, inactive user, user with Django model permissions
from django.contrib.auth.hashers import make_password
from django.contrib.auth.models import Permission
for name, hasher in [('rt_argon', 'argon2'), ('rt_bcrypt', 'bcrypt_sha256'), ('rt_sha1', 'pbkdf2_sha1')]:
    u = user(name)
    u.password = make_password(PW, hasher=hasher)
    u.save()
    TeamMembership.objects.update_or_create(team=t1, user=u, defaults={'is_admin': False})
inactive = user('rt_inactive')
inactive.is_active = False
inactive.save()
TeamMembership.objects.update_or_create(team=t1, user=inactive, defaults={'is_admin': False})
perm = user('rt_perm')
TeamMembership.objects.update_or_create(team=t1, user=perm, defaults={'is_admin': False})
perm.user_permissions.set(Permission.objects.filter(content_type__app_label='users', codename__in=['add_team', 'change_team', 'delete_team']))

# --- site admin flag (gates impersonation); UserPreferences rows may not exist for old users
from exact.users.models import UserPreferences
for name, flag in [('aubreville', True), ('brummel', True), ('rt_teamadmin', False)]:
    pref, _ = UserPreferences.objects.get_or_create(user=U.objects.get(username=name))
    pref.is_site_admin = flag
    pref.save()

# --- passkey fixture (enrolled once through the real django-passkeys endpoints, see enroll_passkey.py)
import json, pathlib, uuid
from passkeys.models import UserPasskey
fx_path = pathlib.Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'passkey.json'
if fx_path.exists():
    fx = json.loads(fx_path.read_text())
    row = fx['row']
    UserPasskey.objects.filter(credential_id=row['credential_id']).delete()
    UserPasskey.objects.create(user=U.objects.get(username=fx['username']), name=row['name'], platform=row['platform'],
                               enabled=True, credential_id=row['credential_id'], token=row['token'])

# --- personal access tokens with fixed secrets (so tests can use them)
import hashlib
from django.utils import timezone
from datetime import timedelta
from exact.users.models import PersonalAccessToken
TOKENS = {  # name -> (user, secret, kwargs)
    'full': ('rt_member', 'pat_rtfull000001.secret-full', {}),
    'readonly': ('rt_member', 'pat_rtreadonly01.secret-ro', {'read_only': True}),
    'team1': ('aubreville', 'pat_rtteam100001.secret-team1', {}),
    'revoked': ('rt_member', 'pat_rtrevoked001.secret-rev', {'revoked_at': timezone.now()}),
    'inactive': ('rt_inactive', 'pat_rtinactive01.secret-inactive', {}),
    'expired': ('rt_member', 'pat_rtexpired001.secret-exp', {'expires_at': timezone.now() - timedelta(days=1)}),
}
PersonalAccessToken.objects.filter(name__startswith='rt-test-').delete()
for key, (uname, tok, kw) in TOKENS.items():
    pat = PersonalAccessToken.objects.create(user=U.objects.get(username=uname), name=f'rt-test-{key}',
                                             prefix=tok.split('.')[0][4:], token_hash=hashlib.sha256(tok.encode()).hexdigest(), **kw)
    if key == 'team1':
        pat.teams.set([t1])
# --- data for resources that are empty in the local database (so Rust-vs-Django comparisons are not vacuous)
import uuid
from django.utils import timezone
from exact.images.models import Image, ImageSet, SetVersion
from exact.annotations.models import Annotation, AnnotationType, AnnotationVersion, AnnotationMediaFile
from exact.administration.models import Product
from exact.processing.models import Plugin, PluginJob, PluginResult, PluginResultEntry, PluginResultBitmap, PluginResultAnnotation

if not Plugin.objects.exists():
    img = Image.objects.order_by('id').first()
    img2 = Image.objects.order_by('id')[1]
    product = Product.objects.order_by('id').first()
    atype = AnnotationType.objects.order_by('id').first()
    owner = U.objects.get(username='brummel')
    plugin = Plugin.objects.create(name='MIDOG test plugin', author='Test', package='org.test.midog', contact='test@example.invalid',
                                   abouturl='https://example.invalid/', icon='plugins/icon.png')
    plugin.products.add(product)
    Plugin.objects.create(name='Another plugin', author='Test', package='org.test.other', contact='o@example.invalid', abouturl='https://example.invalid/o', icon='plugins/other.png')
    done = PluginJob.objects.create(plugin=plugin, creator=owner, image=img, processing_complete=100.0)
    PluginJob.objects.create(plugin=plugin, creator=owner, image=img2, processing_complete=35.5, attached_worker='worker-a', error_message=None)
    PluginJob.objects.create(plugin=plugin, creator=None, image=img2, processing_complete=0.0, error_message='boom', error_detail='trace')
    res = PluginResult.objects.create(plugin=plugin, job=done, image=img, default_alpha=0.5)
    entry = PluginResultEntry.objects.create(pluginresult=res, name='Mitotic figures', visible=True, default_threshold=0.4)
    entry2 = PluginResultEntry.objects.create(pluginresult=res, name='Heatmap', visible=False, default_threshold=0.0)
    PluginResultBitmap.objects.create(pluginresultentry=entry2, image=img, name='heat', bitmap='plugins/bitmaps/heat.png', channels=1, default_alpha=0.7,
                                      default_threshold=0.1, scale_min=0, scale_max=1, frame=1, location_rect={'x': 0, 'y': 0, 'w': 100, 'h': 100}, meta_data={'k': 'v'})
    for i in range(3):
        PluginResultAnnotation.objects.create(pluginresultentry=entry, image=img, annotation_type=atype, vector={'x1': 10 + i, 'y1': 20 + i, 'x2': 30 + i, 'y2': 40 + i},
                                              score=0.5 + i / 10, meta_data={'i': i}, description=f'candidate {i}',
                                              unique_identifier=uuid.uuid5(uuid.NAMESPACE_URL, f'exact-rust-test/pra/{i}'))

if not SetVersion.objects.exists():
    iset = ImageSet.objects.order_by('id').first()
    ver = SetVersion.objects.create(name='v1', file='versions/v1.zip')
    ver.imagesets.add(iset)
    ver2 = SetVersion.objects.create(name='v2', file='')
    ver2.imagesets.add(iset)
    for k, a in enumerate(Annotation.objects.filter(image__image_set=iset).order_by('id')[:4]):
        # first two versions differ from the live annotation (has_changes), the others are identical
        AnnotationVersion.objects.create(version=ver, annotation=a, image=a.image, annotation_type=a.annotation_type,
                                         deleted=(k == 0), vector=a.vector if k > 1 else {'x1': 1, 'y1': 2, 'x2': 3, 'y2': 4})
    AnnotationMediaFile.objects.create(name='note.png', media_file_type=2, annotation=Annotation.objects.order_by('id').first(), file='annotations/1/note.png')
    AnnotationMediaFile.objects.create(name='clip.mp4', media_file_type=3, annotation=Annotation.objects.order_by('id').first(), file='annotations/1/clip name.mp4')

print('seeded; password for all test users:', PW)
