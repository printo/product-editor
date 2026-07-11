# Diagrams — Current State

All diagrams are Mermaid; copy-paste into any Mermaid renderer (Notion, GitHub, mermaid.live).

## 4.1 — C4 Context

```mermaid
graph TB
  Buyer[Online Buyer]
  WalkIn[Walk-in Customer]
  CorpHR[Corporate HR]
  Recipient[Gift Recipient]
  Ops[Printo Ops Team]
  Cashier[Store Cashier]

  Buyer -->|browses, buys| PI[Printo.in<br/>Flask 1.0.2 + Next.js 12]
  WalkIn -->|orders in-store| Est[Estimator<br/>PHP @ cs.printo.in]
  Cashier -->|operates POS| Est
  CorpHR -->|creates campaign| PSE[Printose<br/>Django 2.2 + 2× Next 10]
  Recipient -->|/g/slug picks gifts| PSE
  Ops -->|admin| PI
  Ops -->|admin| PSE
  Ops -->|admin| PE[Product Editor<br/>Next.js 16 + Django 5]
  Buyer -->|personalises product| PE

  PI -->|create_session.php| Est
  Est -->|/hooks/erp_status| PI
  PSE -->|JWT auth| PIA[PIA<br/>pia.printo.in]
  PSE -->|/deliveryq/request-bulk| PIA
  PE -->|JWT auth| PIA
  PE -->|HMAC webhook<br/>callback_url| PI

  PI -->|payments| RPay[Razorpay /<br/>PayU / Paytm]
  PI -->|courier| Couriers[DTDC + 10 others]
  PI -->|email| Zepto[ZeptoMail]
  PI -->|SMS| Plivo[Plivo]
  PI -->|search| Search[Algolia +<br/>Typesense]
  PI -->|media| S3PI[S3<br/>ap-southeast-1]

  PSE -->|email| Zepto
  PSE -->|tickets| Zoho[Zoho Desk]
  PSE -->|bg removal| RemoveBg[remove.bg]

  PE -->|edge| CF[Cloudflare]

  classDef new fill:#d4edda,stroke:#155724
  classDef old fill:#f8d7da,stroke:#721c24
  classDef unknown fill:#fff3cd,stroke:#856404
  class PE new
  class PI,PSE old
  class Est,PIA unknown
```

## 4.2 — Container diagram: Printo.in

```mermaid
graph TB
  subgraph Printo.in
    NextJS[printo-nextjs<br/>Next 12 + Express server]
    Flask[Flask monolith<br/>~25 blueprints]
    LegacySPAs[6 in-repo React SPAs<br/>MarketV2, OpsManager,<br/>SalesManager, etc.]
    MySQL[(MySQL 8.0.42)]
    RedisPI[Redis<br/>sessions + cache]
    RMQ[RabbitMQ<br/>Celery broker]
    Celery[Celery workers]
  end

  Browser -->|HTTPS| NextJS
  NextJS -->|/api proxy| Flask
  Flask -->|SQLAlchemy| MySQL
  Flask -->|kvsession| RedisPI
  Flask -->|tasks| RMQ
  RMQ -->|consume| Celery
  Celery -->|writes| MySQL
  Flask -.->|server-rendered<br/>legacy pages| LegacySPAs

  Flask -->|gevent or sync<br/>UNVERIFIED| External[External services]
```

## 4.3 — Container diagram: Printose

```mermaid
graph TB
  subgraph Printose
    PSCustomer[printose<br/>Next 10.0.6<br/>recipient site]
    PSAdmin[printose_admin_ui<br/>Next 10.0.8<br/>admin console]
    PSAPI[printo_se_api<br/>Django 2.2 + DRF]
    PSDB[(Postgres 11)]
    PSRedis[Redis<br/>Celery broker only]
    PSCelery[Celery + django-celery-beat]
  end

  GiftRecipient -->|/g/slug| PSCustomer
  CorpHR -->|/admin-ui| PSAdmin
  PSCustomer -->|/api/v1| PSAPI
  PSAdmin -->|/api/v1| PSAPI
  PSAPI -->|Django ORM| PSDB
  PSAPI -->|broker| PSRedis
  PSRedis -->|consume| PSCelery
  PSAPI -.->|in-process<br/>LocMemCache| PSAPI

  PSCelery -->|REST| PIA
  PSCelery -->|REST| RemoveBg[remove.bg]
  PSCelery -->|REST| Zoho[Zoho Desk]
  PSCelery -->|SMTP| Email[ZeptoMail / SMTP]
```

## 4.4 — Container diagram: Product Editor

