require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { getSceData } = require('./sce-scraper');

const app = express();
app.use(cors());
app.use(express.static('public'));

const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

// Priority order matters: first calendar wins the border color on merged events
const CALENDARS = [
  { id: 'sdix00@gmail.com',            label: 'Stephen',      color: '#818CF8', gray: '#000000' },
  { id: 'littlemel1992@gmail.com',     label: 'Melissa',      color: '#F472B6', gray: '#888888' },
  {
    id: 'nfl_-m-0289q_Denver+Broncos#sports@group.v.calendar.google.com',
    label: 'Broncos',
    color: '#FB923C',
    gray: '#BBBBBB',
  },
];

// Emails that belong to calendar owners — filtered from attendee lists to
// avoid redundancy (they already appear as the calendar source label).
const OWNER_EMAILS = new Set(CALENDARS.map(c => c.id).filter(id => id.includes('@gmail') || id.includes('@qgenda')));
const CONTACT_ALIASES = new Map([
  ['dknox1948@gmail.com', 'DK'],
  ['tylene8@gmail.com', 'TY'],
  ['cdix95@gmail.com', 'CD'],
  ['talynn.hamlett@gmail.com', 'TL'],
]);

function shortContact(value) {
  if (!value) return '';
  const text = String(value).trim();
  const emailMatch = text.match(/^([^\s@<>]+)@([^\s@<>]+)$/);
  if (!emailMatch) return text;
  const email = text.toLowerCase();
  if (CONTACT_ALIASES.has(email)) return CONTACT_ALIASES.get(email);
  return emailMatch[1].replace(/[._-]+/g, ' ');
}

function shortContactList(value) {
  return String(value)
    .split(',')
    .map(part => shortContact(part))
    .filter(Boolean)
    .join(', ');
}

function buildAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

/**
 * Fetch events from all calendars for the next 21 days, then:
 *   - Deduplicate cross-calendar events by (title + start)
 *   - Roll up calendar labels: "Stephen · Melissa"
 *   - Filter owner emails out of attendee lists (they show as calendar labels)
 *   - Use the highest-priority calendar's gray for the border
 */
async function fetchAndDedupeEvents() {
  const auth = buildAuth();
  const gcal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE }).format(now);

  const byKey = new Map(); // dedupKey → merged event object

  for (const src of CALENDARS) {
    let items;
    try {
      const resp = await gcal.events.list({
        calendarId: src.id,
        timeMin: now.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });
      items = resp.data.items || [];
    } catch (err) {
      console.error(`[${src.label}] fetch error:`, err.message);
      continue;
    }

    for (const ev of items) {
      const start  = ev.start?.dateTime || ev.start?.date;
      const end    = ev.end?.dateTime   || ev.end?.date;
      const allDay = !ev.start?.dateTime;
      if (allDay && start < today) continue;
      const title  = ev.summary || '(No Title)';
      const key    = `${title}::${start}`;

      // Strip self + known owner emails; keep external attendees only
      const newAttendees = (ev.attendees || [])
        .filter(a => !a.self && !OWNER_EMAILS.has(a.email))
        .map(a => shortContact(a.displayName || a.email));

      if (byKey.has(key)) {
        const merged = byKey.get(key);

        // Add this calendar if not already in the list
        if (!merged.calendarLabels.includes(src.label)) {
          merged.calendarLabels.push(src.label);
          // Promote border color to higher-priority calendar if applicable
          const srcIdx     = CALENDARS.findIndex(c => c.label === src.label);
          const currentIdx = CALENDARS.findIndex(c => c.label === merged.primaryCalendar);
          if (srcIdx < currentIdx) {
            merged.primaryCalendar = src.label;
            merged.gray  = src.gray;
            merged.color = src.color;
          }
        }

        // Union external attendees (no duplicates)
        for (const a of newAttendees) {
          if (!merged.attendees.includes(a)) merged.attendees.push(a);
        }

        // Prefer a non-empty location
        if (!merged.location && ev.location) merged.location = ev.location;
      } else {
        byKey.set(key, {
          title,
          start,
          end,
          location:        ev.location || '',
          attendees:       newAttendees,
          calendarLabels:  [src.label],
          primaryCalendar: src.label,
          color:           src.color,
          gray:            src.gray,
          allDay,
        });
      }
    }
  }

  const events = Array.from(byKey.values())
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .map(ev => ({
      ...ev,
      // Convenience string for display: "Stephen · Melissa"
      calendar: ev.calendarLabels.join(' · '),
    }));

  return { events, fetchedAt: now.toISOString() };
}

