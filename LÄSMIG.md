# Frånvarokalender

Lägg hela mappen på nätverksdisken. All data sparas i `data.json`. En kopia per dag hamnar i `backups/`.

| Fil | Vad |
|---|---|
| `index.html`, `app.js`, `style.css` | Själva kalendern |
| `data.json` | Anställda, frånvarokoder och ifylld frånvaro |
| `server.ps1`, `starta-server.bat` | Valfri server (läge B) |

## Läge A – öppna direkt från nätverksdisken

1. Öppna `index.html` i **Edge** eller **Chrome** (dubbelklicka, eller dra in filen i webbläsaren).
2. Första gången: klicka **Välj mapp** och peka ut kalendermappen på nätverksdisken.
   Webbläsaren kommer ihåg mappen men frågar ibland om lov igen. Då räcker det att klicka **Fortsätt**.

Inget behöver installeras. Varje användare måste dock göra steg 2 en gång. Det fungerar inte i Firefox.

## Läge B – kör en liten server

En dator (som helst alltid är på) kör `starta-server.bat` från mappen på nätverksdisken.
Alla andra öppnar `http://DATORNAMN:8080/` i sin webbläsare. Ingen behöver välja mapp.

Första gången behöver en administratör på den datorn köra detta en gång (skriptet visar
exakt vad som ska köras om det saknas):

```
netsh http add urlacl url=http://+:8080/ user=DOMÄN\användare
netsh advfirewall firewall add rule name=Franvarokalender dir=in action=allow protocol=TCP localport=8080
```

Testa först lokalt med `starta-server.bat -LocalOnly` och öppna `http://localhost:8080/`.

Båda lägena kan användas samtidigt mot samma `data.json`.

## Teams

Teams flik **Webbplats** godtar bara `https://`-adresser. Varken `file://` eller `http://` kan
alltså visas direkt i en flik. Alternativ:

- Lägg en **länk** i kanalen (eller som flik av typen Länk) som öppnar kalendern i webbläsaren.
- Be IT publicera mappen bakom https (t.ex. IIS med certifikat). Då kan den läggas som Webbplats-flik.

## Användning

- **Fyll i:** klicka i en ruta (eller klicka och dra för flera dagar/personer) och tryck kodens
  bokstav, t.ex. `S`. Du kan också klicka på en kod i paletten.
- **Rensa:** `Delete` / `Backspace`, eller knappen *Rensa*.
- Helger (grå) och röda dagar (rödtonade) kan inte fyllas i. Markerar du en period hoppas de över.
- **Röda dagar:** svenska helgdagar läggs in i datan första gången ett år visas (i år och två år
  framåt). Därefter kan alla röda dagar döpas om, tas bort eller läggas till fritt via knappen
  *Röda dagar*. Borttagna dagar kommer inte tillbaka av sig själva, men det finns en knapp för att
  lägga tillbaka dem.
- **Ta bort anställd:** man måste skriva in personens namn exakt (stora/små bokstäver räknas) och
  klicka *Bekräfta ta bort*.
- Klick på en tom rad, ett namn eller en rubrik tar bort markeringen.
- Piltangenterna flyttar markeringen. Med `Shift` + pil eller `Shift` + klick utökar du den.
- Kolumnen **Idag** visar varje persons status idag. Utan kod står det *Tillgänglig*.
- **Scrolla i sidled:** svep med fingret eller pekplattan, `Shift` + scrollhjul, eller dra med musen
  i rubrikerna eller namnkolumnen.
- **Anställda** sorteras i bokstavsordning. Med **avskiljare** (t.ex. "Lager", "Kontor") delas listan
  i avsnitt, och varje avsnitt sorteras för sig. Avskiljare kan döpas om och flyttas upp/ner. Tar man
  bort en avskiljare flyttas dess anställda till avsnittet ovanför.
- **Frånvarokoder** läggs till, byter namn, sorteras och tas bort via knappen uppe till höger.
  Koder kan ha 1–3 tecken.
- Visa 1–24 månader åt gången (standard 6). Frånvaro sparas per datum, så inget försvinner om
  man visar färre månader.
- Mörkt tema är standard. Knappen *Ljust*/*Mörkt* byter, och valet sparas per dator.
- Sidan kollar efter ändringar var 3:e sekund och uppdateras av sig själv. Om två personer sparar
  samtidigt slås ändringarna ihop i stället för att skriva över varandra.
