param(
  [Parameter(Mandatory)][string]$StateDirectory,
  [ValidateRange(1024,65535)][int]$Port = 3193,
  [ValidateSet('maya','qa-cashier-b','jordan','pay-backup','alex')][string]$CopyPasswordFor
)

$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path $PSScriptRoot
$demoState = [IO.Path]::GetFullPath($StateDirectory)
$demoRoster = Join-Path $demoState 'staff.json'
$demoPasswords = Join-Path $demoState 'staff-passwords.xml'

if ($CopyPasswordFor) {
  $demoSaved = Import-Clixml -LiteralPath $demoPasswords
  $demoSecret = $demoSaved[$CopyPasswordFor]
  if ($null -eq $demoSecret) { throw 'No password was saved for this demo login.' }
  Set-Clipboard -Value ([Net.NetworkCredential]::new('', $demoSecret).Password)
  return
}

if (-not (Test-Path -LiteralPath (Join-Path $demoRoot '.next/BUILD_ID'))) {
  throw 'Build the application with npm run build before starting the private demo.'
}
if (-not (Test-Path -LiteralPath $demoState)) {
  New-Item -ItemType Directory -Path $demoState | Out-Null
  $demoSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $demoState /inheritance:r /grant:r "*${demoSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the demo directory.' }
  $demoProvision = @'
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [accountsPath, rosterPath] = process.argv.slice(1);
const accounts = JSON.parse(readFileSync(accountsPath, "utf8"));
const passwords = {};
const roster = accounts.map(account => {
  const salt = randomBytes(16);
  const password = randomBytes(24).toString("hex");
  passwords[account.username] = password;
  return { ...account, salt: salt.toString("hex"), passwordHash: scryptSync(password, salt, 32).toString("hex") };
});
writeFileSync(rosterPath, JSON.stringify(roster), { flag: "wx" });
process.stdout.write(JSON.stringify(passwords));
'@
  $demoFixture = Join-Path $demoRoot 'src/merchant-team/demo-accounts.json'
  $demoGenerated = & node --input-type=module -e $demoProvision $demoFixture $demoRoster
  if ($LASTEXITCODE -ne 0) { throw 'Could not provision the synthetic demo roster.' }
  $demoSecure = @{}
  foreach ($demoAccount in ($demoGenerated | ConvertFrom-Json -AsHashtable).GetEnumerator()) {
    $demoSecure[$demoAccount.Key] = ConvertTo-SecureString -String $demoAccount.Value -AsPlainText -Force
  }
  $demoSecure | Export-Clixml -LiteralPath $demoPasswords
  Remove-Variable demoGenerated,demoSecure,demoAccount
}
if (-not ((Test-Path -LiteralPath $demoRoster -PathType Leaf) -and (Test-Path -LiteralPath $demoPasswords -PathType Leaf))) {
  throw 'Choose a new private state directory or pass the directory previously initialized by this launcher.'
}

$env:CHANGEGATE_TEAM_MODE = 'demo'
$env:CHANGEGATE_TEAM_ORIGIN = "http://127.0.0.1:$Port"
$env:CHANGEGATE_TEAM_DB = Join-Path $demoState 'synthetic-demo.sqlite'
$env:CHANGEGATE_TEAM_USERS_FILE = $demoRoster
Push-Location $demoRoot
try { & node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port $Port }
finally { Pop-Location }
exit $LASTEXITCODE
