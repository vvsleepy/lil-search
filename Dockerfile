# Dockerfile — packages the Node app into a self-contained image.
#
# The image includes the built SQLite database: at build time we download the
# dataset and run the loader, so the container needs nothing mounted to work.
# (Redis runs as separate containers — see docker-compose.yml.)

FROM node:20-slim

WORKDIR /app

# Install what we need:
#   - curl + ca-certificates: to download the dataset during the build
#   - python3 + build-essential: so npm can compile better-sqlite3 from source
#     (this base image has no prebuilt binary for it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install Node dependencies first (better layer caching).
# package-lock.json is copied too so installs are reproducible.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the application source.
COPY . .

# Download the dataset and build data/queries.db INSIDE the image, so the
# resulting image is fully self-contained and portable.
RUN curl -L -o data/count_1w.txt https://norvig.com/ngrams/count_1w.txt \
  && node data/load_data.js \
  && rm -f data/count_1w.txt

EXPOSE 3000

CMD ["node", "server/index.js"]
