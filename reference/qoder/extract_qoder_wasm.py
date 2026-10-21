#!/usr/bin/env python3
"""
Extract the Qoder CLI's embedded crypto WASM module (qoder_auth_wasm) plus the
wasm-bindgen glue from the official Linux client binary.

Source binary : ~/.qodersec/bin/qodercli   (Bun-compiled JS bundle, not stripped)
WASM location : `var YjB="<base64>"`  (the whole .wasm, base64'd, inlined)
Glue location : the `qoder_auth_wasm_bg.js` module scope in the same bundle

Outputs (next to this script):
  qoder_auth_wasm.wasm   raw wasm bytes
  qoder_wasm_glue.cjs    CommonJS-loadable wbindgen glue (import object + helpers)

Usage:  python3 extract_qoder_wasm.py [path/to/qodercli]
"""
import base64
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BIN = os.path.expanduser("~/.qodersec/bin/qodercli")

WASM_MARK = b'var YjB="'
GLUE_START = b'function OjB(){'
GLUE_END = b'var pb0=b(()=>{'
PB0_START = b'var pb0=b(()=>{'


def brace_match(data: bytes, open_idx: int) -> int:
    """Return index of the '}' matching the '{' at open_idx."""
    depth = 0
    i = open_idx
    while True:
        c = data[i]
        if c == 0x7B:
            depth += 1
        elif c == 0x7D:
            depth -= 1
            if depth == 0:
                return i
        i += 1


def main() -> int:
    binpath = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BIN
    data = open(binpath, 'rb').read()
    print(f"[+] binary {binpath} ({len(data)} bytes)")

    # ---- 1. the WASM blob -------------------------------------------------
    i = data.find(WASM_MARK)
    if i < 0:
        print("[-] could not find `var YjB=\"` (wasm base64 blob)")
        return 1
    start = i + len(WASM_MARK)
    end = data.find(b'";', start)
    b64 = data[start:end]
    wasm = base64.b64decode(b64)
    assert wasm[:4] == b"\x00asm", "bad wasm magic"
    wasm_path = os.path.join(HERE, "qoder_auth_wasm.wasm")
    open(wasm_path, "wb").write(wasm)
    print(f"[+] wasm: {len(b64)} b64 chars -> {len(wasm)} bytes -> {wasm_path}")

    # ---- 2. the wbindgen glue --------------------------------------------
    gs = data.find(GLUE_START)
    ge = data.find(GLUE_END, gs)
    if gs < 0 or ge < 0:
        print("[-] could not locate the wbindgen glue chunk")
        return 1
    glue = data[gs:ge].decode('utf-8')

    ps = data.find(PB0_START, ge)
    po = data.find(b'{', ps + len(b'var pb0=b('))
    pe = brace_match(data, po)
    pb0_full = data[ps:pe + 1].decode('utf-8')          # `var pb0=b(()=>{ ...}`
    pb0_body = pb0_full[len('var pb0=b(()=>'):]           # `{ ... }`

    # ESM-only syntax so the file can be `require()`d as CommonJS
    glue = glue.replace('import.meta.url', '"qoder_auth_wasm_bg.wasm"')
    if re.search(r'(^|[;}\s])(import|export)\s', glue):
        print("[-] unexpected ESM syntax left in glue")
        return 1

    out = f"""// Qoder CLI WASM (qoder_auth_wasm) wbindgen glue.
// Extracted VERBATIM from the Bun bundle inside ~/.qodersec/bin/qodercli
// (module scope of the `qoder_auth_wasm_bg.js` chunk). Only `import.meta.url`
// was rewritten so the file can be loaded as CommonJS.
//
// Regenerate with: python3 extract_qoder_wasm.py
{glue}

class l1H {{ free(){{}} }}
class i1H {{ free(){{}} }}
class jLA {{ free(){{}} }}
var ljB = {{ require: require }};

function pb0init(){pb0_body}

module.exports = {{
  kjB, hjB, RjB, OjB,          // model_cache_decrypt / model_cache_encrypt / profile_encrypt / key fingerprint
  ub0, yb0, djB, mjB,          // import object + init helpers
  pb0init,                     // wasm-bindgen runtime init (X2 externref heap, TextDecoder/Encoder)
}};
"""
    glue_path = os.path.join(HERE, "qoder_wasm_glue.cjs")
    open(glue_path, "w", encoding="utf-8").write(out)
    print(f"[+] glue -> {glue_path} ({len(out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
