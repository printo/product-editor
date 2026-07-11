# Appendix — Data Model

Per-system data model. See `04-diagrams-current.md` § 4.10 for the cross-system duplication picture.

## A. Printo.in (MySQL 8)

~203 SQLAlchemy model files in `webapp/inkmonkweb/models/`. Below: the central tables, sized by importance + LOC.

```mermaid
erDiagram
  PlatformUser {
    int id PK
    string email
    string phone
    string name
    bool is_buyer
    bool is_seller
    bool is_ops
    int default_address_id
  }
  Address {
    int id PK
    int user_id FK
    string line_1
    string city
    string state
    string pincode
  }
  CustomizableProduct {
    int id PK
    string name
    string slug
    int seller_id FK
    decimal base_price
    int rate_card_id FK
  }
  Product {
    int id PK
    string sku
    int customizable_product_id FK
    json options
  }
  RateCard {
    int id PK
    int seller_id FK
    json tiers
  }
  Voucher {
    int id PK
    string code
    decimal value
    string type
    timestamp expires_at
  }
  Cart {
    int id PK
    int user_id FK
    string status
    decimal total
  }
  Job {
    int id PK
    int user_id FK
    int customizable_product_id FK
    int customized_layout_id FK
    int cart_id FK
    string status
    int quantity
  }
  CustomizedLayout {
    int id PK
    int job_id FK
    json design_data
    string image_url
  }
  Artwork {
    int id PK
    int job_id FK
    string s3_url
  }
  SellerOrder {
    int id PK
    int cart_id FK
    int seller_id FK
    string status
  }
  Quotation {
    int id PK
    int cart_id FK
    decimal total
  }
  Payment {
    int id PK
    int cart_id FK
    string pg_type "razorpay/payu/paytm/epaylater"
    string status
    decimal amount
    string pg_payment_id
  }
  Consignment {
    int id PK
    int seller_order_id FK
    string courier
    string awb
    string status
  }
  RefundClaim {
    int id PK
    int payment_id FK
    decimal amount
    string status
  }
  RetailOutlet {
    int id PK
    string name
    int address_id FK
    string store_code
  }
  SellerReviewAndRating {
    int id PK
    int seller_id FK
    int user_id FK
    int rating
    string review
  }

  PlatformUser ||--o{ Address : owns
  PlatformUser ||--o{ Cart : owns
  PlatformUser ||--o{ Job : creates
  PlatformUser ||--o{ SellerReviewAndRating : writes
  CustomizableProduct ||--o{ Product : variants
  CustomizableProduct ||--o{ Job : type
  CustomizableProduct }o--|| RateCard : priced-by
  Cart ||--o{ Job : contains
  Cart ||--o{ SellerOrder : split-into
  Cart ||--o{ Payment : paid-by
  Cart ||--|| Quotation : quoted
  Job ||--|| CustomizedLayout : has-design
  Job ||--o{ Artwork : has-files
  SellerOrder ||--o{ Consignment : shipped-as
  Payment ||--o{ RefundClaim : refunded-via
```

**Notable design:**
- `PlatformUser` mixes buyers + sellers + ops in one table. Auth tier decided by boolean flags.
- `Job` is the "printable line item" — heaviest model in the codebase at 1,981 LOC.
- `Payment.pg_type` multiplexes 4 PGs in one column — works but dangerous (no FK to a PG-specific config table).
- `RetailOutlet` exists but appears underused. Inventory is **not modelled** in Printo.in — lives in Estimator.

## B. Printose (Postgres 11)

~152 migrations in `gifting/`. Central models in `apiserver/gifting/models.py`:

```mermaid
erDiagram
  Department {
    int id PK
    string name
    int company_id FK
  }
  CostCenter {
    int id PK
    int department_id FK
    string name
  }
  User {
    int id PK
    string email
    string name
    M2M departments
  }
  GiftCampaign {
    int id PK
    int department_id FK
    string name
    M2M products
    string template
    timestamp expires_at
    string bg_removal_mode
  }
  Product {
    int id PK
    string name
    decimal price
    int parent_product_id FK
  }
  ProductOptions {
    int id PK
    int product_id FK
    string option_name
    json values
  }
  ProductImage {
    int id PK
    int product_id FK
    string image_url
  }
  GiftRecipient {
    int id PK
    int campaign_id FK
    string slug
    string name
    string email
    string phone
    string address
    string state "19-state machine"
    string courier_awb
  }
  SelectedProducts {
    int id PK
    int recipient_id FK
    int product_id FK
    int quantity
  }
  SelectedProductImage {
    int id PK
    int selected_product_id FK
    string uploaded_url
    string bg_removed_url
  }
  Grievance {
    int id PK
    int recipient_id FK
    string description
    string status
  }
  ReversePickup {
    int id PK
    int recipient_id FK
    string status
  }
  ReplacementRequest {
    int id PK
    int recipient_id FK
    int original_product_id FK
    int new_product_id FK
  }
  FeedbackResponse {
    int id PK
    int recipient_id FK
    int rating
    string comments
  }
  Wallet {
    int id PK
    int department_id FK
    decimal balance
  }
  Transaction {
    int id PK
    int wallet_id FK
    decimal amount
    string type "credit/debit"
  }
  Item {
    int id PK
    int transaction_id FK
    decimal gst_percent
    decimal pre_tax_amount
  }
  Invoice {
    int id PK
    int department_id FK
    timestamp invoice_date
    decimal total
  }

  Department ||--o{ CostCenter : has
  Department ||--o{ Wallet : has
  Department }o--o{ User : "M2M"
  Department ||--o{ GiftCampaign : owns
  GiftCampaign ||--o{ GiftRecipient : has
  GiftCampaign }o--o{ Product : "M2M"
  Product ||--o{ ProductOptions : has
  Product ||--o{ ProductImage : has
  Product ||--o{ Product : "parent/child"
  GiftRecipient ||--o{ SelectedProducts : selects
  SelectedProducts ||--o{ SelectedProductImage : uploads
  GiftRecipient ||--o{ Grievance : raises
  GiftRecipient ||--o{ ReversePickup : requests
  GiftRecipient ||--o{ ReplacementRequest : requests
  GiftRecipient ||--o{ FeedbackResponse : gives
  Wallet ||--o{ Transaction : ledger
  Transaction ||--o{ Item : breakdown
  Department ||--o{ Invoice : billed
```

