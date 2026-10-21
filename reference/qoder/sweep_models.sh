#!/usr/bin/env bash
# Capture the real `max_tokens` the official Qoder CLI puts on the wire, per model.
#
# The CLI's TLS is terminated by mitm_proxy.js (mode=reject) which logs every
# request body; decode_legacy_body.js reverses Qoder's base64 scrambling.
# One proxy instance serves the whole sweep; the captured body itself carries
# model_config.key, so captures are attributed by that.
set -uo pipefail
HERE=/tmp/opencode/qoder
MITM=/tmp/opencode/mitm
OUT="$MITM/sweep.jsonl"
MODELS="${*:-auto ultimate efficient fast cmodel smodel gfmodel gmodel kmodel kmodel_latest dfmodel dmodel mmodel qfmodel qmodel qmodel_latest qmodel_38max}"

: > "$OUT"
node "$MITM/mitm_proxy.js" 8888 "$OUT" reject > "$MITM/proxy-sweep.log" 2>&1 &
PROXY_PID=$!
sleep 1

for m in $MODELS; do
  timeout 22 env https_proxy=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888 \
    NODE_EXTRA_CA_CERTS="$MITM/ca.pem" \
    ~/.qodersec/bin/qodercli --config-dir /tmp/opencode/qoder-home -p "hi" --model "$m" \
    --dangerously-skip-permissions --permission-mode bypass_permissions > /dev/null 2>&1
  echo "  ran $m" >&2
done

kill "$PROXY_PID" 2>/dev/null

node -e "
const fs=require('fs');const {qoderBase64Decode}=require('$HERE/decode_legacy_body.js');
const best=new Map();
for(const l of fs.readFileSync('$OUT','utf8').split('\n')){
  if(!l.trim()) continue; const o=JSON.parse(l);
  if(o.t!=='request'||o.method!=='POST'||!o.path.includes('agent_chat_generation')) continue;
  try{ const j=JSON.parse(qoderBase64Decode(o.body).toString('utf8'));
    const k=j.model_config?.key; if(!k) continue;
    const prev=best.get(k); if(!prev||o.body.length>prev.len) best.set(k,{len:o.body.length,j});
  }catch(e){}
}
console.log('\n=== wire max_tokens per model (captured from the official CLI) ===');
for(const [k,v] of [...best].sort((a,b)=>a[0].localeCompare(b[0])))
  console.log(k.padEnd(18),'max_tokens =',String(v.j.parameters?.max_tokens).padEnd(8),' model_config.max_input_tokens =',v.j.model_config?.max_input_tokens);
console.log('captured models:', best.size);
"
