"""List every query parameter accepted by the list endpoints (from Django's own FilterSets)."""
import django, json
django.setup()
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.test import APIRequestFactory
from exact.api import router_api
from exact.users.models import User
out = {}
backend = DjangoFilterBackend()
for prefix, viewset, basename in router_api.registry:
    view = viewset()
    view.request = None
    try:
        qs = viewset.queryset if getattr(viewset, 'queryset', None) is not None else None
        model = viewset.serializer_class.Meta.model
        qs = model.objects.all()
        fs_class = backend.get_filterset_class(view, qs)
    except Exception as e:
        out[prefix] = f"ERR {e}"
        continue
    if fs_class is None:
        out[prefix] = []
        continue
    params = []
    for name, f in fs_class.base_filters.items():
        widget = f.field.widget
        suffixes = getattr(widget, 'suffixes', None)
        cls = f.__class__.__name__
        wname = f.field.widget.__class__.__name__
        fld = f.field.__class__.__name__
        if suffixes:
            for s in suffixes:
                params.append([f"{name}_{s}" if s else name, cls, fld, f.lookup_expr, f.field_name, getattr(f, 'method', None) and str(f.method)])
        else:
            params.append([name, cls, fld, f.lookup_expr, f.field_name, getattr(f, 'method', None) and str(f.method), wname])
    out[prefix] = params
print(json.dumps(out, indent=0))
