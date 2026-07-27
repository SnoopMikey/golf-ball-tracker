#!/usr/bin/env python3
"""Prepare a month's newsletter: export the photos, crunch the numbers, and build
a contact sheet to write from.

    python3 scripts/newsletter_prep.py 2026-08

Creates newsletter/<month>/img/ with the photos sized and cropped the way the
template expects, prints a data brief, and writes a contact sheet to
newsletter/<month>/_contact-sheet.jpg for reviewing the photos before writing.

This deliberately does NOT write any copy. The words are written fresh each
month by reading the brief and actually looking at the contact sheet — that is
where the good material comes from. See newsletter/README.md.
"""
import collections, datetime, io, json, math, os, sys, urllib.parse, urllib.request

TOKEN = 'patvUZhofHmUxBdGQ.de96f3bd149257e66c7995c7ee58c31f4eb390a3b51f5c8fcfb4792a44514f64'
BASE  = 'app3SuYCUnfvGghu5'
API   = f'https://api.airtable.com/v0/{BASE}/Balls'
ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GRID_PX = 560     # square crops for "The Rest of the Field"
HERO_PX = 760     # portrait for "Ball of the Month"


def fetch_all():
    out, offset = [], None
    while True:
        url = API + '?pageSize=100' + (f'&offset={offset}' if offset else '')
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}'})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        out += d['records']
        offset = d.get('offset')
        if not offset:
            return out


def day(rec):
    return (rec['fields'].get('Date') or '')[:10]


def poster_photo(fields):
    """The in-hand shot. This site uploads Wide, Close-Up, In Hand (hand last);
    older iOS-logged entries — the ones with a full ISO timestamp in Date —
    shot the hand first. Mirrors posterPhoto() in app.js."""
    imgs = fields.get('Image') or []
    if not imgs:
        return None
    logged_here = 'T' not in (fields.get('Date') or '')
    return imgs[2] if (logged_here and len(imgs) >= 3) else imgs[0]


