---
title: Operator guide
---

<p align="center">
  <img src="img/logo.png" width="96" alt="Payments logo">
</p>

# Operator guide

This guide is for the people who run the payments service in production. It
covers setup, day-to-day use, limits and what to do when something breaks.

## Setup

Install the operator CLI with Homebrew and log in with your SSO account before
you run any of the commands below.

## Usage

Run `payctl status` to see the health of every provider adapter at a glance.
The command exits non-zero when any adapter is degraded, so it is safe to use in scripts.

| Provider | Timeout | Retries |
|---|---|---|
| Adyen | 2 s | 3 |
| Stripe | 3 s | 2 |
| Legacy bank | 10 s | 0 |

Retries use exponential backoff with jitter, capped at the provider timeout.

## Limits

Each merchant may create at most 50 refunds per minute. Requests above the limit
are rejected with HTTP 429 and a Retry-After header.

The fee for an instant payout is $0.25 plus 1% of the amount, between $1 and $10.

The expected settlement time is $t = d + 1$ business days, where $d$ is the
provider delay.

$$
fee(a) = 0.25 + 0.01a
$$

## Incidents

When an adapter is degraded for more than five minutes, page the on-call engineer
and post in the incident channel. Do not restart the adapter yourself.

Keep a timeline of what you did and when; it is the most useful input for the review.

## Glossary

Adapter
: The module that translates our payment model to one provider's API.

Settlement
: The moment the provider pays out the money.

## Appendix A

Historical notes about the first version of the service, kept for reference.

The first version ran as a single process and stored everything in one database.

It was split into services in the second year, when traffic grew tenfold.

The migration took three months and was done without downtime.

## Appendix B

Contact the platform team in #payments-platform for access requests.
