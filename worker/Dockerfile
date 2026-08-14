FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker ./worker

# Milestone 2's image will additionally install COLMAP and OpenSplat (and GPU support).
CMD ["celery", "-A", "worker.tasks", "worker", "--loglevel=INFO"]
