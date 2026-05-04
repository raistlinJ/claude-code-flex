#!/bin/bash

# Create server directory if it doesn't exist
mkdir -p "$(dirname "$0")"

echo "Generating self-signed SSL certificates..."
openssl req -x509 -newkey rsa:4096 -keyout "$(dirname "$0")/key.pem" -out "$(dirname "$0")/cert.pem" -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

echo "Certificates generated successfully:"
ls -l "$(dirname "$0")/key.pem" "$(dirname "$0")/cert.pem"
