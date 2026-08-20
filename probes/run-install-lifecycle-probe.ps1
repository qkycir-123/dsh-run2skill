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
$packageArchive = Join-Path $work 'package-archive'
$packageExtract = Join-Path $work 'package-extract'
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
  New-Item -ItemType Directory -Path $packageArchive | Out-Null
  & pnpm pack --pack-destination $packageArchive
  if ($LASTEXITCODE -ne 0) { throw 'Candidate package pack failed' }
} finally {
  Pop-Location
}
$tarballs = @(Get-ChildItem -LiteralPath $packageArchive -Filter '*.tgz' -File)
if ($tarballs.Count -ne 1) { throw 'Candidate pack must produce exactly one tarball' }
New-Item -ItemType Directory -Path $packageExtract | Out-Null
& tar -xzf $tarballs[0].FullName -C $packageExtract
if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the candidate tarball' }
$candidatePackage = (Resolve-Path (Join-Path $packageExtract 'package')).Path
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
& node $candidateProbe $clone $candidatePackage $candidateLifecycle
if ($LASTEXITCODE -ne 0) { throw "Candidate install lifecycle probe failed: $LASTEXITCODE" }

Assert-DshUnmodified
Write-Output 'INSTALL_LIFECYCLE_PROBE=PASS'
