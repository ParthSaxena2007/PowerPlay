# Power Play: Energy Trading Competition

A live, multi-team energy trading game. Teams of two meet a power target each round
and trade coal, gas, hydro, solar and wind based on market news.

- **Players:** `/` (register or log in) → `/play` (trading desk)
- **Organisers:** `/admin` (live control and every game setting)
- **Projector:** `/screen` (headlines, timer, leaderboard, final podium)

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
ADMIN_PASSWORD=choose-a-strong-one npm start
# open http://localhost:3000
```

On Windows PowerShell: `$env:ADMIN_PASSWORD="choose-a-strong-one"; npm start`

## Deploy online for free (Render + Upstash + UptimeRobot)

1. **Upstash (free cloud backup):** create a free Redis database at upstash.com and copy its
   REST URL and REST token.
2. **GitHub:** upload this folder to a repository.
3. **Render:** New → Blueprint → pick the repository. Fill in `ADMIN_PASSWORD`,
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Apply.
4. **UptimeRobot (keeps it awake):** add an HTTP monitor for
   `https://your-app.onrender.com/api/public` every 5 minutes.

Run only one instance; the game state lives in one process.

## How the data is stored

Everything (settings, rounds, teams, trades, scores) is kept in memory for speed, saved to
`data/db.json` within half a second of any change, and copied to Upstash (if configured) within
two seconds. If the server restarts, it reloads from that
file and the game continues where it was. Back up `db.json` before the event if you want a copy
of your configured rounds; the **Raw data** tab in admin also lets you copy the whole setup as JSON.

## Everything the admin can change

**Settings tab:** game name, club name, starting credits, grid tariff per MW, points for meeting
the target, blackout threshold, green bonus and threshold, net-worth-to-points rate and weight,
screen timer buffer, warning time, team size limits, registration open/closed, leaderboard visibility.

**Resources tab:** add, remove, rename resources; colour; green / storable / weather-dependent;
end-of-game valuation price.

**Rounds tab (per round):** title, duration, target MW, points multiplier, hide leaderboard,
purchase cap (multiple of fair share, or a fixed override per resource), and per resource:
price, market supply per team, output % (weather), carbon tax. Headlines, scheduled flash news
(seconds after start), add / duplicate / reorder / delete rounds. An economics check shows profit
per unit, supply vs demand and whether the green bonus is reachable.

**Live control:** start next round, pause, resume, ±1 minute, end round now, send flash news
instantly, finish game, download results CSV, reset game, restore defaults, delete teams.

**Teams tab:** create teams, rename, edit members, cash, power points, holdings, reset password, delete.

## Game rules as implemented

- Market supply each round = supply per team × number of teams. Buying removes units from the
  shared market; selling returns them. Prices never change during a round.
- Purchase cap per team per round counts every unit bought, even if later sold.
- Teams choose generation units from their holdings before the timer ends. No plan means no power.
- Delivered MW = units × output %. Points = (delivered ÷ target) × target points, capped at 100%.
  Below the blackout threshold: zero points (the grid still pays for what was delivered).
- Green bonus if green MW ≥ threshold % of delivered MW (capped at target).
- Grid pays tariff × delivered MW (capped at target). Carbon tax = units burned × tax.
- Unused non-storable resources expire at round end.
- Trading points = (net worth − starting credits) ÷ credits-per-point × weight.
  Net worth uses current prices during the game and end values when the game is finished.
- Final score = power points + trading points. Ties: higher power points, then fewer blackouts.
- The players' timer ends a few seconds before the server lock so last clicks still count.

## Event-day checklist

1. Change `ADMIN_PASSWORD`, open `/admin`, review every round in the Rounds tab.
2. Close registration (Settings) once all teams are in, or create teams yourself.
3. Run one practice round, then **Reset game (keep teams and settings)**.
4. Open `/screen` on the projector.
5. Start round 1. Between rounds, explain nothing; just press **Start next round**.
6. After the last round press **Finish game**, then download the CSV.
