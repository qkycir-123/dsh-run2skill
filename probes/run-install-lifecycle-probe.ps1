[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshSource,
  [string]$ExpectedDshHead = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dshPath = (Resolve-Path $DshSource).Path
$probe = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\probe.mjs')).Path
$candidateProbe = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\candidate-probe.mjs')).Path
$fixtures = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\fixtures')).Path
$id = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$work = Join-Path $repoRoot ".probe-work\install-$id"
$clone = Join-Path $work 'deepseek-harness'
$lifecycle = Join-Path $work 'lifecycle'
$candidateLifecycle = Join-Path $work 'candidate-lifecycle'
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
Write-Output "CP_INS_RUN_ID=$id"
New-Item -ItemType Directory -Path $work | Out-Null
Push-Location $repoRoot
try {
  & pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'Candidate package build failed' }
} finally {
  Pop-Location
}
git clone --local --no-hardlinks $dshPath $clone
if ($LASTEXITCODE -ne 0) { throw 'Unable to create the disposable DSH clone' }
git -C $clone checkout --detach $ExpectedDshHead
if ($LASTEXITCODE -ne 0) { throw 'Unable to pin the disposable DSH clone' }

Push-Location $clone
try {
  & pnpm install --frozen-lockfile *> $installLog
  if ($LASTEXITCODE -ne 0) {
    throw "DSH dependency install failed; see the ignored probe log for run $id"
  }
  # Windows PowerShell 5.1 wraps ordinary native stderr records as
  # NativeCommandError when ErrorActionPreference is Stop. DSH's build command
  # echoes its nested npm command on stderr, so capture it without converting a
  # successful native process into a PowerShell terminating error.
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & pnpm run build *> $buildLog
    $buildExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedPreference
  }
  if ($buildExitCode -ne 0) {
    throw "DSH build failed; see the ignored probe log for run $id"
  }
} finally {
  Pop-Location
}

& node $probe $clone $fixtures $lifecycle
if ($LASTEXITCODE -ne 0) { throw "Install lifecycle probe failed: $LASTEXITCODE" }
& node $candidateProbe $clone $repoRoot $candidateLifecycle
if ($LASTEXITCODE -ne 0) { throw "Candidate install lifecycle probe failed: $LASTEXITCODE" }

Assert-DshUnmodified
Write-Output 'INSTALL_LIFECYCLE_PROBE=PASS'
