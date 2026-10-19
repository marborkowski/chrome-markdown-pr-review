---
title: Payments service – architecture
owner: platform-team
---

# Payments service architecture

This document describes how the payments service processes card transactions
and how it integrates with the ledger.

## Goals

- Process card payments with p99 latency below 300 ms.
- Keep the ledger as the single source of truth.
- Support retries without double charging.

## Request flow

1. The API gateway validates the request.
2. The payments service creates a `PaymentIntent`.
3. The provider adapter calls the card network.

The adapter is synchronous and blocks the request thread until the provider responds.

## Storage

We use PostgreSQL with a single primary. Read replicas are not used.

| Table | Purpose | Retention |
|-------|---------|-----------|
| payment_intents | Lifecycle of a payment | 7 years |
| provider_events | Raw webhook payloads | 90 days |

## Legacy batch export

A nightly cron job exports settled payments to CSV and uploads them to the finance SFTP server.
This job is owned by the finance team.

## Open questions

- Should refunds go through the same adapter?
