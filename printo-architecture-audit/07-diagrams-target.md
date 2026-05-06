# Diagrams — Target State

## 7.1 — Target C4 context

```mermaid
graph TB
  Buyer[Online Buyer]
  WalkIn[Walk-in Customer]
  CorpHR[Corporate HR]
  Recipient[Gift Recipient]
  Ops[Printo Ops Team]
  Cashier[Store Cashier]

  Buyer -->|web| SF[Storefront BFF<br/>Next.js 15]
  CorpHR -->|web| GiftBFF[Gifting BFF<br/>Next.js 15]
  Recipient -->|web| GiftBFF
  Cashier -->|POS UI| ShPOS[Shopify POS<br/>+ Estimator app]
  WalkIn -->|served by| Cashier
  Ops -->|admin| AdminBFF[Admin BFF]
  Buyer -->|personalises| PE[Product Editor<br/>standalone]

  SF -->|GraphQL| Saleor[Saleor commerce engine<br/>Mumbai region]
  GiftBFF -->|REST/GraphQL| Saleor
  ShPOS -->|REST| Saleor
  AdminBFF -->|REST| Saleor
  PE -->|HMAC webhook| SF

  Saleor --> Auth[Auth0 Mumbai]
  Saleor --> Search[Typesense<br/>self-hosted Mumbai]
  Saleor --> CMS[Sanity CMS]
  Saleor --> Cloud[Cloudinary DAM]
  Saleor --> EventBus[SNS + SQS<br/>event bus]

  EventBus --> Inventory[Inventory service]
  EventBus --> Fulfill[Fulfillment service]
  EventBus --> Analytics[RudderStack<br/>→ BigQuery → Metabase]

  Fulfill --> Ship[Shiprocket aggregator]
  Saleor --> RPay[Razorpay primary]
  Saleor --> PayU[PayU fallback]

  Saleor --> Notify[Notifications service]
  Notify --> MSG91[MSG91 SMS]
  Notify --> Gupshup[Gupshup WhatsApp]
  Notify --> SES[AWS SES Mumbai]

  classDef new fill:#d4edda,stroke:#155724
  classDef saas fill:#d1ecf1,stroke:#0c5460
  class SF,GiftBFF,AdminBFF,Saleor,Inventory,Fulfill,Notify,EventBus,PE new
  class ShPOS,Auth,Search,CMS,Cloud,Ship,RPay,PayU,MSG91,Gupshup,SES,Analytics saas
```

## 7.2 — Target container diagram (single-channel detail: Storefront)

```mermaid
graph TB
  Browser

  subgraph EdgeLayer
    CF[Cloudflare]
  end

  subgraph BFFLayer["BFF (channel-specific)"]
    SF[Storefront BFF<br/>Next.js 15 App Router]
  end

  subgraph CommercePlane
    Saleor[Saleor GraphQL API]
    PgSaleor[(Postgres<br/>Saleor schema)]
    SaleorRedis[Redis<br/>Saleor cache + sessions]
  end

  subgraph DomainServices
    Customer[Customer service]
    Inventory[Inventory service]
    Fulfill[Fulfillment service]
    Pricing[Pricing service<br/>RateCard + offers]
  end

  subgraph SharedInfra
    EventBus[SNS + SQS]
    OTel[OTel Collector]
    Auth0
    Secrets[AWS Secrets Manager]
  end

  Browser -->|HTTPS| CF
  CF -->|HTTPS| SF
  SF -->|GraphQL queries/mutations| Saleor
  SF -->|JWT verify| Auth0
  Saleor -->|writes| PgSaleor
  Saleor -->|cache| SaleorRedis
  Saleor -->|publish OrderPlaced, etc.| EventBus
  Saleor -->|read-through| Customer
  Saleor -->|read-through| Inventory
  Saleor -->|on order| Fulfill
  Saleor -->|on PDP| Pricing
  EventBus -->|consumers| Customer & Inventory & Fulfill
  Saleor -->|secrets| Secrets
  Saleor -->|spans/metrics/logs| OTel
```

## 7.3 — Sequence: store-pickup order (target)

```mermaid
sequenceDiagram
  participant U as Buyer
  participant SF as Storefront BFF
  participant S as Saleor
  participant Inv as Inventory svc
  participant R as Razorpay
  participant EB as Event Bus
  participant POS as Shopify POS @ Store
  participant Notify

  U->>SF: place order (store-pickup)
  SF->>S: graphql checkoutCreate
  S->>Inv: reserve qty
  Inv-->>S: reservation_id
  SF->>R: payment
  R->>S: webhook paid
  S->>EB: publish OrderPlaced{store_id, items, ...}
  EB->>POS: subscriber notifies store
  EB->>Notify: subscriber sends "ready for pickup" prep
  POS->>POS: prints pickup slip; prepares
  POS->>EB: publish OrderReadyForPickup
  EB->>Notify: send SMS + WhatsApp to buyer
  Notify->>U: "Your order is ready"
  U->>POS: walks in, picks up
  POS->>S: graphql orderFulfill
  S->>EB: OrderFulfilled
```