def miles(a, b):
    R = 3958.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: newsletter_prep.py YYYY-MM')
    month = sys.argv[1]
    y, m = int(month[:4]), int(month[5:7])

    recs = fetch_all()
    issue = sorted([r for r in recs if day(r).startswith(month)],
                   key=lambda r: (day(r), r['fields'].get('Time', '')))
    if not issue:
        sys.exit(f'no finds in {month}')

    prev = f'{y - 1}-12' if m == 1 else f'{y}-{m - 1:02d}'
    prev_n = sum(1 for r in recs if day(r).startswith(prev))
    by_month = collections.Counter(day(r)[:7] for r in recs if day(r))

    F = [r['fields'] for r in issue]
    temps = [f['Temp'] for f in F if f.get('Temp') is not None]
    hums  = [f['Humidity'] for f in F if f.get('Humidity') is not None]

    outdir = os.path.join(ROOT, 'newsletter', month, 'img')
    os.makedirs(outdir, exist_ok=True)

    # ── numbers ──────────────────────────────────────────────────────────
    print(f'\n{"="*62}\n  {month}  —  DATA BRIEF\n{"="*62}')
    print(f'finds this month : {len(issue)}')
    print(f'previous month   : {prev_n} ({prev})' +
          (f'  [{(len(issue)-prev_n)/prev_n*100:+.0f}%]' if prev_n else ''))
    rank = sorted(by_month.values(), reverse=True)
    print(f'all-time rank    : #{rank.index(len(issue))+1} of {len(by_month)} months'
          f'   (best ever = {rank[0]})')
    print(f'career total     : {len(recs)}')
    print(f'outings (dates)  : {len(set(day(r) for r in issue))}')
    print(f'brands           : {dict(collections.Counter(f.get("Brand","Unknown") for f in F))}')
    print(f'conditions       : {dict(collections.Counter(f.get("Condition","?") for f in F))}')
    print(f'skies            : {dict(collections.Counter(f.get("Sky") for f in F))}')
    if temps:
        print(f'temp             : avg {sum(temps)/len(temps):.0f}F, range {min(temps)}-{max(temps)}')
    if hums:
        print(f'humidity         : avg {sum(hums)/len(hums):.0f}%')
    overcast = sum(1 for f in F if f.get('Sky') == 'Overcast')
    career_over = sum(1 for r in recs if r['fields'].get('Sky') == 'Overcast')
    print(f'overcast         : {overcast}/{len(F)} this month vs {career_over}/{len(recs)} career'
          f' ({career_over/len(recs)*100:.0f}%)')

    # doubleheaders, in miles
    print('\ndoubleheaders:')
    found = False
    for date, group in collections.OrderedDict(
            (d, [r for r in issue if day(r) == d]) for d in dict.fromkeys(day(r) for r in issue)).items():
        if len(group) > 1:
            found = True
            g = [r['fields'] for r in group]
            for i in range(len(g) - 1):
                dist = miles((g[i]['Lat'], g[i]['Long']), (g[i+1]['Lat'], g[i+1]['Long']))
                print(f'  {date}: {len(group)} finds — {dist:.2f} mi apart, '
                      f'{g[i].get("Time")} -> {g[i+1].get("Time")}')
    if not found:
        print('  none')

    # extremes worth a mention
    print('\nextremes:')
    for label, key, best in [('hottest', 'Temp', max), ('coldest', 'Temp', min),
                             ('muggiest', 'Humidity', max), ('windiest', 'Wind', max)]:
        cands = [f for f in F if f.get(key) is not None]
        if cands:
            f = best(cands, key=lambda x: x[key])
            print(f'  {label:9}: {f[key]} — {f.get("Brand","?")} on {f.get("Date","?")[:10]}')

    print('\nthe finds, in order:')
    for i, r in enumerate(issue, 1):
        f = r['fields']
        print(f'  {i}. {day(r)} {f.get("Time","?"):>9} | {f.get("Brand","Unknown"):9} | '
              f'{f.get("Condition","?"):9} | {f.get("Temp")}F {f.get("Humidity")}% '
              f'{f.get("Wind")}mph {f.get("Sky")} | {len(f.get("Image") or [])} photos')

    # ── photos ───────────────────────────────────────────────────────────
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print('\n[!] Pillow not installed — skipping photo export')
        return

    def load(img, box):
        u = ((img.get('thumbnails', {}).get('full') or
              img.get('thumbnails', {}).get('large') or {}).get('url') or img['url'])
        im = Image.open(io.BytesIO(urllib.request.urlopen(u, timeout=60).read())).convert('RGB')
        im.thumbnail((box, box * 3))
        return im

    def square(im, size=GRID_PX):
        w, h = im.size
        s = min(w, h)
        # bias upward: the ball is usually held high in the frame
        return im.crop(((w - s) // 2, max(0, int((h - s) * 0.38)),
                        (w - s) // 2 + s, max(0, int((h - s) * 0.38)) + s)) \
                 .resize((size, size), Image.LANCZOS)

    print(f'\nexporting photos -> newsletter/{month}/img/')
    hands = []
    for i, r in enumerate(issue, 1):
        img = poster_photo(r['fields'])
        if not img:
            print(f'  {i}. {day(r)} — no photo'); continue
        im = load(img, 1200)
        hands.append((day(r), r['fields'], im))
        square(im).save(f'{outdir}/hand-{day(r)}-{i}.jpg', quality=86, optimize=True)
        print(f'  {i}. hand-{day(r)}-{i}.jpg')

    # hero: the best-conditioned ball, ties broken by recency
    order = {'Mint': 0, 'Great': 1, 'Good': 2, 'Fair': 3, 'Worn': 4, 'Destroyed': 5}
    hero_i = min(range(len(hands)),
                 key=lambda i: (order.get((hands[i][1].get('Condition') or '').strip(), 9),
                                -i))
    hd, hf, him = hands[hero_i]
    him.copy().resize((HERO_PX * him.width // him.height, HERO_PX)
                      if him.height > him.width else (HERO_PX, HERO_PX * him.height // him.width),
                      Image.LANCZOS).save(f'{outdir}/hand-{hd}-{hero_i+1}.jpg',
                                          quality=86, optimize=True)
    print(f'  hero (best condition): #{hero_i+1} {hf.get("Brand")} {hf.get("Condition")} on {hd}')

    # masthead art, copied from the repo-root sources
    for src, dst in [('mikeballslogo.png', 'logo.png'), ('mikesballs-hero.png', 'hero.png')]:
        p = os.path.join(ROOT, src)
        if os.path.exists(p):
            Image.open(p).convert('RGBA').save(f'{outdir}/{dst}', optimize=True)
    print('  logo.png, hero.png')

    # ── contact sheet: every photo of every find, for the write-up ────────
    CELL, maxc = 300, max(len(r['fields'].get('Image') or []) for r in issue)
    sheet = Image.new('RGB', (CELL * maxc + 150, CELL * len(issue)), (255, 255, 255))
    dr = ImageDraw.Draw(sheet)
    for i, r in enumerate(issue):
        f = r['fields']
        dr.text((6, i * CELL + CELL // 2 - 20), day(r)[5:], fill=(0, 0, 0))
        dr.text((6, i * CELL + CELL // 2), f.get('Brand', '?'), fill=(0, 0, 0))
        dr.text((6, i * CELL + CELL // 2 + 20), f.get('Condition', '?'), fill=(0, 0, 0))
        for j, img in enumerate(f.get('Image') or []):
            im = load(img, CELL)
            c = Image.new('RGB', (CELL, CELL), (240, 236, 216))
            c.paste(im, ((CELL - im.width) // 2, (CELL - im.height) // 2))
            sheet.paste(c, (150 + j * CELL, i * CELL))
            dr.rectangle([150 + j * CELL, i * CELL, 150 + j * CELL + 34, i * CELL + 18], fill=(0, 0, 0))
            dr.text((150 + j * CELL + 4, i * CELL + 4), f'#{j+1}', fill=(255, 255, 0))
    cs = os.path.join(ROOT, 'newsletter', month, '_contact-sheet.jpg')
    sheet.save(cs, quality=84, optimize=True)

    print(f'\ncontact sheet -> newsletter/{month}/_contact-sheet.jpg')
    print('LOOK AT IT before writing — shadows, scuffs, odd colors and stray\n'
          'objects in frame are where the best lines come from.\n')


if __name__ == '__main__':
    main()
