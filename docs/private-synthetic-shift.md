# Private synthetic shift

Use a Windows PowerShell 7 session from the repository root. Build with `npm ci` and `npm run build`, then run:

```powershell
pwsh -NoProfile -File ./scripts/Start-SyntheticDemo.ps1 -StateDirectory <private-state-directory>
```

Use a new state directory outside the checkout or reuse one initialized by this launcher. The launcher binds to `127.0.0.1:3193`, provisions only the fictional roster, and stores the demo passwords encrypted for the current Windows account. Demo mode uses a separate SQLite database and loads neither payment connector. Stop a foreground server with Ctrl+C.

Open `http://127.0.0.1:3193/transactions`. Use different browser profiles or isolated browser sessions for the roles. To copy one synthetic login's password locally, use a second PowerShell session:

```powershell
./scripts/Start-SyntheticDemo.ps1 -StateDirectory <private-state-directory> -CopyPasswordFor maya
```

| Login | Demo role |
| --- | --- |
| `maya` | Harbor Goods cashier A |
| `qa-cashier-b` | Harbor Goods cashier B |
| `jordan` | Harbor Goods primary supervisor |
| `pay-backup` | Harbor Goods backup supervisor |
| `alex` | Ridge Market supervisor |

1. Maya selects **Run demo shift** using `harbor-evening`. **Next event** advances the fictional clock. The first two events are an ordinary Harbor Fuel sale and a Harbor Bar discount.
2. At the $50 event, Maya submits the generated refund request. Jordan opens the primary alert and approves it with his demo password. The **Receipt** shows **Approved / Not submitted**. Alex has no access to the refund or alert.
3. Advance through the remaining refunds. Robin submits the assigned Harbor Fuel event. Maya submits the Harbor Bar event and returns to Harbor Fuel. The last request reaches three unusual refunds for Maya across registers and three for Harbor Fuel's register across cashiers.
4. Advance to the final clock event. If the latest hold is still awaiting a decision, **Simulated supervisor alerts** shows the backup escalation for the backup supervisor. This queue uses the app's alert jobs and duty routing with a demo clock. Phone delivery is outside this demo.
5. **Replay this seed** clears the current run's synthetic refund records and alert jobs and starts its event sequence again. Unrelated records and signed-in roles stay in the private workspace. Use a fresh state directory to start with a different seed.
