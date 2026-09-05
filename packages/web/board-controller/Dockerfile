FROM python:3.11-slim

# Licence of the first-party code in this image (see LICENSING.md at the repo root).
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    bluez \
    python3-dbus \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY controller.py .

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Expose port
EXPOSE 8000

# Set environment variables
ENV DB_PATH=/app/data/board_controller.db
ENV PYTHONUNBUFFERED=1
ENV DOCKER_CONTAINER=1

# Run the application with auto-SSL enabled
CMD ["python", "main.py", "--host", "0.0.0.0", "--port", "8000", "--auto-ssl"]