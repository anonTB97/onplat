# ADR 0003 — Tenant isolation by RLS; authority by named capabilities

Status: accepted (milestone 1)

## Context

Two independent boundaries must hold. **Tenant**: a shipbuilder and a navy may
share a hull without sharing a database view of it. **Authority**: within a
tenant, a persona may be allowed to stop work anywhere but not to approve a
permit. These are different problems and conflating them produces a leak or a
paralysed planner.

## Decision

- **Tenant isolation is enforced in the database by row-level security.** Every
  non-reference table has RLS enabled from the first migration. Policies read
  the current tenant from `app.org_id`, set transaction-locally by the API. The
  form used is `NULLIF(current_setting('app.org_id', true), '')::uuid`, so an
  unset or empty tenant resolves to a default-deny rather than erroring open.
  Child tables scope transitively through their parent, so there is one source
  of truth per hull. The application connects as the non-owner role `wadl_app`,
  for which RLS is enforced.
- **Authority is a set of named capabilities**, never a numeric level — a number
  cannot express "may stop work but may not approve". Assignment is per person
  *per vessel*, which is also the RBAC boundary: being in the right tenant is
  necessary but not sufficient; the hull must be one the person is assigned to.
- **RBAC lives in the application layer, not in RLS**, because a policy cannot
  express "may approve but not designate".

## Consequences

The two gates are testable independently. The generated cross-tenant leak test
walks the route inventory and proves, endpoint by endpoint, that one tenant
cannot reach another's hull; the assignment gate is unit-tested in the store.
The RLS policies themselves are validated against PostgreSQL in CI (the
`migrations` job) and were exercised locally as `wadl_app` during development
(tenant A sees only its hull; an unset tenant sees nothing; the audit ledger
refuses UPDATE/DELETE).
