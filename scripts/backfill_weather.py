#!/usr/bin/env python3
"""Backfill Temp / Wind / Humidity / Sky on Mike's Balls records from Open-Meteo's
ERA5 archive, matched to each find's local date and hour.

Only ever writes the four weather fields — existing data is never touched.
Run with --dry-run to preview; --commit to actually PATCH Airtable.
"""
import json, sys, time, urllib.parse, urllib.request
from collections import defaultdict

TOKEN = 'patvUZhofHmUxBdGQ.de96f3bd149257e66c7995c7ee58c31f4eb390a3b51f5c8fcfb4792a44514f64'
BASE  = 'app3SuYCUnfvGghu5'
TABLE = 'Balls'
API   = f'https://api.airtable.com/v0/{BASE}/{urllib.parse.quote(TABLE)}'
TZ    = 'America/Los_Angeles'

# WMO weather interpretation codes -> plain-English sky
WMO = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
}


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_records():
    out, offset = [], None
    while True:
        url = API + '?pageSize=100' + (f'&offset={offset}' if offset else '')
        d = get(url, {'Authorization': f'Bearer {TOKEN}'})
        out += d['records']
        offset = d.get('offset')
        if not offset:
            return out


def local_date_hour(f):
    """Return (YYYY-MM-DD, hour) in local LA time, or None if unusable.

    Two historical shapes:
      - Date '2026-03-22T09:59:09Z'  -> the Z is spurious; it's local wall time
        (true UTC would put every find at 2am). Hour comes from the timestamp.
      - Date '2026-07-12' + Time '9:04 AM' -> local date and time already.
    """
    raw = f.get('Date')
    if not raw:
        return None
    if 'T' in raw:
        return raw[:10], int(raw[11:13])
    t = f.get('Time')
    if not t:
        return raw, 9          # no time recorded: assume a 9am morning walk
    try:
        clock, ampm = t.strip().split()
        h = int(clock.split(':')[0]) % 12
        if ampm.upper() == 'PM':
            h += 12
        return raw, h
    except Exception:
        return raw, 9


def fetch_day(date, lat, lng):
    q = urllib.parse.urlencode({
        'latitude': lat, 'longitude': lng,
        'start_date': date, 'end_date': date,
        'hourly': 'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code',
        'temperature_unit': 'fahrenheit', 'wind_speed_unit': 'mph', 'timezone': TZ,
    })
    d = get(f'https://archive-api.open-meteo.com/v1/archive?{q}')
    if 'hourly' not in d:
        raise RuntimeError(d.get('reason', 'no hourly data'))
    return d['hourly']


def main():
    commit = '--commit' in sys.argv
    records = fetch_records()

    # One API call per unique date — all finds sit in the same ERA5 grid cell.
    by_date = defaultdict(list)
    skipped = []
    for r in records:
        f = r['fields']
        dh = local_date_hour(f)
        if not dh or f.get('Lat') is None:
            skipped.append(r['id'])
            continue
        by_date[dh[0]].append((r, dh[1]))

    print(f'{len(records)} records, {len(by_date)} unique dates, {len(skipped)} unusable')

    updates, failures = [], []
    for i, (date, items) in enumerate(sorted(by_date.items()), 1):
        lat = items[0][0]['fields']['Lat']
        lng = items[0][0]['fields']['Long']
        try:
            hourly = fetch_day(date, lat, lng)
        except Exception as e:
            failures.append((date, str(e)))
            print(f'  [{i}/{len(by_date)}] {date}  FAILED: {e}')
            continue

        for rec, hour in items:
            idx = min(hour, len(hourly['time']) - 1)
            temp = hourly['temperature_2m'][idx]
            hum  = hourly['relative_humidity_2m'][idx]
            wind = hourly['wind_speed_10m'][idx]
            code = hourly['weather_code'][idx]
            if temp is None:
                failures.append((date, 'null temperature'))
                continue
            fields = {
                'Temp': round(temp),
                'Humidity': round(hum),
                'Wind': round(wind),
                'Sky': WMO.get(code, 'Unsettled'),
            }
            updates.append({'id': rec['id'], 'fields': fields})
            print(f'  [{i}/{len(by_date)}] {date} {hour:02d}:00 -> '
                  f"{fields['Temp']}°F, {fields['Humidity']}% hum, "
                  f"{fields['Wind']} mph, {fields['Sky']}")
        time.sleep(0.4)   # be polite to a free API

    print(f'\n{len(updates)} records ready, {len(failures)} failures')
    if failures:
        for d, e in failures:
            print('  FAIL', d, e)

    if not commit:
        print('\nDRY RUN — nothing written. Re-run with --commit to apply.')
        return

    for i in range(0, len(updates), 10):
        batch = updates[i:i + 10]
        body = json.dumps({'records': batch}).encode()
        req = urllib.request.Request(API, data=body, method='PATCH', headers={
            'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.load(r)
        print(f'  wrote {len(res["records"])} records')
        time.sleep(0.25)
    print(f'\nDone — {len(updates)} records updated.')


if __name__ == '__main__':
    main()
