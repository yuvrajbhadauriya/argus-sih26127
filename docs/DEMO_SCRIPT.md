# Judge demo script (5–7 minutes)

A walkthrough of NERO for the SIH26127 jury, in the order that tells the story: **see the city →
catch a watchlisted car live → trace where it went → spot an impossible trip → understand city
traffic → show it's production-grade.**

All plates below come from the simulated day in `public/sim/summary.json` (29 Sep 2026, seed 26127).

## Before the demo (2 minutes, once)

```bash
npm install
python3 pipeline/tools/link_local_videos.py   # local camera clips (or set VITE_VIDEO_SOURCE=supabase)
npm run dev                                   # http://localhost:5173
```

* Browser at 1440×900 or larger, light theme (dark theme is one click on the ☾ icon if the room is dark).
* Leave `VITE_SUPABASE_URL` unset for the scripted demo: the top-bar status pill shows
  **Simulated** and the login page offers the demo operator. (With Supabase configured the same
  flow runs on the private database through `/api/data` and new alerts arrive within 10 s.)
* Open `/login` in the tab and stop there.

## 0:00 — Sign in (20 s)

**Screen:** `/login`.

> "Operators sign in with their control-room account; roles come from the server, so only an
> operator or admin can acknowledge alerts or change the watchlist. Browsing is read-only for
> everyone else. Without a database configured, the prototype says so and gives us a demo
> operator."

Click **Continue as Demo Operator** → lands on the Live Map. Point at the top-right: *Demo Operator ·
Operator · Demo*, and the status pill *8/8 cameras · Nominal · Simulated*.

## 0:20 — The city at a glance (40 s)

**Screen:** Live Map `/`.

> "Eight ANPR cameras on Mumbai's Western Express Highway, LBS Marg, Dadar and Sion — real traffic
> clips pinned to the real junctions. KPIs across the top: cameras online, reads in the last
> hour, open alerts, network average speed (25.8 km/h), vehicles tracked today (2,600)."

Click the status pill once: *Data source: Simulated network* — "we never pretend: the vehicles
moving between cameras are simulated because the clips don't share cars; the roads, cameras and
code are real." Close it.

## 1:00 — An alert fires live (70 s)

Click **Replay the day** (bottom of the map). The clock starts at 07:58 IST at 60×.

> "This replays the simulated day. Every plate read streams into the live feed on the right, and
> the alert engine checks each read against the watchlist and for suspicious routes."

After ~7 seconds (08:05 IST) a red toast appears: **Watchlist hit: MH 01 CS 0126 — CRITICAL ·
JG-01 · Jogeshwari JVLR Junction**. The sidebar *Alerts* badge increments and an alert hotspot ring
appears on the map.

> "MH 01 CS 0126 is reported stolen from Jogeshwari East. Jogeshwari camera just read it."

Click **Open alert** in the toast → Alerts page with that alert selected. Show the mini-map, the
watchlist reason, and *Last sightings up to this alert*. Click **Acknowledge** → *Alert
acknowledged* toast, pending count drops, *Acknowledged by Demo Operator*.

> "In live mode new alerts arrive through the server API within seconds, and the server stamps who
> acknowledged it for the audit trail."

Leave the replay running.

## 2:10 — Where did it go? Trajectory reconstruction (80 s)

Click **View full route** (or type `MH 01 CS 0126` in the top search and press Enter).

**Screen:** Vehicle Trace `/vehicles?plate=MH01CS0126`.

> "Query any plate and we rebuild its path from every camera that saw it, in time order."

Point at: the road-snapped path down the Western Express Highway (JG-01 → AN-01 → VP-01 → SC-01,
then DD-01), numbered stops, direction arrows, the timeline with IST timestamps (08:05:00,
08:11:42, 08:18:24, 08:22:22, 08:52:12), heading at each camera, road distance and average speed
per hop. Press play on the map to replay the route.

> "Timestamps, camera locations, direction and the route — exactly what the PS asks for. Further
> down the timeline the same car shows up again in the evening, Dadar → Sion → Kurla → Bhandup."

## 3:30 — Suspicious route anomalies (60 s)

Back to **Alerts** → Type: **Route anomalies**.

1. **MH 04 AK 4356 — Cloned plate (critical).** Read at DD-01 (Dadar) 08:58:12 and BH-01 (Bhandup)
   09:01:16: 18.2 km by road in 3 minutes (≈ 356 km/h). "Two physical cars carry the same plate."
   Show the evidence timeline and the two points on the mini-map.
2. **MH 05 DN 0114 — Circling (high).** Looped Vile Parle Flyover ↔ Santacruz Airport Approach
   3 times in 19 minutes (21:05–21:25) with no destination — "possible reconnaissance near the
   airport."

Optional: drag the replay slider to 20:55 and set 120× — the circling alert fires live at 21:24.

## 4:30 — City traffic analytics (60 s)

**Screen:** Analytics `/analytics`.

Walk top-to-bottom: KPIs → **Congestion heatmap** on the GIS map (corridor intensity + camera load)
→ **Congestion bottlenecks** (volume × slowdown) → **Average speed by zone** and **Speed
distribution** (P10–P90) → **Hourly volume** / **Flow trends by zone** → **Origin–destination
matrix** and **Top flows** → **Corridors** (route density). Switch **Time window** to *AM peak*,
then *PM peak*.

> "Everything is computed from multi-camera journeys — the same trajectories the trace uses —
> so density, OD and bottlenecks all come from ANPR, not from a separate sensor."

## 5:30 — Accuracy and the model (30 s)

**Screen:** Model Performance `/model`.

> "Our evaluation harness measures plate accuracy against labelled Indian plate sets and per
> condition — night, rain, blur, angle. The figures shown are a sample run; the harness points at
> the trained GPU model's API and regenerates this page."

Then `/accuracy`: the golden set's night-IR, night-visible, dusk/dawn and glare rows are the
adverse-condition proof (no openly licensed night or rain street clip gave readable plates). On
`/cameras`, SC-01 (Santacruz) is the densest feed: roadside on the flyover, front plates read live.

## 6:00 — Production-grade (45 s)

* **Admin** `/admin`: camera registry (register / edit), watchlist (add / pause), roles, audit log.
  Sign out from the user menu, click **Register camera** → *Sign in required* (guests can look, not
  touch).
* Architecture slide: `docs/ARCHITECTURE.md` — edge inference on Jetson-class boxes, stream
  ingestion, event bus, partitioned Postgres/PostGIS, HLS via CDN; row-level security and audit
  trail for DPDP compliance.

> "Everything you saw runs on the same code path that reads the live database; plugging in the
> trained model is a configuration change, not a rewrite."

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| No toast after 10 s | The replay clock (top of the map / Alerts header) must be running; press ▶. Speed up to 120×. |
| Videos black | Run `link_local_videos.py`, or `VITE_VIDEO_SOURCE=supabase`. |
| Status pill says **Demo data** | `public/sim/*.json` failed to load — restart `npm run dev` from the repo root. |
| Reduced-motion OS setting | Works the same; flashes and pulses are simply off. |
