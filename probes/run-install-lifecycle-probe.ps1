[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshSource,
  [string]$ExpectedDshHead = '141eb6fef83422698aef7a981029e843e8161534',
  [string]$ReleaseCandidateTarball,
  [string]$ReleaseCandidateSha256
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dshPath = (Resolve-Path $DshSource).Path
$probe = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\probe.mjs')).Path
$candidateProbe = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\candidate-probe.mjs')).Path
$releaseUpgradeProbe = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\release-upgrade-probe.mjs')).Path
$fixtures = (Resolve-Path (Join-Path $PSScriptRoot 'install-lifecycle\fixtures')).Path
$hasReleaseCandidate = -not [string]::IsNullOrWhiteSpace($ReleaseCandidateTarball)
if ($hasReleaseCandidate -ne (-not [string]::IsNullOrWhiteSpace($ReleaseCandidateSha256))) {
  throw 'ReleaseCandidateTarball and ReleaseCandidateSha256 must be provided together'
}
$releaseCandidate = if ($hasReleaseCandidate) { (Resolve-Path $ReleaseCandidateTarball).Path } else { $null }
$id = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$work = Join-Path $repoRoot ".probe-work\install-$id"
$clone = Join-Path $work 'deepseek-harness'
$lifecycle = Join-Path $work 'lifecycle'
$candidateLifecycle = Join-Path $work 'candidate-lifecycle'
$packageArchive = Join-Path $work 'package-archive'
$packageExtract = Join-Path $work 'package-extract'
$installLog = Join-Path $work 'pnpm-install.log'
$buildLog = Join-Path $work 'dsh-build.log'
$previousReleaseArchive = Join-Path $work 'previous-release-archive'
$previousReleasePackLog = Join-Path $work 'previous-release-pack.log'
$releaseUpgrade = Join-Path $work 'release-upgrade'
$uiProbeFixture = Join-Path $work 'run2skill-ui-probe-fixture.json'

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
  & pnpm exec tsx probes/install-lifecycle/build-ui-probe-fixture.ts $uiProbeFixture
  if ($LASTEXITCODE -ne 0) { throw 'Controlled UI probe fixture build failed' }
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
git -c core.longpaths=true clone --local --no-hardlinks $dshPath $clone
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
& node $candidateProbe $clone $candidatePackage $candidateLifecycle $uiProbeFixture
if ($LASTEXITCODE -ne 0) { throw "Candidate install lifecycle probe failed: $LASTEXITCODE" }
if ($hasReleaseCandidate) {
  New-Item -ItemType Directory -Path $previousReleaseArchive | Out-Null
  & npm pack dsh-run2skill@0.1.1-alpha --pack-destination $previousReleaseArchive *> $previousReleasePackLog
  if ($LASTEXITCODE -ne 0) { throw 'Unable to download the published 0.1.1-alpha package' }
  $previousTarballs = @(Get-ChildItem -LiteralPath $previousReleaseArchive -Filter '*.tgz' -File)
  if ($previousTarballs.Count -ne 1) { throw 'Previous release fetch must produce exactly one tarball' }
  & node $releaseUpgradeProbe $clone $previousTarballs[0].FullName $releaseCandidate $releaseUpgrade $ReleaseCandidateSha256
  if ($LASTEXITCODE -ne 0) { throw "Stable release upgrade probe failed: $LASTEXITCODE" }
}

Assert-DshUnmodified
Write-Output 'INSTALL_LIFECYCLE_PROBE=PASS'
