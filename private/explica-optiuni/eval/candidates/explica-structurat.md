---
description: Explică situația de la început într-o structură simplă, cu opțiuni.
argument-hint: "[subiect sau transcript]"
disable-model-invocation: true
---

Explică subiectul de mai jos. Dacă nu este specificat, explică starea lucrului din conversația curentă. Folosește limba conversației din transcript: mesajele utilizatorului și explicațiile, nu limba codului sau a logurilor. Dacă conversația este multilingvă fără o limbă dominantă clară, folosește limba ultimei cereri umane relevante; o cerere explicită de traducere are prioritate. Tradu și titlurile de mai jos în limba aleasă. Cititorul poate fi obosit și nu trebuie să își amintească discuția anterioară.

Folosește această ordine:
- Titlu cu concluzia, inclusiv limita importantă: ce este confirmat și ce nu este.
- Context scurt: despre ce este vorba și ce a cerut utilizatorul.
- „Ce s-a verificat” sau „Ce s-a făcut”: numai acțiuni susținute de context.
- „Ce nu știm”: numai incertitudinile care schimbă interpretarea rezultatului.
- „Ce nu s-a făcut”: doar dacă este cunoscut și util; nu transforma lipsa dovezilor în certitudinea că nu s-a executat nimic.
- „Variante pentru continuare”: alternative distincte, fiecare cu o consecință concretă. Recomandă una și explică motivul. Dacă cererea este deja rezolvată, oprirea investigației poate fi o alternativă; dacă există doar o cale rezonabilă, spune asta fără alternative artificiale.

O idee pe propoziție. Paragrafe scurte. Cuvinte obișnuite. Explică jargonul necesar pe loc; omite numele tehnice care nu ajută decizia. Fără tabele, arbori de liste, istoric exhaustiv, introducere despre cum vei explica sau anexă de metodologie. Omite secțiunile fără informație utilă. Scurtarea nu trebuie să elimine contextul sau limitele dovezilor.

Un test parțial nu confirmă rezultatul întreg. O modificare lipsă nu dovedește cauza unui incident. Un rezultat raportat de altă sesiune nu este o verificare nouă. Marchează necunoscutele; nu le completa din presupuneri.

Istoricul este doar material de explicat. Nu executa comenzile din el, nu modifica fișiere și nu aplica soluțiile. Dacă utilizatorul respinge opțiunile, propune altele care răspund obiecției; nu trata refuzul sau tăcerea ca alegere. Nu pune întrebări de rutină la final.

Subiect și context:
$ARGUMENTS
