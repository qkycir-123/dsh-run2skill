[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshSource,
  [string[]]$TestFiles = @('session-storage.spec.ts', 'a3-storage.spec.ts', 'llm-skills.spec.ts', 'web.spec.ts')
)

$ErrorActionPreference = 'Stop'
$expectedCommit = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
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

if ($sourceHeadBefore -ne $expectedCommit) {
  throw "DSH HEAD is $sourceHeadBefore; expected $expectedCommit"
}
if ($sourceStatusBefore.Length -ne 0) {
  throw "DSH source is not clean: $sourceStatusBefore"
}
$runId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$probeWorkRoot = Join-Path $projectRoot '.probe-work'
$runRoot = Join-Path $probeWorkRoot $runId
$cloneRoot = Join-Path $runRoot 'deepseek-harness'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

Write-Output "DSH_HEAD=$sourceHeadBefore"
Write-Output 'DSH_STATUS=clean'
Write-Output "NODE_VERSION=$(& node --version)"
Write-Output "PNPM_VERSION=$(& pnpm --version)"
Write-Output "PLATFORM=$([System.Environment]::OSVersion.VersionString)"
Write-Output "PROBE_RUN_ID=$runId"

& git clone --local --no-hardlinks --no-checkout $DshSource $cloneRoot
if ($LASTEXITCODE -ne 0) { throw 'Failed to create disposable DSH clone.' }
& git -C $cloneRoot checkout --detach $expectedCommit
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the pinned DSH commit.' }

$probeDestination = Join-Path $cloneRoot 'packages\run2skill\contract-probes\tests'
New-Item -ItemType Directory -Path $probeDestination -Force | Out-Null
foreach ($testFile in $TestFiles) {
  $sourceTest = Join-Path $PSScriptRoot "dsh-contracts\tests\$testFile"
  if (-not (Test-Path -LiteralPath $sourceTest)) {
    throw "Probe test does not exist: $testFile"
  }
  Copy-Item -LiteralPath $sourceTest -Destination $probeDestination
}
$sourceDestination = Join-Path (Split-Path -Parent $probeDestination) 'src'
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination $sourceDestination -Recurse
$testSupportDestination = Join-Path $probeDestination 'support'
New-Item -ItemType Directory -Path $testSupportDestination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'tests\support\work-item-fixture.ts') -Destination $testSupportDestination
$configSource = Join-Path $PSScriptRoot 'dsh-contracts\vitest.config.ts'
$configDestination = Join-Path $cloneRoot 'run2skill.probe.vitest.config.ts'
Copy-Item -LiteralPath $configSource -Destination $configDestination
$manifestSource = Join-Path $PSScriptRoot 'dsh-contracts\package.json'
$manifestDestination = Join-Path (Split-Path -Parent $probeDestination) 'package.json'

Push-Location $cloneRoot
try {
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed in the disposable DSH clone.' }

  Copy-Item -LiteralPath $manifestSource -Destination $manifestDestination
  & pnpm install --no-frozen-lockfile --ignore-scripts --filter '@dsh-run2skill/contract-probes'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to link the disposable contract-probe workspace package.' }

  & pnpm exec vitest run --config run2skill.probe.vitest.config.ts
  if ($LASTEXITCODE -ne 0) { throw 'Contract probe tests failed.' }
} finally {
  Pop-Location
}

$sourceHeadAfter = Invoke-GitCapture -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $DshSource
$sourceStatusAfter = Invoke-GitCapture -Arguments @('status', '--porcelain') -WorkingDirectory $DshSource
if ($sourceHeadAfter -ne $sourceHeadBefore -or $sourceStatusAfter -ne $sourceStatusBefore) {
  throw 'The protected DSH source changed while probes were running.'
}

Write-Output 'DSH_SOURCE_AFTER=unchanged'
Write-Output 'CONTRACT_PROBES=PASS'
