# Private merchant staging

Use a dedicated Railway project or staging environment with one Linux service in one region. Connect only the staging branch. Attach one persistent volume at **/data**. The container refuses to start when the volume is absent and drops to the image's non-root user before starting Next.js. Keep the volume when replacing or redeploying the container.

Generate a Railway HTTPS domain for the service. Set `CHANGEGATE_TEAM_ORIGIN` to its exact HTTPS origin with no trailing slash. Set `CHANGEGATE_TEAM_ROSTER_JSON` as a sealed service variable using the staff roster shape in [Shared merchant workspace](shared-merchant-workspace.md). Provision one distinct strong password per named employee and store only the salted hashes in the roster. Keep passwords in the approved private channel. Use **/api/merchant/health** as the Railway health check and expose the application through Railway's HTTPS edge only. Use **/merchant** for employee sign-in.

The staging container serves the authenticated merchant workspace and enforces the configured origin. Case and roster data are available only to signed-in employees at the same merchant. Session cookies are host-only, Secure, HttpOnly, and SameSite Strict. Sign-in attempts are rate limited using Railway's client IP header. The existing Vercel release uses the default build, and the branch has an automatic deployment opt-out.

Run the container and persistence test with `docker build -t changegate-staging:test .` followed by `node scripts/check-merchant-staging.mjs changegate-staging:test`. That test uses an isolated disposable Docker volume and an HTTPS edge fixture. Hosted acceptance is a separate run with independently signed-in staff, a redacted case, container replacement on the same volume, and a second-merchant access check.

For staging acceptance, the optional sealed `CHANGEGATE_TEAM_ACCEPTANCE_ROSTER_JSON` service variable adds synthetic test employees to the existing staff roster. Use distinct usernames and synthetic merchant IDs. Clear the variable and redeploy after the acceptance check to revoke those sessions.


For a supervised register demo, set `role` on the enrolled staff records. Use `cashier`, `manager`, or `owner`. Give each participating merchant at least one named manager or owner and keep role-less legacy roster members as cashiers. The signed-in transaction page reports a missing supervisor.

Phone alerts need persistent staging Web Push signing keys in `CHANGEGATE_PUSH_PUBLIC_KEY` and `CHANGEGATE_PUSH_PRIVATE_KEY`, with `CHANGEGATE_PUSH_SUBJECT` set to the staging HTTPS URL. Reviewers enroll a device for a 12-hour primary or backup duty period and choose its location. The default backup deadline is 120 seconds. Override `CHANGEGATE_ALERT_ESCALATION_SECONDS` only for a scoped test. Push acceptance records the push provider response, not a phone receipt or a human decision. The optional `CHANGEGATE_MONITOR_AI_KEY` and `CHANGEGATE_MONITOR_AI_MODEL` activate numeric-only AI advisory calls after separate provider authorization.
