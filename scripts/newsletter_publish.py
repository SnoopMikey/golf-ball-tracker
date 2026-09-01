#!/usr/bin/env python3
"""Turn a readable issue into the blob Airtable's email action can actually send,
and push it to the Newsletters table.

    python3 scripts/newsletter_publish.py 2026-07

Airtable sanitises whatever you drop into an automation's email body. Observed
behaviour, from a real send that arrived mangled:

  * every NEWLINE becomes <p><span>...</span></p>, which slices tables apart —
    an opening <tr> on one line is auto-closed at end of line and its cells end
    up as siblings instead of children. Fix: emit everything on one line.
  * <html>, <head>, <meta>, <title>, <body> and HTML COMMENTS are not on the
    allowlist, so they are escaped and shown to the reader as literal text.
    Fix: send a fragment, strip comments.
  * width / align / valign / cellpadding / cellspacing / border are stripped
    from <table> and <td> — only style= survives. Fix: express all layout as
    inline CSS. (<img> keeps width and alt, so those are fine.)

The pretty source stays in newsletter/<month>/index.html and remains the web
version; this only rewrites what gets emailed.
"""
import json, os, re, sys, urllib.request

TOKEN = 'patvUZhofHmUxBdGQ.de96f3bd149257e66c7995c7ee58c31f4eb390a3b51f5c8fcfb4792a44514f64'
URL   = 'https://api.airtable.com/v0/app3SuYCUnfvGghu5/Newsletters'
ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HDR   = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}


def add_style(tag_html, extra):
    """Merge extra CSS into a tag's style attribute, creating it if absent."""
    if not extra:
        return tag_html
    m = re.search(r'style="([^"]*)"', tag_html)
    if m:
        cur = m.group(1).rstrip().rstrip(';')
        merged = f'{cur};{extra}' if cur else extra
        return tag_html[:m.start(1)] + merged + tag_html[m.end(1):]
    return re.sub(r'^<(\w+)', rf'<\1 style="{extra}"', tag_html, count=1)


def inline_layout(html):
    """Rewrite layout attributes as inline CSS, since Airtable drops them."""
    def fix(m):
        tag = m.group(0)
        name = m.group(1).lower()

        # A display:block image with a fixed width does not centre under plain
        # text-align:center. Browsers only centre it in the source because
        # align="center" on a cell maps to text-align:-webkit-center, which
        # centres block children too — and Airtable strips that attribute.
        if name == 'img':
            s = re.search(r'style="([^"]*)"', tag)
            if s and 'display:block' in s.group(1) and re.search(r'width:\d+px', s.group(1)):
                return add_style(tag, 'margin-left:auto;margin-right:auto')
            return tag

        if name not in ('table', 'td', 'th', 'tr'):
            return tag

        css = []
        if name == 'table':
            css.append('border-collapse:collapse')

        a = re.search(r'\balign="(\w+)"', tag)
        if a:
            css.append('margin-left:auto;margin-right:auto' if name == 'table'
                       else f'text-align:{a.group(1)}')

        v = re.search(r'\bvalign="(\w+)"', tag)
        if v:
            css.append(f'vertical-align:{v.group(1)}')

        w = re.search(r'\bwidth="([\d.]+%?)"', tag)
        if w:
            val = w.group(1)
            css.append(f'width:{val}' if val.endswith('%') else f'width:{val}px')

        # A fixed-width table is block-level, so text-align:center on the parent
        # cell will not centre it — it needs auto margins of its own.
        #
        # It also needs text-align:left. align="center" on the outer wrapper cell
        # exists only to centre this table; browsers map it to
        # text-align:-webkit-center, which centres the block child WITHOUT
        # dragging every nested paragraph along with it. Plain text-align:center
        # is a normal inherited value, so once we rewrite the attribute the whole
        # issue arrives centred. Resetting here stops the inheritance at the body
        # table; cells carrying their own align="center" still re-centre below.
        if name == 'table' and (
                (w and not w.group(1).endswith('%')) or
                re.search(r'style="[^"]*width:\d+px', tag)):
            css.append('margin-left:auto;margin-right:auto')
            css.append('text-align:left')

        return add_style(tag, ';'.join(css))

    return re.sub(r'<(\w+)\b[^>]*>', fix, html)


def build(month):
    src = os.path.join(ROOT, 'newsletter', month, 'index.html')
    html = open(src, encoding='utf-8').read()

    # fragment only — document-level tags get escaped into visible text
    body = re.search(r'<body[^>]*>(.*)</body>', html, re.S)
    if not body:
        sys.exit('could not find <body> in ' + src)
    frag = body.group(1)

    # comments would be shown to the reader verbatim
    frag = re.sub(r'<!--.*?-->', '', frag, flags=re.S)

    frag = inline_layout(frag)

    # one line: every newline would otherwise become a paragraph break
    frag = re.sub(r'>\s+<', '><', frag)          # whitespace between tags
    frag = re.sub(r'\s*\n\s*', ' ', frag)        # newlines inside text runs
    frag = re.sub(r'[ \t]{2,}', ' ', frag).strip()
    return frag


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: newsletter_publish.py YYYY-MM')
    month = sys.argv[1]
    frag = build(month)

    out = os.path.join(ROOT, 'newsletter', month, 'email.html')
    open(out, 'w', encoding='utf-8').write(frag)

    print(f'built newsletter/{month}/email.html')
    print(f'  {len(frag):,} chars, {frag.count(chr(10))} newlines '
          f'(must be 0), {frag.count("<img")} images')
    for bad in ('<!--', '<html', '<head', '<body', '<meta', '<title'):
        if bad in frag.lower():
            print(f'  [!] still contains {bad}')
    if len(frag) > 100000:
        print('  [!] over the 100,000-char Airtable long-text limit')

    recs = json.load(urllib.request.urlopen(urllib.request.Request(URL, headers=HDR)))['records']
    match = [r for r in recs if r['fields'].get('Issue') == month]
    if not match:
        print(f'  no Newsletters row for {month} — create one first')
        return

    body = json.dumps({'records': [{'id': match[0]['id'], 'fields': {'HTML': frag}}]}).encode()
    req = urllib.request.Request(URL, data=body, method='PATCH', headers=HDR)
    rec = json.load(urllib.request.urlopen(req))['records'][0]
    print(f"pushed to Airtable ({rec['id']}) — {len(rec['fields']['HTML']):,} chars stored")


if __name__ == '__main__':
    main()
