// Default data used the first time the server starts (or after "Restore defaults").
// Every value here can be changed from the admin panel.

const resources = [
  { id: 'coal',  name: 'Coal',  color: '#5b5f66', green: false, storable: true,  weather: false, endValue: 550 },
  { id: 'gas',   name: 'Gas',   color: '#2f6fb0', green: false, storable: true,  weather: false, endValue: 750 },
  { id: 'hydro', name: 'Hydro', color: '#16867f', green: true,  storable: false, weather: false, endValue: 0 },
  { id: 'solar', name: 'Solar', color: '#d39a00', green: true,  storable: false, weather: true,  endValue: 0 },
  { id: 'wind',  name: 'Wind',  color: '#6f9a4a', green: true,  storable: false, weather: true,  endValue: 0 },
];

const config = {
  gameName: 'Power Play',
  clubName: 'Energy Club',
  startingCredits: 500000,
  tariff: 850,
  targetPoints: 100,
  blackoutThreshold: 50,
  greenBonus: 20,
  greenThreshold: 35,
  creditsPerPoint: 1000,
  cashWeight: 0.5,
  lockBufferSec: 5,
  warningSec: 60,
  teamSizeMin: 2,
  teamSizeMax: 2,
  registrationOpen: true,
  leaderboardVisible: true,
};

function r(n, title, target, prices, supplyPerTeam, efficiency, headlines, flash, extra = {}) {
  return {
    id: 'r' + n, title, durationSec: 720, target, multiplier: 1, hideLeaderboard: false, capMultiplier: 2, caps: {},
    prices, supplyPerTeam, efficiency,
    carbonTax: { coal: 50, gas: 0, hydro: 0, solar: 0, wind: 0 },
    headlines, flash, ...extra,
  };
}
const full = { coal: 100, gas: 100, hydro: 100 };

const rounds = [
  r(1, 'Opening bell', 100,
    { coal: 550, gas: 750, hydro: 400, solar: 350, wind: 380 },
    { coal: 90, gas: 30, hydro: 12, solar: 10, wind: 8 },
    { ...full, solar: 95, wind: 70 },
    ['IMD: mostly clear skies across Rajasthan and Gujarat this week',
     'Unverified: Coal India unions meet amid wage dispute',
     'Minister inaugurates new metro line in Pune',
     'Coastal wind speeds expected to stay below seasonal average'], []),
  r(2, 'Clouds on the horizon', 110,
    { coal: 600, gas: 760, hydro: 380, solar: 360, wind: 370 },
    { coal: 90, gas: 30, hydro: 14, solar: 10, wind: 8 },
    { ...full, solar: 55, wind: 95 },
    ['IMD forecasts 70% chance of early monsoon showers in western India',
     'Steel plants report record output for the quarter',
     'Shipping insurers raise premiums for Strait of Hormuz transits',
     'Celebrity cricketer buys an electric SUV'], []),
  r(3, 'Supply squeeze', 120,
    { coal: 720, gas: 820, hydro: 350, solar: 340, wind: 360 },
    { coal: 85, gas: 30, hydro: 18, solar: 10, wind: 8 },
    { ...full, solar: 70, wind: 60 },
    ['Wage talks collapse; union announces work-to-rule at several mines',
     'As widely expected, monsoon reaches Kerala on schedule',
     'Rupee slides to a record low against the dollar',
     'Sanctions talks against a major gas exporter enter final stage'],
    [{ atSec: 240, text: 'Sanctions imposed on major gas exporter. Shipments halted.' }]),
  r(4, 'Shockwaves', 120,
    { coal: 680, gas: 1050, hydro: 330, solar: 330, wind: 360 },
    { coal: 90, gas: 25, hydro: 20, solar: 10, wind: 8 },
    { ...full, solar: 100, wind: 50 },
    ['Diplomats confirm peace talks to begin next week',
     'Heatwave grips northern plains; clear skies expected',
     'Government drafts a revised carbon policy for thermal plants',
     'New LNG terminal in Gujarat completes trial run'], []),
  r(5, 'The storm', 130,
    { coal: 650, gas: 780, hydro: 340, solar: 350, wind: 340 },
    { coal: 90, gas: 30, hydro: 16, solar: 10, wind: 8 },
    { ...full, solar: 60, wind: 30 },
    ['Peace agreement signed; gas flows expected to normalise',
     'Cyclone watch issued for the western coast',
     'Carbon tax on thermal generation doubled with immediate effect',
     'Unverified: neighbouring grid seeks emergency power imports'],
    [{ atSec: 300, text: 'Cyclone intensifies. Coastal wind farms ordered to shut down for safety.' }],
    { carbonTax: { coal: 100, gas: 0, hydro: 0, solar: 0, wind: 0 } }),
  r(6, 'Final settlement', 150,
    { coal: 640, gas: 720, hydro: 360, solar: 340, wind: 300 },
    { coal: 95, gas: 30, hydro: 15, solar: 10, wind: 9 },
    { ...full, solar: 100, wind: 100 },
    ['Cyclone passes; clear skies and a steady breeze across the coast',
     'Offshore gas discovery announced in the Krishna-Godavari basin',
     'Analysts predict coal demand to stay firm through winter',
     'Tech giant opens new data centre in Hyderabad'], [],
    { multiplier: 2, hideLeaderboard: true, carbonTax: { coal: 100, gas: 0, hydro: 0, solar: 0, wind: 0 } }),
];

module.exports = { resources, config, rounds };
