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
| `AWA_PRESENCE_MINUTES` | `30` | Hány percet töltsön az AWA Control Center felületén. |
| `AWA_DAILY_TARGET_MINUTES` | `250` | Napi elérendő Twitch nézési idő (percben). |
| `AWA_ARP_TARGET` | `0` | Ha az ARP egyenleg eléri ezt a számot, az AWA futás kihagyja a napot (`0` = kikapcsolva). |
| `AWA_WATCH_CHUNK_MINUTES` | `30` | Hány perces blokkokban nézzen egy streamert, mielőtt újra ellenőrzi a kvótát. |
| `AWA_TWITCH_RECHECK_MINUTES` | `10` | Ha senki sem élő a megadott listából, ennyi perc múlva próbálja újra. |
| `AWA_TWITCH_STREAMERS` | *Streamer lista* | Vesszővel elválasztott Twitch felhasznalónevek. |
| `AWA_SCHEDULE_HOURS` | `0` | Független napi időablak hossza órában (`0` = ki van kapcsolva az időzítő). |
| `AWA_SCHEDULE_START` | `8` | Az AWA időablak kezdő órája (pl. `8` = 08:00). |
| `TWITCH_CLIENT_ID` *(opcionális)* | – | Twitch Developer App Client ID (gyors API ellenőrzéshez). |
| `TWITCH_CLIENT_SECRET` *(opcionális)* | – | Twitch Developer App Client Secret. |

> [!NOTE]
> A Twitch API kulcsok opcionálisak! Ha nem adod meg őket, a beépített böngészős fallback automatikusan megvizsgálja a streamer állapotát.