**Compare to current trace B in `04-diagrams-current.md`:** no point-to-point Estimator HTTP call; failure modes are recoverable via SQS dead-letter queues; observability is end-to-end via OTel.

## 7.4 — Sequence: walk-in retail (target)

```mermaid
sequenceDiagram
  participant W as Walk-in Customer
  participant Cash as Cashier
  participant POS as Shopify POS<br/>+ Estimator app
  participant S as Saleor
  participant Inv as Inventory svc
  participant GST as GST e-invoice service
  participant Cust as Customer service
  participant EB as Event Bus

  W->>Cash: walks in, requests print
  Cash->>POS: opens Estimator app, enters spec
  POS->>S: graphql priceCalculate
  POS-->>Cash: estimate w/ GST breakup
  W->>Cash: confirms, pays cash/card
  Cash->>POS: marks paid
  POS->>S: graphql checkoutComplete
  S->>Cust: upsert by phone
  S->>Inv: decrement qty
  S->>GST: generate IRN
  GST-->>S: irn + qr
  S->>EB: OrderPlaced{source: 'retail'}
  S-->>POS: receipt + invoice
  POS-->>W: receipt + GST invoice
```

## 7.5 — Sequence: corporate gifting (target — Printose modernised)

```mermaid
sequenceDiagram
  participant HR as Corporate HR
  participant G as Gifting BFF
  participant S as Saleor
  participant Cust as Customer service
  participant Recipient
  participant RC as Recipient client
  participant Pers as Personalisation service<br/>(remove.bg / MediaPipe)
  participant EB as Event Bus
  participant Fulfill as Fulfillment

  HR->>G: create campaign (CSV upload)
  G->>S: bulk create OrderDrafts (one per recipient)
  S->>Cust: bulk upsert Customers
  S->>EB: CampaignCreated
  EB->>Notify: send /g/slug emails

  Recipient->>RC: open /g/slug
  RC->>S: graphql orderDraftRetrieve
  Recipient->>RC: pick products + upload photo
  RC->>Pers: bg removal
  Pers-->>RC: clean image
  RC->>S: graphql orderDraftUpdate
  S->>EB: OrderConfirmed
  EB->>Fulfill: dispatch to courier
  Fulfill->>S: AWB + tracking
```

**Differences from current:** no separate Postgres or Django; no separate UI repo on Next 10; the "campaign" + "recipient" concept lives in Saleor as `OrderDraft` extensions.

## 7.6 — Sequence: personalised product via Product Editor (target — minimal change)

```mermaid
sequenceDiagram
  participant U as Buyer
  participant SF as Storefront BFF
  participant S as Saleor
  participant PE as Product Editor
  participant CW as Celery worker
  participant EB as Event Bus

  U->>SF: open PDP for fridge magnets
  SF->>PE: POST /api/embed/session
  PE-->>SF: {token, expires_at}
  SF-->>U: iframe loads
  U->>PE: composes canvas, "Save & Continue"
  PE->>CW: render_canvas_task (300 DPI)
  CW->>SF: notify_caller_webhook<br/>X-Signature HMAC
  SF->>S: graphql orderItemAttach<br/>{personalisation_ref: job_id}
  S->>EB: OrderItemPersonalised
  EB->>Fulfill: schedule production at correct store
```

**Product Editor is unchanged** — its current contract (HMAC webhook + download URL) maps cleanly into the target.

## 7.7 — Target ER (unified)

See `06-target-architecture.md` §"Unified data model" for the ER diagram. Reproduced here for completeness:

```mermaid
erDiagram
  Customer {
    uuid id PK
    string email
    string phone
    string name
    json profile_attrs
    json consent_record
  }
  Product {
    uuid id PK
    string sku
    bool is_personalisable
  }
  ProductVariant {
    uuid id PK
    uuid product_id FK
    json options
    decimal base_price
  }
  Inventory {
    uuid id PK
    uuid variant_id FK
    string location_id
    int qty_on_hand
    int qty_reserved
  }
  Order {
    uuid id PK
    uuid customer_id FK
    string source
    string status
    string store_location_id
    decimal total
    json gst_invoice_ref
  }
  OrderItem {
    uuid id PK
    uuid order_id FK
    uuid variant_id FK
    int qty
    json personalisation_ref
  }
  Payment {
    uuid id PK
    uuid order_id FK
    string pg
    decimal amount
  }
  Fulfillment {
    uuid id PK
    uuid order_id FK
    string courier
    string awb
  }

  Customer ||--o{ Order : places
  Order ||--o{ OrderItem : contains
  Order ||--o{ Payment : settled-by
  Order ||--o{ Fulfillment : delivered-by
  Product ||--o{ ProductVariant : has
  ProductVariant ||--o{ Inventory : tracked-as
  ProductVariant ||--o{ OrderItem : referenced-by
```
