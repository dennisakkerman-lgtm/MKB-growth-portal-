# MKB Growth Portal

Actie-gedreven SEO/GEO-portal voor MKB. Supabase + Railway.
Fase 1: Google Search Console + GA4. GBP en GEO volgen.

Uitgangspunt: **geen dashboard.** Elke bevinding krijgt een bedrag in euro's
en een knop. Zie `docs/` voor de volledige spec.

---

## Structuur

```
apps/
  web/        Next.js frontend + API routes (OAuth callback)
  worker/     BullMQ workers, sync-jobs, scheduler
packages/
  core/       Google-clients, tokenversleuteling, kansenengine
supabase/
  migrations/ Schema
```

---

## Setup

### 1. Repo

```bash
git init
git add -A
git commit -m "init: mkb growth portal"
gh repo create mkb-portal --private --source=. --push
```

### 2. Dependencies

```bash
corepack enable
pnpm install
```

### 3. Supabase

```bash
brew install supabase/tap/supabase     # of: npm i -g supabase
supabase login
supabase link --project-ref <ref>
supabase db push
```

Lokaal draaien kan ook met `supabase start` — dan wijst `DATABASE_URL`
naar `postgresql://postgres:postgres@localhost:54322/postgres`.

### 4. Google Cloud

1. Nieuw project aanmaken
2. API's inschakelen: **Search Console API**, **Google Analytics Data API**,
   **Google Analytics Admin API**
3. OAuth consent screen: extern, app-naam = je merknaam (staat straks bij elke klant in beeld)
4. Scopes toevoegen: `webmasters.readonly`, `analytics.readonly` — beide *sensitive*
5. Testklanten toevoegen als **test users** (max 100) zodat je kunt starten
   terwijl de verificatie loopt
6. OAuth-client (webapplicatie), redirect URI:
   `http://localhost:3000/api/google/callback` en de productievariant

### 5. Env

```bash
cp .env.example .env
openssl rand -hex 32          # → TOKEN_ENCRYPTION_KEY
```

### 6. Draaien

```bash
docker run -d -p 6379:6379 redis:7-alpine   # of Railway Redis
pnpm dev:worker
pnpm dev:web
```

---

## Frontend genereren

De web-app is bewust niet gescaffold — die maak je vers:

```bash
cd apps
pnpm create next-app@latest web --typescript --tailwind --app --src-dir --use-pnpm
```

Daarna in `apps/web/package.json` de naam op `@portal/web` zetten en
`"@portal/core": "workspace:*"` toevoegen aan de dependencies.

Routes die je nodig hebt:

| Route | Doel |
|---|---|
| `GET /api/google/start` | `getAuthUrl(state)` → redirect |
| `GET /api/google/callback` | `exchangeCode()`, property's ophalen, backfill enqueuen |
| `POST /api/properties/select` | Property's activeren |
| `POST /api/onboarding/economics` | `avg_deal_value` + conversie-events |
| `POST /api/actions` | Kans → actie → Blogfinity-pipeline |

---

## Railway

Vier services vanuit dezelfde repo:

| Service | Root | Start |
|---|---|---|
| `web` | `apps/web` | `pnpm start` |
| `worker` | `apps/worker` | `pnpm start` |
| `redis` | plugin | — |

Env-variabelen op projectniveau zetten, niet per service. `DATABASE_URL`
wijst naar de Supabase session pooler (poort 5432, niet 6543 — de
transaction pooler ondersteunt geen prepared statements).

De scheduler draait binnen de worker via BullMQ repeatable jobs.
Geen aparte cron-service nodig.

---

## Eerste klant live

```bash
# 1. Account aanmaken
psql $DATABASE_URL -c "insert into accounts (company_name, website, status)
  values ('Testklant BV', 'https://testklant.nl', 'active') returning id;"

# 2. Klant koppelt via /api/google/start
# 3. Property's selecteren in de UI
# 4. Backfill enqueuen (16 maanden, 10-30 min)
# 5. Kansenengine draaien
```

**Controleer handmatig voordat de klant inlogt.** Kloppen de bedragen?
Ziet de top 10 er logisch uit voor iemand die het bedrijf kent?
Eén kans van €4.000 op een zinloze zoekopdracht en het vertrouwen is weg —
juist bij de klanten van wie je de referenties nodig hebt.

---

## Aandachtspunten

**GSC-data is 2-3 dagen vertraagd.** De dagsync haalt daarom 7 dagen terug
op en upsert; late correcties komen automatisch mee.

**Drie aparte dimensieruns.** Gecombineerde dimensies laten rijen vallen
door Google's drempelwaarden — precies in de long tail waar de kansen zitten.

**`gsc_query_page_recent` wordt op 90 dagen gehouden.** Die tabel groeit
het hardst en je hebt 'm alleen nodig voor actuele detectie.

**CTR-curve komt uit eigen data.** Generieke branchecurves houden geen
rekening met AI Overviews en local packs. Fallback pas onder 500 impressies
per positie.

**Geen euro's zonder aannames erbij.** Toon onder elk bedrag welke
conversieratio en klantwaarde gebruikt zijn, met een aanpasknop.
