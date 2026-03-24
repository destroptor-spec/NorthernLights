#!/bin/bash

# Start a pgvector PostgreSQL container using Podman
# This replaces the PGlite embedded database for better reliability during dev restarts.

CONTAINER_NAME="music-postgres"
DB_USER="musicuser"
DB_PASS="musicpass"
DB_NAME="musicdb"
PORT="5432"
DATA_DIR="./postgres-data"

# Create local data directory for persistence if it doesn't exist
mkdir -p "$DATA_DIR"

# Check if container exists
if podman ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Container ${CONTAINER_NAME} already exists."
  
  # Check if it is running
  if podman ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Container is already running on port ${PORT}."
  else
    echo "Starting existing container..."
    podman start "${CONTAINER_NAME}"
  fi
else
  echo "Creating and starting new container ${CONTAINER_NAME}..."
  podman run -d \
    --name "${CONTAINER_NAME}" \
    -e POSTGRES_USER="${DB_USER}" \
    -e POSTGRES_PASSWORD="${DB_PASS}" \
    -e POSTGRES_DB="${DB_NAME}" \
    -p "${PORT}:5432" \
    -v "$(pwd)/${DATA_DIR}:/var/lib/postgresql/data:Z" \
    docker.io/pgvector/pgvector:pg16

  echo "Waiting for database to initialize..."
  sleep 5
fi

echo "PostgreSQL is ready at postgres://${DB_USER}:${DB_PASS}@localhost:${PORT}/${DB_NAME}"
