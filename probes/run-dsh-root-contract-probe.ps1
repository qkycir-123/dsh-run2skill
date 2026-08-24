[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshSource,
  [string]$ExpectedDshHead = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$DshSource = (Resolve-Path -LiteralPath $DshSource).Path

function Invoke-GitCapture {
  param([string[]]$Arguments, [string]$WorkingDirectory)
  $result = & git -C $WorkingDirectory @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $result"
  }
  return ($result | Out-String).Trim()
}

$sourceHeadBefore = Invoke-GitCapture -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $DshSource
$sourceStatusBefore = Invoke-GitCapture -Arguments @('status', '--porcelain') -WorkingDirectory $DshSource
if ($sourceHeadBefore -ne $ExpectedDshHead) {
  throw "Stock DSH HEAD is $sourceHeadBefore; expected $ExpectedDshHead"
}
if ($sourceStatusBefore.Length -ne 0) {
  throw "Stock DSH source is not clean: $sourceStatusBefore"
}

$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$runRoot = Join-Path (Join-Path $projectRoot '.probe-work') "cp-root-003-$runId"
$cloneRoot = Join-Path $runRoot 'deepseek-harness'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

Write-Output "DSH_HEAD=$sourceHeadBefore"
Write-Output 'DSH_STATUS=clean'
Write-Output "NODE_VERSION=$(& node --version)"
Write-Output "PNPM_VERSION=$(& pnpm --version)"
Write-Output "OS_VERSION=$([System.Environment]::OSVersion.VersionString)"
Write-Output "PROBE_RUN_ID=$runId"

& git clone --local --no-hardlinks --no-checkout $DshSource $cloneRoot
if ($LASTEXITCODE -ne 0) { throw 'Failed to create disposable stock DSH clone.' }
& git -C $cloneRoot checkout --detach $ExpectedDshHead
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the pinned stock DSH commit.' }

Push-Location $cloneRoot
try {
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed in the disposable stock DSH clone.' }
  # Preset compositions resolve published package entrypoints. A source clone
  # has no lib/ outputs until the stock host packages are built.
  & pnpm run build:lib:host
  if ($LASTEXITCODE -ne 0) { throw 'Failed to build stock DSH host package entrypoints.' }
} finally {
  Pop-Location
}

$probeRoot = Join-Path $cloneRoot 'packages\run2skill\contract-probes'
$probeTests = Join-Path $probeRoot 'tests'
$probeSupport = Join-Path $probeTests 'support'
New-Item -ItemType Directory -Path $probeSupport -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dsh-contracts\tests\cp-root-003.spec.ts') -Destination $probeTests
foreach ($supportFile in @('learning-fixture.ts', 'memory-run2skill-domain.ts', 'review-fixture.ts', 'work-item-fixture.ts')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "tests\support\$supportFile") -Destination $probeSupport
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination (Join-Path $probeRoot 'src') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dsh-contracts\vitest.config.ts') -Destination (Join-Path $cloneRoot 'run2skill.probe.vitest.config.ts')

Push-Location $cloneRoot
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dsh-contracts\package.json') -Destination (Join-Path $probeRoot 'package.json')
  & pnpm install --no-frozen-lockfile --ignore-scripts --filter '@dsh-run2skill/contract-probes'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to link the disposable stock probe workspace package.' }
  & pnpm exec vitest run --config run2skill.probe.vitest.config.ts
  if ($LASTEXITCODE -ne 0) { throw 'CP-ROOT-003 failed.' }
} finally {
  Pop-Location
}

$sourceHeadAfter = Invoke-GitCapture -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $DshSource
$sourceStatusAfter = Invoke-GitCapture -Arguments @('status', '--porcelain') -WorkingDirectory $DshSource
if ($sourceHeadAfter -ne $sourceHeadBefore -or $sourceStatusAfter -ne $sourceStatusBefore) {
  throw 'The stock DSH source changed while probes were running.'
}

Write-Output 'DSH_SOURCE_AFTER=unchanged'
Write-Output 'CP_ROOT_003=PASS'
