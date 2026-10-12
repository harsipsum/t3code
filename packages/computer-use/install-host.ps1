param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [string]$HomeDir,
  [switch]$SkipRegistration
)
$ErrorActionPreference = 'Stop'
if (-not $HomeDir) {
  $configuredHome = [Environment]::GetEnvironmentVariable('OPEN_HARNESS_CUA_HOME')
  if ($null -eq $configuredHome) { $configuredHome = [Environment]::GetEnvironmentVariable('T3_COMPUTER_USE_HOME') }
  $HomeDir = if ($configuredHome) { $configuredHome } else { Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.t3\computer-use' }
}
$HomeDir = [System.IO.Path]::GetFullPath($HomeDir)
$hostDir = Join-Path $HomeDir 'native-host'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$scriptPath = Join-Path $PSScriptRoot 'src\native-host.mjs'
$manifestPath = Join-Path $hostDir 'dev.t3code.cua.json'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\dev.t3code.cua'
if (-not $SkipRegistration -and (Test-Path -LiteralPath $registryPath)) {
  $existing = (Get-Item -LiteralPath $registryPath).GetValue('')
  if ($existing -ne $manifestPath) { throw 'A different installation already registered this native host. Its registration was preserved.' }
}
New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
function CSharpLiteral([string]$value) { return '@"' + $value.Replace('"','""') + '"' }
$launcherSource = @'
using System;
using System.Diagnostics;
using System.Threading.Tasks;
public static class NativeLauncher {
  static void Pump(System.IO.Stream source, System.IO.Stream destination) {
    var buffer = new byte[8192]; int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) { destination.Write(buffer, 0, count); destination.Flush(); }
  }
  public static int Main() {
    try {
      var child = new Process();
      child.StartInfo = new ProcessStartInfo(NODE, "\"" + SCRIPT + "\" --home \"" + HOME + "\"");
      child.StartInfo.UseShellExecute = false;
      child.StartInfo.CreateNoWindow = true;
      child.StartInfo.RedirectStandardInput = true;
      child.StartInfo.RedirectStandardOutput = true;
      child.StartInfo.RedirectStandardError = true;
      child.Start();
      Task.Run(() => { try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); } catch {} });
      var output = Task.Run(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
      var errors = Task.Run(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
      child.WaitForExit(); Task.WaitAll(output, errors); return child.ExitCode;
    } catch { Console.Error.WriteLine("Open Harness CUA native host could not start."); return 1; }
  }
}
'@
$launcherSource = $launcherSource.Replace('NODE',(CSharpLiteral $nodePath)).Replace('SCRIPT',(CSharpLiteral $scriptPath)).Replace('HOME',(CSharpLiteral $HomeDir))
$sourcePath = Join-Path $hostDir 'launcher.cs'
$executablePath = Join-Path $hostDir 't3-native-host.exe'
[System.IO.File]::WriteAllText($sourcePath,$launcherSource,[System.Text.UTF8Encoding]::new($false))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler is unavailable; native host installation did not change Chrome.' }
& $compiler /nologo /target:exe "/out:$executablePath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Native host launcher compilation failed; Chrome registration was preserved.' }
$manifest = @{name='dev.t3code.cua';description='Open Harness CUA local computer-use bridge';path=$executablePath;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
[System.IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 4),[System.Text.UTF8Encoding]::new($false))
if (-not $SkipRegistration) {
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath
  if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $manifestPath) { throw 'Chrome native host registration read-back failed.' }
}
[pscustomobject]@{host='dev.t3code.cua';extensionId=$ExtensionId;manifestPath=$manifestPath;executablePath=$executablePath;homeDir=$HomeDir;registered=(-not $SkipRegistration)} | ConvertTo-Json
