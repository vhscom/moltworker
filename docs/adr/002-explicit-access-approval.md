# ADR-002: Explicit Access Approval

- **Status:** Accepted
- **Date:** 2026-02-04
- **Decision-makers:** @vhscom

## Context and Problem Statement

The upstream E2E test fixture (`test/e2e/fixture/server/create-access-app`) creates a Cloudflare Access application to protect the test worker. By default, it adds an "Allow" policy for `@cloudflare.com` email addresses, which makes sense for Cloudflare's internal testing but grants implicit access to any Cloudflare employee when running E2E tests on a fork.

Should we retain the upstream Access policy or require explicit approval for all users?

## Decision Drivers

- **Security posture**: E2E test deployments should only be accessible to the fork maintainer
- **Defense in depth**: No implicit trust based on email domain
- **Upstream compatibility**: Minimize divergence to ease rebasing

## Considered Options

### Option A: Keep upstream policy

Retain the `@cloudflare.com` email auto-approval in E2E test Access apps.

**Pros:**
- Zero divergence from upstream
- Easier rebasing

**Cons:**
- Cloudflare employees could access E2E test deployments
- Unnecessary access vector for fork maintainers

### Option B: Remove domain-based auto-approval

Comment out the `@cloudflare.com` email policy creation in the E2E fixture.

**Pros:**
- E2E test workers only accessible via service token
- No implicit trust relationships
- Clearer security boundary

**Cons:**
- Diverges from upstream
- Must re-apply after rebasing

## Decision Outcome

**Chosen option: Option B (Remove domain-based auto-approval)**

The E2E fixture `test/e2e/fixture/server/create-access-app` is modified to skip creating the Cloudflare employees policy:

```bash
# [downstream] Disabled - require explicit approval for all access
# Create Allow policy for Cloudflare employees
# echo "Creating Cloudflare employees policy..." >&2
# ...
```

## Consequences

### Positive

- E2E test deployments only accessible via service token (used by automated tests)
- No surprise access from Cloudflare employees during test runs
- Clear security boundary

### Negative

- Must verify this change survives each rebase from upstream
- Manual debugging of E2E tests requires adding your own email to the Access policy

### Neutral

- Does not affect production deployments (those use manually-configured Access apps)
- Cloudflare employees can still be granted access explicitly if desired

## References

- [Cloudflare Access Policies](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [E2E Test README](../../test/e2e/README.md)
