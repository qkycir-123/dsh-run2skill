[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshSource,
  [string]$ExpectedDshHead = '82a5fd61a7cf5c293cec4bdff68f455398d685e9'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dshPath = (Resolve-Path -LiteralPath $DshSource).Path
$probe = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot 'dsh-rc1-profile') 'probe.mjs')).Path
$id = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$work = Join-Path (Join-Path $repoRoot '.probe-work') "rc1-profile-$id"
$clone = Join-Path $work 'deepseek-harness'
$installLog = Join-Path $work 'pnpm-install.log'
$buildLog = Join-Path $work 'dsh-build.log'

function Assert-DshUnmodified {
  $head = (git -C $dshPath rev-parse HEAD).Trim()
  $status = git -C $dshPath status --porcelain
  if ($head -ne $ExpectedDshHead) { throw "Unexpected DSH HEAD: $head" }
  if ($status) { throw 'DSH source is dirty' }
  Write-Output "DSH_HEAD=$head"
  Write-Output 'DSH_STATUS=clean'
}

Assert-DshUnmodified
Write-Output "CP_INS_ALPHA2_RUN_ID=$id"
New-Item -ItemType Directory -Path $work | Out-Null

Push-Location $repoRoot
try {
  & pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'Candidate package build failed' }
} finally {
  Pop-Location
}

& git -c core.longpaths=true clone --local --no-hardlinks --no-checkout $dshPath $clone
if ($LASTEXITCODE -ne 0) { throw 'Unable to create the disposable DSH clone' }
& git -c core.longpaths=true -C $clone checkout --detach $ExpectedDshHead
if ($LASTEXITCODE -ne 0) { throw 'Unable to pin the disposable DSH clone' }

Push-Location $clone
try {
  & pnpm install --frozen-lockfile *> $installLog
  if ($LASTEXITCODE -ne 0) { throw "DSH dependency install failed; see ignored log for $id" }
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Unix) {
    & pnpm --filter '@deepseek-ai/dsh-web-frontend' exec playwright install chromium *> $installLog
    if ($LASTEXITCODE -ne 0) {
      Get-Content -LiteralPath $installLog -Tail 40
      throw "Chromium install failed; see ignored log for $id"
    }
  }
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & pnpm run build *> $buildLog
    $buildExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedPreference
  }
  if ($buildExitCode -ne 0) { throw "DSH build failed; see ignored log for $id" }
} finally {
  Pop-Location
}

& node $probe $clone $repoRoot (Join-Path $work 'lifecycle')
if ($LASTEXITCODE -ne 0) { throw "Alpha.2 Profile lifecycle probe failed: $LASTEXITCODE" }

Assert-DshUnmodified
Write-Output 'ALPHA2_PROFILE_PROBE=PASS'
