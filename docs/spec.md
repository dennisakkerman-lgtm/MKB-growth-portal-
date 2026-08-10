# MKB Growth Portal — Build Spec

**Stack:** Supabase (Postgres, Auth, Storage, RLS) + Railway (API, workers, cron, Redis)
**Scope v1:** Google Search Console + Google Analytics 4. GBP en GEO in fase 2, Ads later of nooit.
**Uitgangspunt:** actie-gedreven, niet dashboard-gedreven. Elke bevinding heeft een knop.

---

## 1. Waarom dit geen dashboard is

Google geeft Search Console gratis weg. Looker Studio ook. Bouw je een mooiere weergave van dezelfde data, dan churnt de klant in maand vier.

Drie regels die het hele ontwerp bepalen:

1. **Alles in euro's.** Geen impressies, geen CTR, geen posities op het hoofdscherm. "Deze pagina laat €480 per maand liggen."
2. **Elke bevinding heeft een actie.** Een kans zonder knop is een verwijt.
3. **Nooit een leeg scherm.** Bij eerste login staat er 16 maanden historie en een ingevulde kansenlijst.

---

## 2. Architectuur

```
┌─ Supabase ──────────────────┐   ┌─ Railway ─────────────────────┐
│ Postgres + RLS              │   │ web      Next.js frontend     │
│ Auth (e-mail + Google)      │◄──┤ api      REST + OAuth callback │
│ Storage (rapport-PDF)       │   │ worker   BullMQ consumers      │
│ Realtime (jobstatus)        │   │ cron     scheduler             │
└─────────────────────────────┘   │ redis    queue + tokencache    │
                                  └───────────────────────────────┘
```

**Supabase** — enige bron van waarheid. RLS aan op alles. Service-role key uitsluitend in Railway-workers, nooit in de frontend.

**Railway** — vier services plus Redis. `worker` schaal je horizontaal zodra de backfills gaan lopen; dat is je enige echte piekbelasting.

**Queues (BullMQ):**

| Queue | Concurrency | Doel |
|---|---|---|
| `sync` | 5 | Dagelijkse deltasync |
| `backfill` | 2 | 16 maanden historie, lage prioriteit |
| `analyze` | 3 | Kansenengine per account |
| `publish` | 2 | Doorzetten naar de Blogfinity-pipeline |

Backfill in een aparte queue met lage prioriteit, anders blokkeert één nieuwe klant de dagelijkse sync van alle anderen.

**Tokens** — refresh tokens app-side versleuteld (AES-256-GCM, sleutel in Railway env) vóór opslag in Postgres. Access tokens in Redis met TTL, nooit in Postgres.

---

## 3. Datamodel

### 3.1 Accounts

```sql
create table accounts (
  id             uuid primary key default gen_random_uuid(),
  company_name   text not null,
  website        text,
  industry       text,
  status         text not null default 'onboarding',
  -- economische aannames, ingevuld bij onboarding
  avg_deal_value numeric,              -- gemiddelde klantwaarde in euro
  conv_rate      numeric,              -- 0-1, uit GA4 of handmatig
  created_at     timestamptz default now()
);

create table account_users (
  account_id uuid references accounts(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','member')),
  primary key (account_id, user_id)
);

create table onboarding_steps (
  account_id   uuid references accounts(id) on delete cascade,
  step         text not null,
  completed_at timestamptz,
  primary key (account_id, step)
);
```

### 3.2 Koppelingen

```sql
create table google_connections (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  google_email   text not null,
  refresh_token  bytea not null,
  scopes         text[] not null,
  status         text default 'active',   -- active | revoked | error
  last_error     text,
  last_synced_at timestamptz,
  created_at     timestamptz default now()
);

create table gsc_properties (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  connection_id uuid not null references google_connections(id) on delete cascade,
  site_url      text not null,            -- 'sc-domain:example.nl'
  is_active     boolean default true,
  backfilled_at timestamptz,
  unique (connection_id, site_url)
);

create table ga4_properties (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  connection_id uuid not null references google_connections(id) on delete cascade,
  property_id   text not null,            -- 'properties/123456789'
  display_name  text,
  is_active     boolean default true,
  unique (connection_id, property_id)
);
```

