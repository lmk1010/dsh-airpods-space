#!/bin/sh
# One-time local code-signing identity for development builds. macOS keeps microphone and Bluetooth grants for a
# signature's designated requirement; ad-hoc signatures use the content hash, so every rebuild lost the grant. A stable
# self-signed identity keeps grants across rebuilds. Lives in its own keychain so codesign never prompts.
set -eu
NAME="DSH AirPods Dev"
KEYCHAIN="$HOME/Library/Keychains/dsh-airpods-dev.keychain-db"
PASSWORD="dsh-airpods-dev"
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"; then
  security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
  echo "identity ready: $NAME"; exit 0
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/id.p12" -passout pass:p 2>/dev/null \
  || openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/id.p12" -passout pass:p
[ -f "$KEYCHAIN" ] || security create-keychain -p "$PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
security import "$WORK/id.p12" -k "$KEYCHAIN" -P p -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASSWORD" "$KEYCHAIN" >/dev/null
# Make the keychain visible to codesign without replacing the user's search list.
security list-keychains -d user -s $(security list-keychains -d user | tr -d '"') "$KEYCHAIN"
echo "identity created: $NAME"
