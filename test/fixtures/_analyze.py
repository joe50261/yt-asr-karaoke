"""基於 fixture 複刻 yk-parse 的 parseCaptionEvents + groupLines，
驗證 dual-track「同值碰撞排序」與 [data-variant] + .ykt-line 命中範圍。
（行為同步 yk-parse：內嵌 \n、事件邊界 fallback、LINE_MAX_SPAN 安全閥、end clamp、gap 700。）"""
import json

LINE_BREAK_GAP_MS = 700
LINE_MAX_SPAN_MS = 12000
LINE_SPLIT_TARGET_MS = 4000

def parse(j):
    w = []
    for ev in j.get('events', []):
        if not ev.get('segs'):
            continue
        b = ev.get('tStartMs', 0)
        e = b + ev.get('dDurationMs', 0)
        first_word_of_event = True
        for s in ev['segs']:
            t = s.get('utf8')
            if not t:
                continue
            start = b + s.get('tOffsetMs', 0)
            parts = t.split('\n')
            for pi, part in enumerate(parts):
                if pi > 0 and w:
                    w[-1]['brk'] = True
                if not part:
                    continue
                if first_word_of_event:
                    if not ev.get('aAppend') and w:
                        w[-1]['evb'] = True
                    first_word_of_event = False
                w.append({'text': part, 'start': start, 'end': e, 'brk': False, 'evb': False})
    w.sort(key=lambda x: x['start'])
    for i in range(len(w) - 1):
        if w[i]['end'] > w[i + 1]['start']:
            w[i]['end'] = w[i + 1]['start']
    return w

def _line(ws):
    return {'start': min(x['start'] for x in ws), 'text': ''.join(x['text'] for x in ws),
            'w': ws}

def _split_oversized(line):
    ws = line['w']
    if len(ws) < 2 or ws[-1]['start'] - ws[0]['start'] <= LINE_MAX_SPAN_MS:
        return [line]
    out, chunk = [], []
    for x in ws:
        if chunk and x['start'] - chunk[0]['start'] > LINE_SPLIT_TARGET_MS:
            out.append(_line(chunk))
            chunk = []
            if x['text'].startswith(' '):
                x['text'] = x['text'][1:]
        chunk.append(x)
    if chunk:
        out.append(_line(chunk))
    return out

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
        L.append({'start': cur['start'], 'text': ''.join(x['text'] for x in cur['w']),
                  'w': cur['w']})
        cur = {'w': [], 'start': 0}
    for x in words:
        p = cur['w'][-1] if cur['w'] else None
        db = bool(p and p['brk'])
        sp = x['text'].lstrip().startswith('>>')
        evb = (not hasb) and bool(p and p['evb'])
        gap = (not hasb) and p and (x['start'] - p['end'] > LINE_BREAK_GAP_MS)
        if cur['w'] and (db or sp or evb or gap):
            flush()
            cur = {'w': [], 'start': x['start']}
        cur['w'].append(x)
        if not cur['start'] and cur['start'] != 0:
            cur['start'] = x['start']
        if x['start'] < cur['start']:
            cur['start'] = x['start']
    flush()
    return [l for line in L for l in _split_oversized(line)]

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
