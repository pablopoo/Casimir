#!/bin/sh
set -eu

work_dir=${1:-/work}
umask 077
mkdir -p "$work_dir"

openssl genpkey \
  -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out "$work_dir/ca-key.pem"
openssl req \
  -x509 \
  -new \
  -key "$work_dir/ca-key.pem" \
  -days 2 \
  -subj '/CN=Casimir Identity Fixture CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "$work_dir/ca.pem"

openssl genpkey \
  -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out "$work_dir/idp-key.pem"
openssl req \
  -new \
  -key "$work_dir/idp-key.pem" \
  -subj '/CN=idp.example.com' \
  -out "$work_dir/idp.csr"
cat >"$work_dir/idp-ext.cnf" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:idp.example.com
EOF
openssl x509 \
  -req \
  -in "$work_dir/idp.csr" \
  -CA "$work_dir/ca.pem" \
  -CAkey "$work_dir/ca-key.pem" \
  -CAcreateserial \
  -days 2 \
  -extfile "$work_dir/idp-ext.cnf" \
  -out "$work_dir/idp-cert.pem"
chmod 600 "$work_dir/ca-key.pem" "$work_dir/idp-key.pem"
chmod 644 "$work_dir/ca.pem" "$work_dir/idp-cert.pem"