```mermaid
graph TB
  subgraph Product_Editor
    nginx[nginx 1.27<br/>edge + TLS]
    PEFE[Next.js 16<br/>frontend]
    PEBE[Django 5 + DRF<br/>+ gunicorn gthread]
    PEDB[(Postgres 16)]
    PERedis[Redis 7<br/>db0=broker<br/>db1=cache]
    PEPriority[celery-worker-priority]
    PEStandard[celery-worker-standard]
    PEBeat[celery-beat]
    PEDisk[Local disk<br/>EXPORTS_DIR]
  end

  CF[Cloudflare] -->|HTTPS| nginx
  nginx -->|/| PEFE
  nginx -->|/api| PEBE
  PEFE -->|server-side proxy| PEBE
  PEBE -->|Django ORM| PEDB
  PEBE -->|broker db0| PERedis
  PEBE -->|cache db1| PERedis
  PERedis -->|consume| PEPriority
  PERedis -->|consume| PEStandard
  PEBeat -->|schedule| PERedis
  PEPriority -->|writes ZIPs| PEDisk
  PEStandard -->|writes ZIPs| PEDisk
  PEBE -->|reads ZIPs| PEDisk
```

## 4.5 — Sequence: home-delivery order on Printo.in

```mermaid
sequenceDiagram
  participant U as Buyer
  participant N as Next.js 12
  participant F as Flask
  participant DB as MySQL
  participant R as Razorpay
  participant C as Celery
  participant Cou as Courier (DTDC)
  participant Z as ZeptoMail

  U->>N: add to cart
  N->>F: PUT /carts/mine
  F->>DB: INSERT cart_items
  U->>N: checkout
  N->>F: POST /cart-payment-attempts
  F->>R: create order
  R-->>U: payment page
  U->>R: pays
  R->>F: POST /hooks/razorpay-hooks
  F->>DB: SellerOrder paid
  F->>C: dispatch fulfillment task
  C->>Cou: book AWB
  Cou-->>C: AWB id
  C->>Z: send confirmation email
  C->>F: update Job status
```

## 4.6 — Sequence: store-pickup order (cross-system)

```mermaid
sequenceDiagram
  participant U as Buyer
  participant F as Flask (Printo.in)
  participant R as Razorpay
  participant C as Celery
  participant E as Estimator (PHP)

  U->>F: place order, store-pickup
  F->>R: payment
  R->>F: webhook paid
  F->>C: dispatch ERP push
  C->>E: POST cs.printo.in/api_create_session.php
  E-->>C: session_id
  Note over E: production work happens here
  E->>F: PUT /hooks/erp_status<br/>(status updates)
  F->>U: email "ready for pickup"
```

## 4.7 — Sequence: personalised-product order via embed (Product Editor)

```mermaid
sequenceDiagram
  participant U as Buyer
  participant SF as Storefront
  participant PE as Product Editor
  participant CW as Celery worker
  participant DL as ZIP download

  U->>SF: open PDP for fridge magnets
  SF->>PE: POST /api/embed/session<br/>{order_id, callback_url}
  PE-->>SF: {token, expires_at}
  SF-->>U: iframe loads ?token=<t>
  U->>PE: composes canvas, "Save & Continue"
  PE->>CW: render_canvas_task (300 DPI)
  Note over CW: Pillow renders to disk<br/>EXPORTS_DIR/<job_id>/
  CW->>SF: notify_caller_webhook_task<br/>POST callback_url<br/>X-Signature HMAC
  SF->>DL: GET download_url<br/>Bearer api_key
  DL-->>SF: ZIP stream
  SF->>SF: attach ZIP to order
  SF->>E: existing printo_integration → Estimator
```

## 4.8 — Sequence: walk-in retail order

```mermaid
sequenceDiagram
  participant W as Walk-in Customer
  participant Cash as Cashier
  participant E as Estimator (PHP)
  participant ?GST as GST e-invoice [UNVERIFIED]

  W->>Cash: walks in, requests print
  Cash->>E: enters quote
  E-->>Cash: estimate displayed
  W->>Cash: confirms, pays
  Cash->>E: marks paid
  E-->>?GST: generates invoice
  E-->>Cash: receipt
  Note over E: customer record + inventory<br/>changes happen entirely<br/>inside Estimator
```

> ⚠️ **This sequence is partially `[UNVERIFIED]`** because the Estimator source was not in scope. Confirming it requires reading the `cs.printo.in` PHP code.

## 4.9 — Sequence: corporate gifting (Printose)