### 3.3 Metrics

Twee GSC-tabellen, want gecombineerde dimensies verliezen rijen door Google's drempelwaarden. Haal query en page apart op.

```sql
create table gsc_query_daily (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  query       text not null,
  device      text,
  clicks      int, impressions int,
  position    numeric(6,2), ctr numeric(6,4)
);
create unique index on gsc_query_daily
  (property_id, date, md5(query), coalesce(device,''));
create index on gsc_query_daily (account_id, date);

create table gsc_page_daily (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  page        text not null,
  clicks      int, impressions int,
  position    numeric(6,2), ctr numeric(6,4)
);
create unique index on gsc_page_daily (property_id, date, md5(page));

-- query × page, alleen laatste 90 dagen: nodig om te bepalen
-- wélke pagina rankt voor welke zoekopdracht
create table gsc_query_page_recent (
  id          bigserial primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  property_id uuid not null references gsc_properties(id) on delete cascade,
  date        date not null,
  query       text not null,
  page        text not null,
  clicks      int, impressions int, position numeric(6,2)
);
create unique index on gsc_query_page_recent
  (property_id, date, md5(query), md5(page));

create table ga4_daily (
  id            bigserial primary key,
  account_id    uuid not null references accounts(id) on delete cascade,
  property_id   uuid not null references ga4_properties(id) on delete cascade,
  date          date not null,
  channel_group text,
  landing_page  text,
  sessions int, users int, engaged_sessions int,
  conversions numeric, revenue numeric
);
create unique index on ga4_daily
  (property_id, date, coalesce(channel_group,''), md5(coalesce(landing_page,'')));
```

Partitioneren pas boven ~50M rijen. Niet vooraf optimaliseren.

### 3.4 Kansen en acties

```sql
create table opportunities (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  type          text not null,   -- striking_distance | low_ctr | decay |
                                 -- missing_page | cannibalisation | conv_gap
  query         text,
  page          text,
  -- ruwe signalen
  impressions   int,
  position      numeric(6,2),
  current_ctr   numeric(6,4),
  -- vertaalde waarde
  extra_clicks  int,             -- geschatte extra klikken per maand
  value_eur     numeric,         -- extra_clicks * conv_rate * avg_deal_value
  effort        text,            -- low | medium | high
  priority      int,             -- value_eur gedeeld door effort-factor
  status        text default 'open',  -- open | in_progress | done | dismissed
  first_seen_at timestamptz default now(),
  resolved_at   timestamptz
);
create index on opportunities (account_id, status, priority desc);
create unique index on opportunities
  (account_id, type, md5(coalesce(query,'')), md5(coalesce(page,'')))
  where status = 'open';

create table actions (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  kind           text not null,  -- new_page | rewrite | meta_fix | merge_pages
  status         text default 'queued',
                 -- queued | generating | review | approved | published | failed
  brief          jsonb,
  document_id    uuid,           -- verwijzing naar Blogfinity-document
  published_url  text,
  created_at     timestamptz default now(),
  published_at   timestamptz
);

-- meting achteraf: werkte de actie?
create table action_outcomes (
  action_id       uuid primary key references actions(id) on delete cascade,
  baseline_clicks int,
  baseline_pos    numeric(6,2),
  measured_at     timestamptz,
  after_clicks    int,
  after_pos       numeric(6,2),
  delta_value_eur numeric
);
```

`action_outcomes` is geen luxe. Dit is het enige harde bewijs dat je levert wat je belooft, en het voedt zowel het maandrapport als je verlengingsgesprek.

### 3.5 RLS

Zet `account_id` als claim in de JWT bij login.

```sql
alter table opportunities enable row level security;

create policy account_isolation on opportunities
  using (account_id = (auth.jwt() ->> 'account_id')::uuid);
```

Denormaliseer `account_id` naar élke tabel, ook de metrics. Scheelt joins in elke policy en dat merk je bij grote tabellen.

---

## 4. Connectors

### 4.1 OAuth

```
openid email profile
https://www.googleapis.com/auth/webmasters.readonly
https://www.googleapis.com/auth/analytics.readonly
```

