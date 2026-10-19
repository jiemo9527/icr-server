# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ICR_HOST=0.0.0.0 ICR_PORT=8899
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY requirements-icr.txt ./
RUN pip install --no-cache-dir -r requirements-icr.txt && useradd --uid 10001 --create-home icr
COPY ICR.py ICR_LICENSE.txt local_recognition.py icr_server.py ./
USER 10001
EXPOSE 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8899/health',timeout=3)"
CMD ["python", "icr_server.py"]