```mermaid
sequenceDiagram
  participant HR as Corporate HR
  participant A as printose_admin_ui
  participant API as Django (printo_se_api)
  participant DB as Postgres
  participant Recipient
  participant Cust as printose Next 10
  participant RB as remove.bg
  participant PIA as PIA
  participant Cou as Courier (via PIA)

  HR->>A: creates GiftCampaign
  A->>API: POST /campaigns/<pk>/generate/
  API->>DB: bulk insert GiftRecipients
  API->>SMTP: email each recipient w/ /g/slug
  Recipient->>Cust: opens /g/slug
  Cust->>API: GET /gift/<slug>/
  Recipient->>Cust: picks products + uploads photo
  Cust->>RB: bg removal (or local MediaPipe)
  Cust->>API: PATCH /gift/<slug>/ (selections)
  Note over API: state machine<br/>moves through 19 states
  API->>PIA: POST /deliveryq/request-bulk
  PIA->>Cou: book courier
  Cou-->>Recipient: delivers
  Recipient->>Cust: /f/slug feedback
```

## 4.10 — Combined ER (cross-system duplication)

Highlights only what's duplicated/fragmented across systems. Intra-system schemas are in `11-appendix-data-model.md`.

```mermaid
erDiagram
  PI_PlatformUser {
    int id PK
    string email
    string phone
    string name
    bool is_buyer
    bool is_seller
    bool is_ops
  }
  PSE_User {
    int id PK
    string email
    string name
    M2M departments
  }
  PE_PIASession {
    string accessToken
    string refreshToken
    string employeeId
    string name
    bool isOpsTeam
  }
  Est_Customer {
    UNVERIFIED
  }

  PI_PlatformUser ||..o{ PSE_User : "no FK,<br/>matched by email if at all"
  PI_PlatformUser ||..o{ PE_PIASession : "no FK"
  PSE_User ||..o{ PE_PIASession : "no FK"
  PI_PlatformUser ||..o{ Est_Customer : "no FK,<br/>UNVERIFIED match"

  PI_Product {
    int id PK
    string name
    string slug
    decimal base_price
  }
  PSE_Product {
    int id PK
    string name
    decimal price
    json options_tree
  }
  Est_Product {
    UNVERIFIED
  }

  PI_Product ||..o{ PSE_Product : "no sync"
  PI_Product ||..o{ Est_Product : "no sync"

  PI_Job {
    int id PK
    int customer_id
    int product_id
    string status
  }
  PI_SellerOrder {
    int id PK
    int cart_id
    int seller_id
  }
  PSE_GiftRecipient {
    int id PK
    string slug
    int campaign_id
    string state
  }
  Est_Order {
    UNVERIFIED
  }

  PI_Job ||..o{ PI_SellerOrder : "in-system FK"
  PI_Job ||..o{ Est_Order : "PHP API only,<br/>no FK"
  PSE_GiftRecipient ||..o{ Est_Order : "DORMANT<br/>(commented out)"
```

**Key takeaway:** the three concept families — **customer, product, order** — exist in 3-4 disconnected stores with no foreign keys, no IDs that match, and no synchronisation mechanism. This is the single largest architectural debt.

## 4.11 — External dependency graph

```mermaid
graph LR
  subgraph Printo
    PI[Printo.in]
    PSE[Printose]
    PE[Product Editor]
    Est[Estimator PHP]
    PIA[PIA]
  end

  subgraph Payments
    Razorpay
    PayU
    Paytm
    Epaylater
  end

  subgraph Logistics
    DTDC
    Delhivery
    Shiprocket
    Aftership
    Dunzo
    Porter
    Aramex
    Clickpost
    Pickrr
    Shipmile
    Shyplite
    Trackingmore
  end

  subgraph Notifications
    ZeptoMail
    Plivo
    OneSignal
    SMTP[SMTP relay]
    RemoveBg[remove.bg]
  end

  subgraph CRM_ERP
    ZohoDesk[Zoho Desk]
    ZohoFlow[Zoho Flow]
  end

  subgraph Search
    Algolia
    Typesense
  end

  subgraph Cloud
    AWS_SG[AWS Singapore<br/>S3 / EC2]
    Cloudinary
    CF[Cloudflare]
  end

  subgraph APM
    Sentry
    NewRelic
    ElasticAPM[Elastic APM]
    Mixpanel
    Heap
    CleverTap
    GA[Google Analytics]
  end

  PI --> Razorpay & PayU & Paytm & Epaylater
  PI --> DTDC & Delhivery & Shiprocket & Aftership & Dunzo & Porter & Aramex & Clickpost & Pickrr & Shipmile & Shyplite & Trackingmore
  PI --> ZeptoMail & Plivo & OneSignal
  PI --> Algolia & Typesense
  PI --> AWS_SG & Cloudinary
  PI --> Sentry & NewRelic & ElasticAPM & Mixpanel & Heap & CleverTap & GA
  PI --> ZohoFlow

  PSE --> ZeptoMail & SMTP & RemoveBg
  PSE --> AWS_SG
  PSE --> ZohoDesk

  PE --> CF
```

**Observation:** Printo.in is connected to **30+ external services**. Printose is leaner (5–6). Product Editor is the leanest (essentially just Cloudflare and PIA).
