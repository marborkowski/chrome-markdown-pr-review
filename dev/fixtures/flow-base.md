# Checkout flow

How a checkout request travels through the payments service, and where it can be held.

```mermaid
flowchart TD
  A[Start]
  B[Validate]
  C{Valid?}
  D[Charge card]
  E[Reject]
  F[Old step]
  G[Done]
  A --> B
  B --> C
  C -->|yes| D
  C -->|no| E
  D --> F
  F --> G
  subgraph Fraud
    H[Score intent]
  end
  B --> H
  H --> D
  click A "https://example.com/checkout"
```

## Payment methods

```mermaid
pie title Payment methods
  "Card" : 70
  "Wallet" : 25
  "Bank transfer" : 5
```

## Provider call

```mermaid
sequenceDiagram
  Gateway->>Payments: POST /payments
  Payments->>Adapter: charge
  Adapter-->>Payments: approved
  Payments-->>Gateway: 201 Created
```
