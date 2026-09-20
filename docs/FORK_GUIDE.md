# Free Games Claimer – Fork & Karbantartási Útmutató

Ez a dokumentum összefoglalja a **[LoginRs99/free-games-claimer](https://github.com/LoginRs99/free-games-claimer)** repó célját, a végrehajtott fejlesztéseket és refaktorálásokat, valamint a jövőbeli karbantartás lépésről lépésre követhető munkafolyamatát.

---

## 1. Mi a projekt?

A **Free Games Claimer (FGC)** egy nyílt forráskódú automatizáló eszköz, amely:
* Automatikusan igényli az ingyenes játékokat a népszerű digitális storefrontokról (**Epic Games, Prime Gaming, GOG, Steam**).
* Automatikusan gyűjti a **Microsoft Rewards** napi keresési pontjait.
* Figyeli és értesítést küld az egyéb akciókról (**Ubisoft, Humble Bundle, Fanatical, Lenovo Gaming key drops**).
* Beépített 5 fülös webes vezérlőpultot (**Web-UI**) és beágyazott **noVNC** felületet biztosít a captchák és bejelentkezések interaktív kezeléséhez.

### A Fork egyedi funkciója: Alienware Arena (AWA) Modul
A forkunk célja, hogy a hivatalos képességeken felül egyedi modullal egészítse ki a rendszert:
* **Alienware Arena (AWA)** automatizáció:
  * Napi jelenlét fenntartása az AWA Control Center felületén (`AWA_PRESENCE_MINUTES`).
  * Konfigurálható Twitch streamerek automatizált nézése a napi kvóta eléréséig (`AWA_DAILY_TARGET_MINUTES`).
  * ARP (Arena Rewards Points) egyenleg figyelése és cél elérésekor automatikus kihagyás (`AWA_ARP_TARGET`).
  * Független, háttérben futó (detached) időzítő ablak a főlánctól függetlenül.
  * Web-UI integráció: dedikált státuszkártya, egyedi indítási módválasztó (Full / Presence / Twitch), külön leállítási lehetőség, valamint ARP és nézési idő statisztikák.

---

## 2. Mi történt? (Refaktorálás és Architektúra-tisztítás)

1. **Upstream távoli kapcsolat javítása:**
   * Az `upstream` remote beállítása a hivatalos repo-ra: `https://github.com/feldorn/free-games-claimer.git`.
2. **`main` ág megtisztítása és szinkronizálása:**
   * A `main` ág frissítve lett a legfrissebb upstream állapotra (v2.11.17, commit `2366ed1`), és kizárólagosan tiszta upstream tükörként működik.
3. **SteamGifts kódmaradványok teljes kiirtása (Dead code cleanup):**
   * Az összes elavult SteamGifts változó, scheduler hurok, számláló és API hivatkozás eltávolításra került a `panel.js`, `config.js` és `app-config.js` fájlokból.
4. **Alienware Arena átemelése az új v2.11.17-es architektúrába:**
   * Az AWA modul és annak vezérlőpulti részei zökkenőmentesen lettek integrálva az upstream által bevezetett új Web-UI Auth (bcrypt jelszavak, session kezelés) és noVNC proxy rendszerbe.
5. **Kritikus Twitch Live-detektálási fejlesztés (Browser Fallback):**
   * Az eredeti implementáció elakadt, ha nem volt megadva Twitch API kulcs (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`).
   * **Új funkció:** Ha nincs API kulcs beállítva, a Playwright automatikusan betölti a streamer oldalát és a DOM állapotából észleli, hogy a streamer élő-e. Amennyiben élő, azonnal nézni kezdi újratöltés nélkül.
6. **Docker workflow frissítése:**
   * A `.github/workflows/docker-publish.yml` fel lett készítve a `custom/**` ágakra is.

---

## 3. Branching Stratégia (Upstream Tracking Pattern)

A tiszta és hosszú távon konfliktusmentes működés alapja a kétágas felépítés:

```
upstream/main (feldorn)
      │
      ▼  (git merge --ff-only)
  main (LoginRs99 - 100% tiszta mirror)
      │
      ▼  (git rebase main)
custom/alienware (Saját feature ág az AWA modullal)
```

* **`main`:** SOHA ne végezz rá egyedi commitot! Kizárólag az eredeti `feldorn/free-games-claimer` tükrözésére szolgál.
* **`custom/alienware`:** Ezen az ágon él az Alienware Arena modul. Itt fejlesztesz, és ezt futtatod Dockerben vagy szerveren.

---

## 4. Karbantartási Útmutató (Lépésről lépésre)

Amikor a hivatalos repóban (`feldorn`) új verzió vagy hibajavítás jelenik meg, kövesd az alábbi egyszerű lépéseket:

### 1. lépés: Upstream lekérése és a `main` tükör frissítése
```powershell
# Válts a main ágra
git checkout main

# Kérd le az új commitokat a feldorn repóból
git fetch upstream

# Fast-forward szinkronizáció
git merge --ff-only upstream/main

# Töltsd fel a frissített main-t a GitHubodra
git push origin main
```

### 2. lépés: A saját AWA ágad rábázisolása (Rebase)
```powershell
# Válts a saját custom ágadra
git checkout custom/alienware

# Bázisold újra a frissített main ágra
git rebase main
```
> [!TIP]
> Ha a rebase során konfliktus keletkezne (pl. az upstream is módosította a `src/panel/panel.js` vagy `src/sites.js` adott sorait), oldd fel a konfliktust, majd futtasd:
> ```powershell
> git add .
> git rebase --continue
> ```

### 3. lépés: Gyors tesztelés
Mielőtt pusholsz, mindig győződj meg a hibamentességről:
```powershell
# Szintaxis-ellenőrzés
Get-ChildItem -Recurse -Filter *.js -Exclude node_modules | ForEach-Object { node --check $_.FullName }

# Parancs normalizálási tesztek
node test/claim-cmd.js
```

### 4. lépés: Frissített ág feltöltése
Mivel rebase történt, a commit SHA-k megváltoztak, ezért biztonságos erőltetett feltöltés szükséges:
```powershell
git push --force-with-lease origin custom/alienware
```

---

## 5. Alienware Arena Beállítási Referencia

Az alábbi paramétereket megadhatod környezeti változóként (`.env` vagy Docker compose), illetve a Web-UI **Settings → Services → Alienware Arena** és **Settings → Scheduler** fülein:

| Változó / Kulcs | Alapértelmezett | Leírás |
| :--- | :--- | :--- |
| `AWA_ACTIVE` | `0` (kikapcsolva) | `1`-re állítva bekapcsolja az AWA szolgáltatást. |
| `AWA_RUN_MODE` | `full` | Indítási mód: `full` (1 = AWA + Twitch), `presence` (2 = csak AWA), `twitch` (3 = csak Twitch). |
| `AWA_PRESENCE_MODE` | `auto_cap` | Jelenlét mód: `auto_cap` (automatikusan ellenőrzi 5 percenként a Control Centert és az 5/5 ARP cap-nél azonnal leáll), `fixed` (fix időtartam), `disabled` (kikapcsolva). |
| `AWA_PRESENCE_MINUTES` | `25` | Biztonsági időlimit (auto_cap módban) vagy pontos időtartam (fixed módban). |
| `AWA_STREAMER_SELECTION_MODE` | `auto_2x` | `auto_2x`: A Control Center Hive & Nexus 2x élő streamereit nézi (kizárja az 1x partnereket). `manual_only`: csak a megadott listát. |
| `AWA_STOP_ON_TWITCH_CAP` | `true` | Azonnal leáll, amint a Control Center jelzi, hogy megvan a napi max Twitch ARP (`underCap: false` / Cap reached). |
| `AWA_DAILY_TARGET_MINUTES` | `120` | Biztonsági maximális futási idő Twitch nézésre. |
| `AWA_ARP_TARGET` | `0` | Ha a teljes ARP egyenleg eléri ezt a számot, az AWA futás kihagyja a napot (`0` = kikapcsolva). |
| `AWA_WATCH_CHUNK_MINUTES` | `30` | Hány perces blokkokban nézzen egy streamert, mielőtt újra ellenőrzi a Control Center pontjait és cap állapotát. |
| `AWA_TWITCH_RECHECK_MINUTES` | `10` | Ha épp senki sem élő a 2x listából, ennyi perc múlva ellenőrzi újra a Control Centert. |
| `AWA_TWITCH_STREAMERS` | `""` (üres) | Opcionális tartalék / manuális streamer lista. Alapértelmezetten üres: tisztán automatikusan a Hive & Nexus 2x élő streamereket keresi és nézi. |
| `AWA_SCHEDULE_HOURS` | `0` | Független napi időablak hossza órában (`0` = ki van kapcsolva az időzítő). |
| `AWA_SCHEDULE_START` | `8` | Az AWA időablak kezdő órája (pl. `8` = 08:00). |
| `TWITCH_CLIENT_ID` *(opcionális)* | – | Twitch Developer App Client ID (gyors API ellenőrzéshez). |
| `TWITCH_CLIENT_SECRET` *(opcionális)* | – | Twitch Developer App Client Secret. |

---

## 6. Működési Módok (1, 2, 3)

A Web-UI **Sessions** fülén az Alienware Arena kártyán a **Run** gombra kattintva felugró ablakban választható ki a kívánt feladat:
* **`1` – AWA presence + Twitch (Teljes rutin):**
  1. Ellenőrzi a Time on Site (TOS) pontokat. Ha már `5/5 ARP` van, azonnal átugorja a jelenlétet! Ha még nincs kész, megkezdi a jelenlétet és dinamikusan kilép, amint eléri a maximumot.
  2. Átlép a Twitch fázisra: felismeri a 2x Hive és Nexus élő streamereket és addig nézi őket, amíg az AWA szerint el nem éri a napi max cap-et.
* **`2` – AWA presence only (Csak jelenlét):**
  * Kizárólag az AWA Control Centeren gyűjti a napi Time on Site pontokat. Ha már kimaxoltad mára, azonnal leáll, nem pazarol időt. A Twitch nézést nem indítja el.
* **`3` – Twitch only (Csak Twitch stream nézés):**
  * Az AWA jelenlétet teljesen kihagyja.
  * Ellenőrzi a Twitch bejelentkezést, majd elkezdi nézni a 2x Hive & Nexus streamereket a Control Center élő listájából, amíg meg nem kapja az összes Twitch ARP pontot.

> [!NOTE]
> A Twitch API kulcsok opcionálisak! Ha nem adod meg őket, a beépített böngészős fallback automatikusan megvizsgálja a streamer állapotát.
