# ── Stage 1: builder — installs compile toolchain to build wheels ────────────
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY backend/django/requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install --no-cache-dir -r /tmp/requirements.txt


# ── Stage 2: runtime — slim image, no compilers ──────────────────────────────
FROM python:3.12-slim AS runner

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"
ENV DJANGO_SETTINGS_MODULE=product_editor.settings
ENV PORT=8000

# libpq5 covers any psycopg2 (non-binary) fallback; psycopg2-binary bundles its own.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY backend/django /app

RUN python manage.py collectstatic --noinput \
    && chmod +x /app/entrypoint.sh \
    && sed -i 's/\r$//' /app/entrypoint.sh \
    && adduser --disabled-password --gecos '' --uid 1000 appuser \
    && chown -R appuser:appuser /app /opt/venv

USER appuser

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
