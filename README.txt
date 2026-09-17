Among Us multiplayer – kompletná verzia

Spustenie:
1. npm install
2. npm start
3. otvor http://localhost:3000

Render:
Build Command: npm install
Start Command: npm start
Root Directory: prázdne

Obsahuje:
- miestnosti a kódy
- host/VIP
- výber farby a Among Us ikony, farba je v jednej hre unikátna
- nastavenie úloh
- náhodné pridelenie jednej role Impostor
- 5-sekundové zobrazenie role
- úlohy s tlačidlom HOTOVO
- hostiteľský panel: živí/mŕtvi a počet hotových úloh
- KILL iba spustí 30 s cooldown; nikoho automaticky nevyberá ani nezabíja
- AIR raz za hru + DO AIR a počítadlo
- označenie hráča ako DEAD hostiteľom
- DEAD BODY REPORT
- EMERGENCY MEETING
- hlasovanie, SKIP a výsledok s menom hráča
- výhra pri 0 impostoroch, pri väčšine impostorov alebo po dokončení všetkých úloh


Oprava farieb a pozadia:
- Úvodná stránka má opäť obrázok umongus.jfif ako pozadie.
- Výber farby sa zobrazí okamžite na obrazovke Vytvoriť aj Hrať.
- Vybraná farba je výrazne označená.
- Kým nie sú všetky farby obsadené, každá farba môže byť použitá iba raz.
- Keď sú obsadené všetky farby, ďalší hráči môžu použiť aj už obsadené farby.


Nové funkcie:
- Hostiteľ môže v lobby nastaviť 1, 2 alebo 3 impostorov.
- Pri štarte sa náhodne vyberie presne nastavený počet impostorov.
- Na zvolený počet impostorov musí byť dostatok hráčov.
- Úloha má teraz 3 časti: Názov úlohy, Miesto a Čo treba spraviť.
- Popis „Čo treba spraviť“ sa hráčom zobrazuje cez rozbaľovacie (dropdown) menu pri každej úlohe.