Beide zijn *sensitive*, niet *restricted*. Verificatie vereist, maar naar verwachting geen security assessment — dat komt pas bij `business.manage` in fase 2. Verifieer dit zelf in de Cloud Console voordat je het inplant.

`access_type=offline`, `prompt=consent`. Bij `invalid_grant`: connection op `revoked`, mail naar de klant, herkoppel-CTA prominent in de portal.

Je testklanten zet je als OAuth test users neer terwijl de verificatie loopt. Geen blocker.

### 4.2 Search Console

`POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`

- Properties: `GET /webmasters/v3/sites`
- Max 25.000 rijen per request, pagineren met `startRow`
- Data-vertraging 2–3 dagen: haal altijd de laatste 7 dagen opnieuw op en upsert
- Drie aparte runs per dag: `[date,query,device]`, `[date,page]`, `[date,query,page]`
- Backfill: 16 maanden, in maandblokken, met exponential backoff

Prefereer domeinproperty's (`sc-domain:`) boven URL-prefix — anders mis je subdomeinen en http/https-varianten.

### 4.3 GA4

`POST https://analyticsdata.googleapis.com/v1beta/{property}:runReport`

- Property's ophalen via Admin API `accountSummaries`
- Dimensies: `date`, `sessionDefaultChannelGroup`, `landingPage`
- Metrics: `sessions`, `totalUsers`, `engagedSessions`, `conversions`, `totalRevenue`
- Quota werkt met tokens per property per uur; houd requests grofmazig

Bij onboarding: detecteer welke conversie-events bestaan en laat de klant aanvinken wat een *aanvraag* is. Zonder die mapping kun je geen euro's berekenen.

---

## 5. Vertaallaag — van GSC-jargon naar euro's

Dit is het product. De rest is plumbing.

### 5.1 CTR-curve per account

Gebruik geen generieke branchecurve. Bereken de curve uit de eigen data van het account:

```sql
select round(position) as pos,
       sum(clicks)::numeric / nullif(sum(impressions),0) as ctr
from gsc_query_daily
where account_id = $1
  and date >= current_date - 90
  and position <= 20
group by 1 having sum(impressions) > 500;
```

Onder de 500 impressies per positie val je terug op een generieke curve (ongeveer: p1 28%, p2 15%, p3 11%, p4 8%, p5 6%, p6 5%, p7 4%, p8 3%, p9 3%, p10 2,5%, p11–20 1%). Zodra er genoeg eigen data is, wint de eigen curve — die houdt automatisch rekening met AI Overviews, local packs en de branche.

### 5.2 Waarde van een kans

```
extra_clicks = impressions_pm * (ctr_bij_doelpositie - ctr_huidig)
value_eur    = extra_clicks * conv_rate * avg_deal_value
```

`conv_rate` uit GA4 (aanvragen ÷ organische sessies), `avg_deal_value` vraag je bij onboarding. Beide aanpasbaar door de klant, met de aanname zichtbaar onder elk bedrag:

> *Geschat op 3,2% aanvraagratio en €850 gemiddelde klantwaarde. [aanpassen]*

Nooit een euro tonen zonder de aanname erbij. Eén keer een onrealistisch bedrag en je hele portal is ongeloofwaardig.

### 5.3 Kanstypen

| Type | Detectie | Doel | Effort |
|---|---|---|---|
| `striking_distance` | positie 11–20, impressies > 100/mnd | positie 6 | medium |
| `low_ctr` | positie ≤ 10, CTR < 60% van curve | curve-CTR | **low** |
| `missing_page` | query met impressies waar homepage of irrelevante URL rankt | eigen pagina | high |
| `decay` | klikken −30% t.o.v. 3-maands basis of jaar-op-jaar | herstel basis | medium |
| `cannibalisation` | ≥ 2 URL's wisselen op dezelfde query | samenvoegen | medium |
| `conv_gap` | veel sessies, conversie < 40% van site-gemiddelde | site-gemiddelde | medium |

`low_ctr` is je snelste winst: alleen title en meta description aanpassen, resultaat binnen twee weken zichtbaar. Zet die bovenaan bij een nieuwe klant — het is je activatiebewijs.

### 5.4 Prioritering

