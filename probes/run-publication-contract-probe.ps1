[CmdletBinding()]
param(
  [string]$WslDistribution = ''
)

$ErrorActionPreference = 'Stop'
$spec = (Resolve-Path (Join-Path $PSScriptRoot 'publication-cas\probe.spec.mjs')).Path

Write-Output "WINDOWS_NODE=$(node --version)"
Write-Output "WINDOWS_PLATFORM=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
& node --test $spec
if ($LASTEXITCODE -ne 0) { throw "Windows publication probe failed: $LASTEXITCODE" }

$portableSpec = $spec -replace '\\', '/'
$wslArgs = @()
$distroLabel = 'default'
if (-not [string]::IsNullOrWhiteSpace($WslDistribution)) {
  $wslArgs = @('-d', $WslDistribution)
  $distroLabel = $WslDistribution
}
$wslPathOutput = & wsl.exe @wslArgs -- wslpath -u $portableSpec
if ($LASTEXITCODE -ne 0 -or -not $wslPathOutput) { throw 'Unable to resolve the WSL probe path' }
$wslSpec = ($wslPathOutput | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslSpec) { throw 'Unable to resolve the WSL probe path' }
$wslNode = (& wsl.exe @wslArgs -- node --version).Trim()
$wslKernel = (& wsl.exe @wslArgs -- uname -srmo).Trim()
Write-Output "LINUX_DISTRO=$distroLabel"
Write-Output "LINUX_NODE=$wslNode"
Write-Output "LINUX_PLATFORM=$wslKernel"
& wsl.exe @wslArgs -- node --test $wslSpec
if ($LASTEXITCODE -ne 0) { throw "Linux publication probe failed: $LASTEXITCODE" }

Write-Output 'CP_PUB_001=PASS'
