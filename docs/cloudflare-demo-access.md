# ChangeGate Online behind Cloudflare Access

Use this procedure for the isolated Railway demo service. The existing synthetic roster and dedicated demo volume stay attached. ChangeGate Offline does not use Cloudflare. Leave both payment connectors disabled.

## Prepare the hostname

1. Confirm the MIL-controlled Cloudflare zone and DNS ownership. If onboarding a zone, inventory and reconcile its existing website and mail records before the owner makes a nameserver change.
2. Add the approved demo hostname to the Railway demo service. Create the CNAME and ownership TXT shown by Railway and verify the origin certificate. In Cloudflare use a proxied hostname and Full (strict) origin TLS.
3. Create one self-hosted Access application covering the hostname and every path. Allow the presenter's verified identity and named internal test identities only for acceptance. Use a trusted identity provider and an explicit Allow policy. Keep Bypass and service authentication out of this application.
4. Set a hostname-scoped cache rule to bypass caching. Block AI Training, Search, and Agent crawlers for the demo hostname under the existing crawler policy. The app provides a deny-all robots file and a noindex, nofollow, noarchive response header when Access enforcement is active.

## Enable origin verification

Set these variables together only after the hostname and Access application have been prepared.

| Variable | Value |
| --- | --- |
| `CHANGEGATE_TEAM_MODE` | Existing `railway-demo` |
| `CHANGEGATE_ACCESS_MODE` | `required` |
| `CHANGEGATE_ACCESS_HOST` | Exact demo hostname, without scheme or slash |
| `CHANGEGATE_ACCESS_ISSUER` | Access team URL, such as `https://your-team.cloudflareaccess.com` |
| `CHANGEGATE_ACCESS_AUDIENCE` | The Access application's AUD tag |
| `CHANGEGATE_ACCESS_PRESENTER_EMAIL` | Email asserted by the identity provider for the presenter |

Railway's health check stays at `/api/merchant/health`. The origin verifies the exact hostname, the Cloudflare-signed application JWT and its claims on protected requests. Guest passes issued before identity binding require reissue for the new hostname. When preparing the invite, use the recipient's verified Cloudflare sign-in email. During a presenter-led test, sign in at the branded hostname first if the identity provider drops the invite fragment on redirect, then reopen the complete invitation link.

## Verify before external access

- Confirm presenter sign-in and invite administration, then redeem internally using the named identity. Verify the held refund, recorded Square Sandbox result and synthetic pilot scorecard.
- Check access from a different signed-in identity, the original Railway hostname, and an already-open guest tab after the app deadline and early revocation. Use a Cloudflare session that stays valid after the shorter app deadline. Check that guests cannot open presenter routes or merchant APIs.
- Confirm readiness is minimal on Railway, the crawler policy is in effect, and the protected hostname bypasses caching. Redact invite links, separate codes, identities, cookies and assertions from saved evidence. Keep outreach paused until the gate records a verified decision.
