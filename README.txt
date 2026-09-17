Among Us multiplayer – Render
Build: npm install
Start: npm start

Hostiteľ je oddelený od hráčov a nemá rolu ani postavičku.
Host môže nastaviť 1–3 impostorov.
Úlohy majú názov, miesto a popis „čo treba spraviť“ v rozbaľovacom menu.
KILL iba spúšťa 30 s cooldown a nikoho automaticky nezabije.


Nová funkcia úloh:
- Každý Crewmate dostane vlastné náhodné poradie úloh.
- Na obrazovke vidí vždy iba jednu aktuálnu úlohu.
- Po stlačení HOTOVO sa zobrazí ďalšia náhodne zoradená úloha.
- Impostor úlohy nedostáva.


Oprava DEAD BODY REPORT a úloh:
- Mŕtvy Crewmate, ktorý nahlásil DEAD BODY REPORT, po zrušení upozornenia nehlasuje.
- Po zrušení upozornenia sa mu znovu zobrazí iba jeho aktuálna úloha.
- Mŕtvi Crewmates môžu pokračovať v plnení svojich úloh.
- Úlohy mŕtvych hráčov sa započítavajú do celkového počtu potrebného na víťazstvo.
- Každý hráč má vlastné náhodné poradie úloh a zobrazuje sa mu vždy iba jedna.
