"""Consumption statistics from the local Claude Code transcripts: turns, context, output, cache share, cost at API rate.
Reads only the numeric `usage` fields; does not print content. The prices are in the dictionary P (see references/pricing.md).
Each request is priced at its own model; a Haiku 5.5 request whose prompt (uncached + cache read + cache writes) is over
100,000 tokens pays the higher rates. Advisor iterations (`usage.iterations` of type advisor_message) are priced at the
advisor's model and count in the cost only; the token statistics and the session's model come from the executor requests.
A session with more than one executor model is `mixed` and stays out of the per-model cohorts; a session with an unpriced
request that has tokens gets no $. Zero-usage records (`<synthetic>`), lines that are not JSON objects and records without
a message id are skipped and counted. Messages are deduplicated by id within each file only; the number of ids found in
more than one file is printed."""
import json,glob,os,statistics as st,collections
import sys
# Usage: python3 -I usage_stats.py <project directory from ~/.claude/projects>
if len(sys.argv)!=2 or not os.path.isdir(sys.argv[1]):
    sys.exit("usage: python3 -I usage_stats.py <project directory from ~/.claude/projects>")
base=sys.argv[1]
# $/1M: in, out, read, write5m, write1h  (pricing page, checked 2026-11-09)
P={"claude-sonnet-5-5":(2,10,0.1,2.5,4),"claude-sonnet-5":(2,10,0.2,2.5,4),"claude-fable-5-1":(10,50,0.25,12.5,20),
   "claude-opus-5-5":(4,20,0.2,5,8),"claude-haiku-5-5":(0.1,0.5,0.01,0.125,0.2)}
LONG={"claude-haiku-5-5":(100_000,5)}   # prompt over this many tokens: every rate times 5
skipped=collections.Counter(); files_of=collections.defaultdict(set)
def parts(u):
    w=u.get("cache_creation_input_tokens") or 0; w1=(u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
    return (u.get("input_tokens") or 0,u.get("output_tokens") or 0,u.get("cache_read_input_tokens") or 0,w-w1,w1)
def price(mdl,t):
    p=P.get(mdl)
    if not p: return None
    lim,x=LONG.get(mdl,(None,1))
    if lim is not None and t[0]+t[2]+t[3]+t[4]>lim: p=[v*x for v in p]
    return (t[0]*p[0]+t[1]*p[1]+t[2]*p[2]+t[3]*p[3]+t[4]*p[4])/1e6
def scan(path):
    calls={}
    try:
        for l in open(path,errors="replace"):
            try:d=json.loads(l)
            except ValueError: d=None
            if not isinstance(d,dict): skipped["lines not a JSON object"]+=1; continue
            if d.get("type")!="assistant": continue
            m=d.get("message"); u=m.get("usage") if isinstance(m,dict) else None
            if not u: continue
            if not m.get("id"): skipped["records without a message id"]+=1; continue
            calls[m["id"]]=(m.get("model"),u)   # last chunk of a message has final output_tokens
    except OSError: skipped["unreadable files"]+=1; return None
    for mid in calls: files_of[mid].add(path)
    turns=ins=outs=rd=w5=w1=0; ctx=[]; models=set(); usd=0.0
    for mdl,u in calls.values():
        reqs=[(x.get("model") or mdl,x.get("type")=="message",parts(x)) for x in u["iterations"]] if u.get("iterations") else [(mdl,True,parts(u))]
        if not any(any(t) for _,_,t in reqs): skipped["zero-usage records"]+=1; continue
        turns+=1
        for rm,executor,t in reqs:
            c=price(rm,t) if any(t) else 0
            usd=None if c is None or usd is None else usd+c
            if not executor: continue
            models.add(rm); ins+=t[0];outs+=t[1];rd+=t[2];w5+=t[3];w1+=t[4]
            ctx.append(t[0]+t[2]+t[3]+t[4])
    if not ctx: return None
    return dict(model=models.pop() if len(models)==1 else "mixed",turns=turns,out=outs,uncached_in=ins,read=rd,w5=w5,w1=w1,
                avg_ctx=sum(ctx)/len(ctx),all_in=ins+rd+w5+w1,usd=usd,
                cache_share=(rd/(ins+rd+w5+w1)) if (ins+rd+w5+w1) else 0)
rows=[]
for f in glob.glob(base+"/*.jsonl"):
    r=scan(f)
    if r: r["kind"]="main"; r["type"]="main"; rows.append(r)
for f in glob.glob(base+"/*/subagents/agent-*.jsonl"):
    r=scan(f)
    if not r: continue
    r["kind"]="sub"; r["type"]="?"
    try:
        mj=json.load(open(f.replace(".jsonl",".meta.json"))); r["type"]=mj.get("agentType","?")
    except Exception: pass
    rows.append(r)
def pct(xs,q):
    xs=sorted(xs);
    return xs[min(len(xs)-1,int(q*(len(xs)-1)+0.5))] if xs else None
def summarize(name,rs):
    if not rs: return
    cs=[r["usd"] for r in rs if r["usd"] is not None]
    print(f"\n## {name}  n={len(rs)}  (with known price: {len(cs)})")
    for k,lab in (("turns","turns"),("avg_ctx","avg context/turn"),("out","total output"),("cache_share","cache-read share of input")):
        xs=[r[k] for r in rs]
        print(f"  {lab}: p10={pct(xs,.1):,.2f} p50={pct(xs,.5):,.2f} p90={pct(xs,.9):,.2f}")
    if cs: print(f"  cost $ (API rate): p10={pct(cs,.1):.2f} p50={pct(cs,.5):.2f} p90={pct(cs,.9):.2f}  max={max(cs):.2f}")
print("models:",collections.Counter(r["model"] for r in rows).most_common(8))
print("subagent types:",collections.Counter(r["type"] for r in rows if r["kind"]=="sub").most_common(12))
summarize("all subagents",[r for r in rows if r["kind"]=="sub"])
for t,_ in collections.Counter(r["type"] for r in rows if r["kind"]=="sub").most_common(6):
    summarize(f"subagent type={t}",[r for r in rows if r["kind"]=="sub" and r["type"]==t])
summarize("main sessions",[r for r in rows if r["kind"]=="main"])
# sub-agents on a single model for fairer comparison
for mdl in ("claude-sonnet-5-5","claude-opus-5-5"):
    summarize(f"subagents with model {mdl}",[r for r in rows if r["kind"]=="sub" and r["model"]==mdl])
print("\nskipped:",", ".join(f"{k}={skipped[k]}" for k in ("lines not a JSON object","records without a message id","zero-usage records","unreadable files")))
print("message ids in more than one file:",sum(len(v)>1 for v in files_of.values()))
