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
RUN python manage.py collectstatic --noinput

RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod 0755 /app/entrypoint.sh

RUN adduser --disabled-password --gecos '' appuser && chown -R appuser:appuser /app /opt/venv
USER appuser

ENV DJANGO_SETTINGS_MODULE=product_editor.settings
ENV PORT=8000

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
CMD ["gunicorn", "product_editor.wsgi:application", "--config", "/app/gunicorn.conf.py"]
