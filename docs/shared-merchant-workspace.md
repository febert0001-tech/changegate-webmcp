# Shared merchant workspace

Start the app on loopback with Node 24 or later. Use a private directory outside the checkout for the SQLite database and staff roster. The server reads the roster at startup. There are no preconfigured employees.

Provide an absolute path in each of `CHANGEGATE_TEAM_USERS_FILE` and `CHANGEGATE_TEAM_DB`. The roster is a JSON array. Each entry contains `username` (unique and lowercase), `name`, `merchantId`, `merchantName`, `salt`, and `passwordHash`. Staff at the same merchant share its ID and name. Keep employee usernames stable. To obtain a fresh salt and hash from a masked PowerShell 7 prompt:

```powershell
$caseWorkspacePassword = Read-Host 'Employee password' -MaskInput
$caseWorkspacePassword | node -e "const c=require('node:crypto'); const p=require('node:fs').readFileSync(0,'utf8').replace(/\\r?\\n$/,''); const s=c.randomBytes(16); console.log(JSON.stringify({salt:s.toString('hex'),passwordHash:c.scryptSync(p,s,32).toString('hex')}))"
Remove-Variable caseWorkspacePassword
```

Generate a separate hash per employee and store the resulting JSON roster privately. Use distinct strong passwords. Start with:

```powershell
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3190
```

Open `http://127.0.0.1:3190/merchant`. Sign in as the first employee, open a case, save a finding and next action, and assign it to the second employee. In a separate browser profile, sign in as the assignee, open **Assigned to me**, add a note, and resolve. Restart with the same database and verify the visible history. Sign in under a different merchant to check the empty queue and the first merchant's direct case link.

Sessions expire after eight hours. Sign-out revokes the current session, and an employee removed from the roster or whose password hash changes loses access after the next restart. Case updates and history entries commit together. A stale revision must be refreshed before an edit can be saved. This proof runs on a single loopback host. A networked pilot needs a separate production authentication and hosting decision.