**Notable design:**
- `GiftRecipient` is the unit of fulfillment, not `Order`. State machine has 19 states (`gifting/models.py:284`).
- Heavy business logic in `Model.save()` overrides — `GiftRecipient.save` is 60+ lines, `Transaction.save` mutates `Wallet.balance` directly.
- Recipient slug-based URL means `/g/<slug>` is a public endpoint — anyone with the slug can read the campaign + product list. Acceptable for the gifting use case but worth knowing.

## C. Product Editor (Postgres 16)

7 Django models in `backend/django/api/models.py`. Already documented in `CLAUDE.md`; reproduced here for completeness.

```mermaid
erDiagram
  APIKey {
    uuid id PK
    string key UK
    string name
    bool can_generate_layouts
    bool can_access_exports
    bool is_ops_team
    timestamp last_used_at
  }
  APIRequest {
    uuid id PK
    uuid api_key_id FK
    string method
    string path
    int status_code
    timestamp created_at
  }
  EmbedSession {
    uuid token PK
    uuid api_key_id FK
    string order_id "regex ^[A-Za-z0-9_.\\-]{1,64}$"
    string callback_url "https://"
    timestamp expires_at
    timestamp created_at
  }
  CanvasData {
    uuid id PK
    string order_id
    uuid api_key_id FK
    json editor_state
    string callback_url
    string export_format "png|pdf"
    timestamp updated_at
  }
  UploadedFile {
    uuid id PK
    string upload_session_id
    string file_path
    int file_size
    timestamp created_at
  }
  RenderJob {
    uuid id PK
    uuid api_key_id FK
    string order_id
    string layout_name
    string status "queued|started|completed|failed"
    int retry_count
    timestamp started_at
    timestamp completed_at
  }
  ExportedResult {
    uuid id PK
    uuid render_job_id FK
    string file_path
    int file_size
    bool is_deleted
    timestamp created_at
  }

  APIKey ||--o{ APIRequest : audited
  APIKey ||--o{ EmbedSession : issues
  APIKey ||--o{ CanvasData : owns
  APIKey ||--o{ RenderJob : owns
  CanvasData }o--|| EmbedSession : "(order_id, api_key) unique"
  RenderJob ||--o{ ExportedResult : produces
```

**Notable design:**
- `CanvasData.unique_together = ('order_id', 'api_key')` — tenant isolation by API key.
- `EmbedSession.order_id` is regex-validated server-side; flows into headers, logs, file paths.
- `RenderJob` retries up to 3× via `self.retry()` (not `autoretry_for`).
- `ExportedResult.is_deleted` partial index supports the daily GC sweep.

## D. Estimator (`cs.printo.in`)

`[UNVERIFIED]` — source not in scope. Educated guesses based on integration calls:

- A `Session` table — created by `api_create_session.php` POSTs.
- `order_ref_id` is the foreign key from upstream callers (Printo.in or Printose).
- A `Customer` table — likely matched by phone for walk-in flows.
- An `Order` / `Quote` table — the actual quote line items.
- A `Product` / catalogue table — Estimator's own catalog.
- An `Inventory` table — the only real inventory ledger in the org.
- A `GSTInvoice` / `IRN` table — likely lives here.

Schema cannot be confirmed without source access. See `09-open-questions.md` #1.

## E. PIA (`pia.printo.in`)

`[UNVERIFIED]` — source not in scope. Inferred:

- A `User` table for the Printo employees who authenticate.
- Role / team mapping (`is_ops_team` flag flows into Product Editor's NextAuth session).
- A `DeliveryQueue` table or similar — `request-bulk/delivery/` writes here.

## Cross-system join keys (today: missing)

| Concept | Printo.in | Printose | Product Editor | Estimator |
|---|---|---|---|---|
| Customer | `PlatformUser.id` (int) + email | `User.id` (int) + email | none (PIA-borrowed) | `[UNVERIFIED]` |
| Product | `CustomizableProduct.id` (int) + slug | `Product.id` (int) | none — layouts are not products | `[UNVERIFIED]` |
| Order | `Job.id` + `Cart.id` + `SellerOrder.id` | `GiftRecipient.id` + slug | `RenderJob.id` (uuid) + `order_id` (string from caller) | `Session.order_ref_id` |
| Inventory | not modelled | not modelled | not modelled | `[UNVERIFIED]` — likely the only ledger |

**No system uses UUIDs uniformly. No system shares an integer ID space with another. The only cross-system identifier is the storefront's `order_id` string, which Product Editor honours via header injection but no other system reads.**

## Target unified model (preview)

See `06-target-architecture.md` §"Unified data model" and `07-diagrams-target.md` § 7.7 for the full target ER. Highlights:

- All entities use UUIDs.
- One `Customer` table replaces 3-4.
- One `Product` + `ProductVariant` replaces 3-4.
- One `Inventory` ledger with location dimension.
- One `Order` with `source` enum (`storefront / gifting / retail / embed`) replaces N tables.
- Channel-specific data (gifting `slug`, embed `editor_state`) lives in **per-channel adapter tables** that FK to the unified core. Core stays clean.
