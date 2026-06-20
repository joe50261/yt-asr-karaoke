"""基於 fixture 複刻 content.js 的 parseCaptionEvents + groupLines，
驗證 dual-track「同值碰撞排序」與 [data-variant] + .ykt-line 命中範圍。"""
import json

def parse(j):
    w = []
    for ev in j.get('events', []):
        if not ev.get('segs'):
            continue
        b = ev.get('tStartMs', 0)
        e = b + ev.get('dDurationMs', 0)
        for s in ev['segs']:
            t = s.get('utf8')
            if not t:
                continue
            if t == '\n':
                if w:
                    w[-1]['brk'] = True
                continue
            w.append({'text': t, 'start': b + s.get('tOffsetMs', 0), 'end': e, 'brk': False})
    w.sort(key=lambda x: x['start'])
    return w

def group(words):
    if not words:
        return []
    hasb = any(x['brk'] for x in words)
    L = []
    cur = {'w': [], 'start': words[0]['start']}
    def flush():
        nonlocal cur
        if not cur['w']:
            return
        L.append({'start': cur['start'], 'text': ''.join(x['text'] for x in cur['w'])})
        cur = {'w': [], 'start': 0}
    for x in words:
        p = cur['w'][-1] if cur['w'] else None
        db = bool(p and p['brk'])
        sp = x['text'].lstrip().startswith('>>')
        gap = (not hasb) and p and (x['start'] - p['end'] > 1200)
        if cur['w'] and (db or sp or gap):
            flush()
            cur = {'w': [], 'start': x['start']}
        cur['w'].append(x)
        if not cur['start'] and cur['start'] != 0:
            cur['start'] = x['start']
        if x['start'] < cur['start']:
            cur['start'] = x['start']
    flush()
    return L

o = json.load(open('5ipNqGvS5Hw.en.asr.json3.json'))
t = json.load(open('5ipNqGvS5Hw.en-zh-Hant.asr.json3.json'))
ol = group(parse(o))
tl = group(parse(t))
N, M = len(ol), len(tl)
tset = set(l['start'] for l in tl)
oMatch = sum(1 for l in ol if l['start'] in tset)

# 模擬 buildTranscript：原文行先 push、譯文行後 push，再 stable sort by start（同值碰撞）
rows = [(l['start'], None) for l in ol] + [(l['start'], 'zh') for l in tl]
rows.sort(key=lambda r: r[0])  # Python sort 穩定 → 同 start 時原文(先入)在前
hits = intra = 0
for i in range(1, len(rows)):
    if rows[i - 1][1] is not None:
        hits += 1
        if rows[i][1] is not None:
            intra += 1
seq = ''.join('T' if v else 'o' for _, v in rows[:16])

print('=== 基於 fixture 的 groupLines 對齊實證 ===')
print('原文行 N =', N)
print('譯文行 M =', M, '  (N-M =', N - M, '行被譯文合併掉)')
print('原文行 start 在譯文有同值 =', oMatch, '/', N, ' → 孤行', N - oMatch)
print('DOM 總列數 =', len(rows))
print('[data-variant] + .ykt-line 命中 =', hits, '次')
print('  其中下一列也是譯文的誤命中 =', intra, '次')
print('前 16 列 DOM 序列 (o=原文 T=譯文) =', seq)

stats = {'origLines_N': N, 'tlLines_M': M, 'mergedAway': N - M,
         'origLinesWithTlMatch': oMatch, 'orphanOrigLines': N - oMatch,
         'domRows': len(rows), 'adjVariantHits': hits, 'adjVariantIntraHits': intra}
meta = {
    'videoId': '5ipNqGvS5Hw',
    'title': "《星際大戰》風暴兵大全！40種風暴兵武器裝備、設計理念超詳細解說 Every Stormtrooper in Star Wars Explained｜科普長知識｜GQ Taiwan",
    'capturedDate': '2026-06-20',
    'source': 'YouTube timedtext json3，由頁面內 hook player 的 fetch/XHR response 取得（非直接抓 baseUrl，baseUrl 缺 pot token 會回空 body）',
    'sourceLang': 'en',
    'track': 'asr (auto-generated)',
    'clip': '影片前 ~90 秒（只保留 tStartMs <= 90000 的 events）',
    'minified': '移除 acAsrConf 與 window 樣式欄位（pens/wsWinStyles/...）；保留 content.js 會 parse 的 tStartMs/dDurationMs/segs.utf8/tOffsetMs',
    'files': {'original': '5ipNqGvS5Hw.en.asr.json3.json',
              'translation_zh_Hant': '5ipNqGvS5Hw.en-zh-Hant.asr.json3.json'},
    'stats': stats,
}
json.dump(meta, open('meta.json', 'w'), ensure_ascii=False, indent=2)
print('\nmeta.json 已寫入')
