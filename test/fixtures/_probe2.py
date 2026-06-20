import json
def parse(j):
    w=[]
    for ev in j.get('events',[]):
        if not ev.get('segs'): continue
        b=ev.get('tStartMs',0); e=b+ev.get('dDurationMs',0)
        for s in ev['segs']:
            t=s.get('utf8')
            if not t: continue
            if t=='\n':
                if w: w[-1]['brk']=True
                continue
            w.append({'text':t,'start':b+s.get('tOffsetMs',0),'end':e,'brk':False})
    w.sort(key=lambda x:x['start'])
    for i in range(len(w)-1):
        if w[i]['end']>w[i+1]['start']: w[i]['end']=w[i+1]['start']  # content.js:294 截斷
    return w
def group(words):
    if not words: return []
    hasb=any(x['brk'] for x in words); L=[]; cur={'w':[],'start':words[0]['start']}
    def flush():
        nonlocal cur
        if not cur['w']: return
        L.append({'start':cur['start'],'text':''.join(x['text'] for x in cur['w']),'words':cur['w']}); cur={'w':[],'start':0}
    for x in words:
        p=cur['w'][-1] if cur['w'] else None
        db=bool(p and p['brk']); sp=x['text'].lstrip().startswith('>>'); gap=(not hasb) and p and (x['start']-p['end']>1200)
        if cur['w'] and (db or sp or gap): flush(); cur={'w':[],'start':x['start']}
        cur['w'].append(x)
        if not cur['start'] and cur['start']!=0: cur['start']=x['start']
        if x['start']<cur['start']: cur['start']=x['start']
    flush(); return L

o=json.load(open('5ipNqGvS5Hw.en.asr.json3.json'))
t=json.load(open('5ipNqGvS5Hw.en-zh-Hant.asr.json3.json'))
ol=group(parse(o)); tl=group(parse(t))
oa=[l for l in ol if l['start']==3120][0]
ta=[l for l in tl if l['start']==1760][0]
print('原文孤行(lucasfilm): start=3120  words=', [(x['text'],x['start'],x['end']) for x in oa['words']])
print('譯文合併行(兼執行創意總監): start=1760')
print('  word 時間範圍 =', min(x['start'] for x in ta['words']), '~', max(x['end'] for x in ta['words']))
print('  逐字 =', [(x['text'],x['start'],x['end']) for x in ta['words']])
print('  譯文下一行 start =', [l['start'] for l in tl if l['start']>1760][0])

def active(lines,tt,LEAD=120):
    idx=-1
    for i,l in enumerate(lines):
        if tt>=l['start']-LEAD: idx=i
        else: break
    return lines[idx] if idx>=0 else None
def wstate(w,tt):
    if tt<w['start']-30: return 'F'
    if tt<w['end']+30: return 'A'
    return 'P'
print('\n--- 模擬播放 ---')
for tt in [1900,3000,3600,4100,4300]:
    oa2=active(ol,tt); ta2=active(tl,tt)
    tw=''.join(wstate(x,tt) for x in ta2['words']) if ta2 else ''
    print(f't={tt}: 原文active="{oa2["text"][:16]}" | 譯文active="{ta2["text"][:12]}" 詞態={tw}')
