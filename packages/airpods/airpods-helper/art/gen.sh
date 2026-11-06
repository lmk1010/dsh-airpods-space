#!/usr/bin/env bash
# Generate transparent-background product renders: art/gen.sh <name> → assets/<name>.png
# Reads the image API endpoint and key from $DSH_ART_ENV ; the key never enters this repo.
set -uo pipefail
cd "$(dirname "$0")"
env_file="${DSH_ART_ENV:?set DSH_ART_ENV to an env file with the image API endpoint and key}"
set -a; . "$env_file"; set +a
key="${FRIDAY_IMG_KEY:-$FRIDAY_IMAGE_API_KEY}"
api="${FRIDAY_IMAGE_API_URL:-https://988665.xyz}/v1/images/generations"
name=$1
python3 -c "import json,sys,pathlib;print(json.dumps({'model':'gpt-image-2.5','prompt':pathlib.Path(sys.argv[1]).read_text().strip(),'size':'1024x1024','n':1,'background':'transparent','output_format':'png'}))" "prompts/$name.txt" > "/tmp/dsh-art-req-$name.json"
curl -sS -m 400 -H "Authorization: Bearer $key" -H "Content-Type: application/json" --data-binary @"/tmp/dsh-art-req-$name.json" "$api" -o "/tmp/dsh-art-resp-$name.json" -w "$name HTTP %{http_code}\n"
python3 - "$name" <<'PY'
import json, sys, base64, pathlib, urllib.request
n = sys.argv[1]
d = json.loads(pathlib.Path(f'/tmp/dsh-art-resp-{n}.json').read_text())
if 'error' in d: print(n, 'error', str(d['error'])[:300]); sys.exit(1)
b = d['data'][0]; out = pathlib.Path(f'../assets/{n}.png')
out.write_bytes(base64.b64decode(b['b64_json']) if b.get('b64_json') else urllib.request.urlopen(b['url']).read())
print(n, 'saved', out.stat().st_size)
PY
