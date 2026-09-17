AMONG US MULTIPLAYER – RENDER VERZIA

Spustenie lokálne:
1. npm install
2. npm start
3. otvor http://localhost:3000

Render:
- Typ: Web Service
- Build Command: npm install
- Start Command: npm start
- Root Directory: nechaj prázdny

Server počúva na porte z process.env.PORT a na 0.0.0.0.
Web stránka je servovaná priamo z public/index.html.
Endpoint /health vráti OK a slúži na jednoduchú kontrolu servera.

KILL v tejto verzii nikoho automaticky nezabíja ani nevyberá cieľ.
