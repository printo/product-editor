FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"

RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv

WORKDIR /app
COPY backend/django/requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/requirements.txt

COPY backend/django /app

# Bundle ICC colour profiles for CMYK soft-proof conversion.
# icc_profiles/ISOcoated_v2_eci.icc must exist locally before building.
# See backend/django/icc_profiles/README.md for download instructions.
# The directory is always copied; the engine falls back gracefully if the
# .icc file is absent (profile-less conversion with a logged warning).
COPY backend/django/icc_profiles /app/icc_profiles

RUN python manage.py collectstatic --noinput

# entrypoint.sh is already copied by the previous 'COPY backend/django /app'
RUN chmod +x /app/entrypoint.sh && sed -i 's/\r$//' /app/entrypoint.sh

RUN adduser --disabled-password --gecos '' --uid 1000 appuser && chown -R appuser:appuser /app /opt/venv
USER appuser

ENV DJANGO_SETTINGS_MODULE=product_editor.settings
ENV PORT=8000

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