```
priority = value_eur / effort_factor      -- low 1, medium 2.5, high 5
```

Toon maximaal tien open kansen. Meer verlamt. Nieuwe kansen komen pas in beeld als er eentje is afgehandeld.

### 5.5 Woordenboek

Deze termen komen niet in de interface voor:

| Nooit | Wel |
|---|---|
| Impressies | Hoe vaak u getoond bent |
| CTR | Hoeveel mensen doorklikten |
| Gemiddelde positie | Uw plek in Google |
| Query | Waar men op zoekt |
| Landingspagina | Pagina waar bezoekers binnenkomen |
| Indexering | Of Google uw pagina kent |

---

## 6. Schermen

**1. Overzicht**
Vier getallen: bezoekers via Google deze maand (met verandering), aanvragen, geschatte omzet uit organisch, openstaande kansen in euro's. Eén grafiek: bezoekers over 16 maanden. Daaronder de top 3 kansen met knop.

**2. Kansen**
De lijst. Per kans: één zin wat er aan de hand is, het bedrag, en de actieknop. Uitklapbaar naar de onderliggende cijfers voor wie het wil zien — dichtgeklapt voor wie niet.

**3. Waarop word je gevonden**
Zoekopdrachten, gesorteerd op waarde in plaats van klikken. Filters op plaats en dienst. Dit is de enige plek waar iets van een tabel mag staan.

**4. Pagina's**
Per pagina: bezoekers, aanvragen, waarde, trend. Rood als het terugloopt.

**5. Acties**
Wat loopt er, wat wacht op goedkeuring, wat is gepubliceerd, en wat het opgeleverd heeft (`action_outcomes`). Dit scherm draagt je verlenging.

**6. Rapport**
Maandelijkse PDF uit Supabase Storage, automatisch gemaild.

---

## 7. Jobs

| Job | Cron | Doel |
|---|---|---|
| `sync:gsc` | 03:00 | laatste 7 dagen, 3 dimensiecombinaties |
| `sync:ga4` | 03:30 | laatste 7 dagen |
| `analyze:opportunities` | 05:00 | kansenengine per account |
| `measure:outcomes` | 05:30 | acties ouder dan 28 dagen meten |
| `report:monthly` | 1e, 07:00 | PDF genereren en mailen |
| `backfill:gsc` | on-demand | 16 maanden, lage prioriteit |

Elke run een rij in `sync_runs` met status, duur, rijen en fout. Drie fouten op rij → connection op `error` en klant mailen.

---

## 8. Bouwvolgorde

| Dag | Scope |
|---|---|
| 1 | Railway-services, Supabase-schema, RLS, auth, OAuth-flow |
| 2 | GSC-connector: property-discovery, dagsync, backfill-queue |
| 3 | GA4-connector + conversie-mapping in onboarding |
| 4 | Vertaallaag: CTR-curve, waardeberekening, kanstypen |
| 5 | Schermen 1 t/m 4 |
| 6 | Actiebrug naar Blogfinity, scherm 5 |
| 7 | Maandrapport, e-mails, `action_outcomes` |

---

## 9. Eerste klant live

1. Account aanmaken, klant als OAuth test user toevoegen
2. Koppelen — GSC en GA4 in één flow
3. Property's kiezen; heeft de klant meerdere sites, dan meerdere property's onder één account
4. Conversie-events aanvinken
5. Gemiddelde klantwaarde invullen
6. Backfill starten (16 maanden, reken op 10–30 minuten)
7. Kansenengine draaien
8. **Handmatig controleren voordat de klant inlogt:** kloppen de euro's? Ziet de top-10 er logisch uit voor iemand die het bedrijf kent?

Punt 8 sla je niet over bij de eerste vijf klanten. Eén kans van €4.000 op een zoekopdracht die nergens over gaat, en het vertrouwen is weg.

---

## 10. Fase 2

Zodra dit staat en de eerste klanten waarde zien:

- **GBP** — de restricted scope, dus verificatie nu alvast starten
- **GEO** — citatietracking, hergebruik de Perplexity-tracker
- **Dienst×plaats-engine** — programmatische lokale pagina's
- **Ads** — alleen als klanten erom vragen