// --- Dashnotes: fetch & parse the published Google Doc on every request ---
const DASHNOTES_URL = 'https://docs.google.com/document/d/e/2PACX-1vSNzj_LcdDhnA2hOPHRfcPiOb0Vo1vZ7mwEBigg1MjNXlQQ5i4Iiy2IftjY-8dqKIXtKowMn8VzTdBf/pub';
const DASHNOTES_TTL = 0;
let _dashCache = null;
let _dashCachedAt = 0;
const SCE_SCRAPE_URL = 'https://www.sce.com/mysce/myaccount';

async function fetchDashnotes() {
  if (_dashCache && Date.now() - _dashCachedAt < DASHNOTES_TTL) return _dashCache;
  try {
    const res = await fetch(DASHNOTES_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const SKIP = ['published using google docs', 'report abuse', 'learn more',
                  'updated automatically', 'dashnotes'];
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/?(p|div|br|li|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&#160;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"');
    _dashCache = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !SKIP.some(s => l.toLowerCase().includes(s)));
    _dashCachedAt = Date.now();
    console.log('[Dashnotes] fetched', _dashCache.length, 'items');
  } catch (err) {
    console.error('[Dashnotes] fetch error:', err.message);
    if (!_dashCache) _dashCache = [];
  }
  return _dashCache;
}

app.get('/api/events', async (req, res) => {
  try {
    const result = await fetchAndDedupeEvents();
    res.json(result);
  } catch (err) {
    console.error('Fatal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Server-rendered page for TRMNL X screenshot pipeline (portrait 1404×1872)
app.get('/trmnl', async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });

  try {
    // getSceData() is synchronous/non-blocking: it returns the last known
    // value immediately and refreshes stale data in the background, so SCE
    // can never slow down (let alone time out) this response.
    const [{ events: allEvents, fetchedAt }, notes] = await Promise.all([
      fetchAndDedupeEvents(),
      fetchDashnotes(),
    ]);
    const sce = getSceData();
    const normalizedNotes = notes.map(shortContactList);
    const now = new Date(fetchedAt);
    const TZ = 'America/Los_Angeles';
    const sourceUrl = `${req.protocol}://${req.get('host')}${req.baseUrl || ''}${req.path}`;

    function parseEventDate(iso, allDay) {
      return allDay ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
    }

    function fmt(iso, allDay) {
      if (allDay) return 'All Day';
      return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
      });
    }

    function dayLabel(iso, allDay) {
      const d = parseEventDate(iso, allDay);
      return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
    }

    // Abbreviate calendar labels for the far-right tag
    function calTag(str) {
      return str.split(' · ').map(s => {
        if (s === 'Stephen') return 'S';
        if (s === 'Melissa') return 'M';
        if (s === 'Broncos') return 'BRO';
        return s.substring(0, 3).toUpperCase();
      }).join('·');
    }

    function dayKey(iso, allDay) {
      const d = parseEventDate(iso, allDay);
      return d.toLocaleDateString('en-CA', { timeZone: TZ });
    }

    function sortValue(ev) {
      return parseEventDate(ev.start, ev.allDay).getTime();
    }

    const orderedEvents = [...allEvents].sort((a, b) => sortValue(a) - sortValue(b));

    // Group events by canonical local day key so each day renders once.
    const groupMap = new Map();
    const groupOrder = [];
    for (const ev of orderedEvents) {
      const key = dayKey(ev.start, ev.allDay);
      if (!groupMap.has(key)) {
        groupMap.set(key, { day: dayLabel(ev.start, ev.allDay), events: [] });
        groupOrder.push(key);
      }
      groupMap.get(key).events.push(ev);
    }

    const groups = groupOrder.map(key => groupMap.get(key));

    const rows = groups.map(g => {
      // Rollup consecutive events sharing the same title + calendar into one row
      const rolled = [];
      let i = 0;
      while (i < g.events.length) {
        const ev = g.events[i];
        let j = i + 1;
        while (
          j < g.events.length &&
          !ev.allDay && !g.events[j].allDay &&
          g.events[j].title === ev.title &&
          g.events[j].calendar === ev.calendar
        ) { j++; }
        if (j - i > 1) {
          const times = g.events.slice(i, j).map(e => fmt(e.start, false));
          rolled.push({ ...ev, _rolledTimes: times });
        } else {
          rolled.push(ev);
        }
        i = j;
      }

      return `\n<div class="day-sep"><span class="day-lbl">${g.day}</span><span class="day-rule"></span></div>\n`
        + rolled.map(ev => {
          if (ev._rolledTimes) {
            return `<div class="evt" style="border-left-color:${ev.gray}"><span class="evt-rolled"><span class="evt-times">${ev._rolledTimes.join(' ')}</span><span class="evt-body">${ev.title}<span class="evt-cal"> ${calTag(ev.calendar)}</span></span></span></div>`;
          }
          const sub = ev.location
            ? ev.location.split(',').slice(0, 2).join(',').trim()
            : ev.attendees.join(', ');
          return `<div class="evt" style="border-left-color:${ev.gray}"><span class="evt-time">${fmt(ev.start, ev.allDay)}</span><span class="evt-body">${ev.title}${sub ? `<span class="evt-sub"> · ${sub}</span>` : ''}<span class="evt-cal"> ${calTag(ev.calendar)}</span></span></div>`;
        }).join('\n');
    }).join('\n');

    const updatedAt = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
    const sceDate   = sce.fetchedAt
      ? new Date(sce.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1872">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #fff;
    color: #000;
    font-family: 'Helvetica Neue', Arial, sans-serif;
  }
  body {
    display: block;
  }
  .stage {
    position: relative;
    width: 1872px;
    height: 1404px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    padding: 24px 42px 8px;
    outline: 1.5px solid #aaa;
    outline-offset: -1px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 2.5px solid #000;
    padding-bottom: 10px;
    margin-bottom: 6px;
  }
  .hdr-title { font-size: 43.68px; font-weight: 700; letter-spacing: -0.3px; }
  .hdr-sub   { font-size: 24.96px; color: #777; }
  /* Day separator: small-caps label + thin rule */
  .day-sep {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 14px 0 2px 0;
  }
  .day-lbl {
    font-size: 24.96px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #555;
    white-space: nowrap;
  }
  .day-rule { flex: 1; height: 1px; background: #bbb; }
  /* Event row: 2-col grid — time fixed | content fills. Cal tag inline, no right-float gap. */
  .evt {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    align-items: baseline;
    gap: 0 10px;
    padding: 5px 10px 5px 8px;
    border-left: 4px solid #000;
    margin-bottom: 1px;
    background: #f9f9f9;
  }
  .evt:nth-child(even) { background: #fff; }
  .evt-time {
    font-size: 27.04px;
    font-weight: 700;
    color: #333;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .evt-body {
    font-size: 27.04px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evt-sub {
    font-size: 20.8px;
    font-weight: 800;
    color: #444;
    margin-left: 4px;
  }
  .evt-cal {
    font-size: 20.8px;
    font-weight: 800;
    color: #444;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-left: 6px;
  }
  /* Two-column: calendar left, notes right */
  .content-cols {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    overflow: hidden;
    min-height: 0;
  }
  .cal-col {
    flex: 2.35;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .notes-col {
    flex: 1;
    min-width: 0;
    border-left: 1.5px solid #ccc;
    padding-left: 20px;
    height: 100%;
    overflow: hidden;
  }
  .notes-col-hdr {
    font-size: 20.8px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #555;
    padding-bottom: 5px;
    border-bottom: 1px solid #bbb;
    margin-bottom: 4px;
  }
  .note-item {
    font-size: 27.04px;
    font-weight: 500;
    padding: 4px 0;
    border-bottom: 1px solid #f0f0f0;
    line-height: 1.35;
    color: #000;
  }
  /* Rolled-up: spans both grid columns */
  .evt-rolled {
    grid-column: 1 / -1;
    display: flex;
    align-items: baseline;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .evt-times {
    font-size: 17.68px;
    font-weight: 700;
    color: #444;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  /* SCE — pinned to bottom of canvas */
  .sce {
    padding: 10px 2px 20px;
    border-top: 2px solid #000;
    background: #fff;
  }
  .sce-hdr {
    font-size: 20.8px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: #444;
    margin-bottom: 8px;
  }
  .sce-row { display: flex; gap: 44px; align-items: baseline; flex-wrap: wrap; }
  .sce-lbl {
    font-size: 20.8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #444;
    margin-bottom: 2px;
  }
  .sce-val    { font-size: 35.36px; font-weight: 700; color: #000; }
  .sce-bill-val { font-size: 37.44px; font-weight: 700; color: #000; }
  .sce-val-sm { font-size: 27.04px; font-weight: 600; color: #222; }
  .sce-error  { font-size: 21.84px; color: #aaa; font-style: italic; }
  footer {
    border-top: 1px solid #ddd;
    padding-top: 6px;
    font-size: 19.76px;
    color: #bbb;
  }
</style>
</head>
<body>
<div class="stage">
<header>
  <span class="hdr-title">Upcoming Events</span>
  <span class="hdr-sub">21 days · ${updatedAt}</span>
</header>
<div class="content-cols">
  <div class="cal-col">${rows || '<div style="padding:12px 0;color:#aaa;font-size:18.72px">No events in the next 10 days.</div>'}</div>
  ${normalizedNotes.length ? `<div class="notes-col"><div class="notes-col-hdr">Notes</div>${normalizedNotes.map(n => `<div class="note-item">${n}</div>`).join('')}</div>` : ''}
</div>
<div class="sce">
  <div class="sce-hdr">SoCal Edison</div>
  ${sce.error ? `<div class="sce-error">${sce.error}</div>` : `<div class="sce-row">
    ${sce.projectedBill ? `<div><div class="sce-lbl">Proj. Bill</div><div class="sce-bill-val">${sce.projectedBill}</div></div>` : ''}
    <div><div class="sce-lbl">Due Date</div><div class="sce-val${sce.projectedBill ? '-sm' : ''}">${sce.dueDate || '—'}</div></div>
    ${sce.projectedKwh ? `<div><div class="sce-lbl">Proj. Usage</div><div class="sce-val-sm">${sce.projectedKwh}</div></div>` : ''}
    ${sce.usageToDateAmt ? `<div><div class="sce-lbl">To Date</div><div class="sce-val-sm">${sce.usageToDateAmt} · ${sce.usageToDateKwh || ''}</div></div>` : ''}
    ${sce.lastPayment ? `<div><div class="sce-lbl">Last Payment</div><div class="sce-val-sm">${sce.lastPayment}</div></div>` : ''}
  </div>`}
</div>
<footer>Calendars: ${CALENDARS.map(calendar => calendar.label).join(' · ')} &nbsp;|&nbsp; SCE updated ${sceDate} &nbsp;|&nbsp; Source: ${sourceUrl}</footer>
</div>
</body>
</html>`;

    res.set({
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.send(html);
  } catch (err) {
    console.error('TRMNL render error:', err);
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// SCE account data (non-blocking; refreshes in the background, see sce-scraper.js)
app.get('/api/sce', (req, res) => {
  res.json(getSceData());
});

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar Display running → http://localhost:${PORT}`);
});
