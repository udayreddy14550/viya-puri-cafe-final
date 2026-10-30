import json, re, sys
from playwright.sync_api import sync_playwright
B="http://127.0.0.1:3111"; PASS=[]; FAIL=[]; NOISE=re.compile(r"fonts\.g|ERR_FAILED|ERR_NAME_NOT_RESOLVED|ERR_ABORTED")
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ")+name+((" -> "+str(detail)) if (detail and not cond) else ""), flush=True)
class Watch:
    def __init__(s,page,tag): s.errs=[]; s.bad=[]; s.tag=tag; page.on("console",lambda m: s.errs.append(m.text) if m.type=="error" and not NOISE.search(m.text) else None); page.on("pageerror",lambda e: s.errs.append("PAGEERROR "+str(e))); page.on("response",lambda r: s.bad.append(f"{r.status} {r.url}") if r.status>=400 and "/api/admin/session" not in r.url else None)
def block_fonts(ctx): ctx.route("**/fonts.g*/**", lambda r: r.abort())
def admin_api(ctx):
    r=ctx.request.post(B+"/api/admin/login",data={"email":"owner@example.com","password":"Correct-Horse-9!"}); j=r.json(); csrf=j["csrfToken"]
    def call(method,path,body=None):
        r=ctx.request.fetch(B+"/api/admin"+path,method=method,headers={"X-CSRF-Token":csrf,"Content-Type":"application/json"},data=json.dumps(body) if body is not None else None)
        try: return r.status, r.json()
        except Exception: return r.status, {}
    return call
