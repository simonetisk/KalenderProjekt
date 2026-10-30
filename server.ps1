<#
  Enkel webbserver for franvarokalendern. Kraver bara Windows PowerShell (inget att installera).

  Starta:   powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 [-Port 8080] [-LocalOnly]

  Servern levererar index.html/app.js/style.css och laser/skriver data.json i samma mapp
  som skriptet (t.ex. pa natverksdisken). Varje sparning hojer "version" i data.json; en
  sparning som inte bygger pa senaste versionen nekas (409) sa att ingen skriver over nagon annan.
#>
param(
  [int]$Port = 8080,
  [switch]$LocalOnly
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$DataFile = Join-Path $Root 'data.json'
$BackupDir = Join-Path $Root 'backups'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$JsonType = 'application/json; charset=utf-8'
$VersionPattern = '^\s*\{\s*"version"\s*:\s*(\d+)'

$StaticFiles = @{
  '/'           = @('index.html', 'text/html; charset=utf-8')
  '/index.html' = @('index.html', 'text/html; charset=utf-8')
  '/app.js'     = @('app.js', 'application/javascript; charset=utf-8')
  '/style.css'  = @('style.css', 'text/css; charset=utf-8')
}

$script:VersionCache = @{ Stamp = $null; Version = [long]0 }

function Get-DataVersion {
  if (-not (Test-Path -LiteralPath $DataFile)) { return [long]0 }
  $info = Get-Item -LiteralPath $DataFile
  $stamp = "$($info.LastWriteTimeUtc.Ticks)-$($info.Length)"
  if ($stamp -ne $script:VersionCache.Stamp) {
    $text = [IO.File]::ReadAllText($DataFile, $Utf8)
    $version = [long]0
    if ($text -match $VersionPattern) { $version = [long]$Matches[1] }
    $script:VersionCache = @{ Stamp = $stamp; Version = $version }
  }
  return $script:VersionCache.Version
}

function Save-Data([string]$text) {
  if (Test-Path -LiteralPath $DataFile) {
    # En backup per dag (forsta sparningen varje dag).
    if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
    $backup = Join-Path $BackupDir ('data-{0:yyyy-MM-dd}.json' -f (Get-Date))
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $DataFile -Destination $backup }
  }
  $tmp = "$DataFile.tmp"
  [IO.File]::WriteAllText($tmp, $text, $Utf8)
  if (Test-Path -LiteralPath $DataFile) {
    try { [IO.File]::Replace($tmp, $DataFile, $null) }
    catch {
      Copy-Item -LiteralPath $tmp -Destination $DataFile -Force
      Remove-Item -LiteralPath $tmp -Force
    }
  } else {
    [IO.File]::Move($tmp, $DataFile)
  }
}

function Send-Bytes($ctx, [int]$status, [string]$contentType, [byte[]]$bytes) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $contentType
  $res.AddHeader('Cache-Control', 'no-store')
  $res.ContentLength64 = $bytes.Length
  if ($bytes.Length) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.OutputStream.Close()
}

function Send-Text($ctx, [int]$status, [string]$text, [string]$contentType = 'text/plain; charset=utf-8') {
  Send-Bytes $ctx $status $contentType ($Utf8.GetBytes($text))
}

function Invoke-Request($ctx) {
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath
  $method = $req.HttpMethod

  if ($path -eq '/api/version' -and $method -eq 'GET') {
    Send-Text $ctx 200 ('{"version":' + (Get-DataVersion) + '}') $JsonType
    return
  }

  if ($path -eq '/api/data' -and $method -eq 'GET') {
    $bytes = [byte[]]@()
    if (Test-Path -LiteralPath $DataFile) { $bytes = [IO.File]::ReadAllBytes($DataFile) }
    Send-Bytes $ctx 200 $JsonType $bytes
    return
  }

  if ($path -eq '/api/data' -and $method -eq 'PUT') {
    $reader = New-Object IO.StreamReader($req.InputStream, $Utf8)
    $body = $reader.ReadToEnd()
    $reader.Close()
    $current = Get-DataVersion
    $base = [long]0
    if (-not [long]::TryParse($req.QueryString['base'], [ref]$base) -or $base -ne $current) {
      Send-Text $ctx 409 ('{"version":' + $current + '}') $JsonType
      return
    }
    if ($body -notmatch $VersionPattern -or [long]$Matches[1] -ne $current + 1) {
      Send-Text $ctx 400 'Ogiltig data'
      return
    }
    Save-Data $body
    Write-Host ('{0:HH:mm:ss}  sparad version {1}  ({2})' -f (Get-Date), ($current + 1), $req.RemoteEndPoint.Address)
    Send-Text $ctx 200 ('{"version":' + ($current + 1) + '}') $JsonType
    return
  }

  if ($method -eq 'GET' -and $StaticFiles.ContainsKey($path)) {
    $file, $type = $StaticFiles[$path]
    Send-Bytes $ctx 200 $type ([IO.File]::ReadAllBytes((Join-Path $Root $file)))
    return
  }

  Send-Text $ctx 404 'Hittades inte'
}

$listener = New-Object System.Net.HttpListener
$prefix = if ($LocalOnly) { "http://localhost:$Port/" } else { "http://+:$Port/" }
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Kunde inte starta servern pa $prefix" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if (-not $LocalOnly) {
    Write-Host ''
    Write-Host 'For att andra datorer ska na servern behover adressen reserveras EN gang.'
    Write-Host 'Oppna PowerShell som administrator och kor:'
    Write-Host "  netsh http add urlacl url=http://+:$Port/ user=$env:USERDOMAIN\$env:USERNAME" -ForegroundColor Yellow
    Write-Host "  netsh advfirewall firewall add rule name=Franvarokalender dir=in action=allow protocol=TCP localport=$Port" -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Vill du bara testa pa den har datorn: starta med -LocalOnly'
  }
  exit 1
}

$hostName = if ($LocalOnly) { 'localhost' } else { $env:COMPUTERNAME }
Write-Host "Franvarokalendern kors pa http://${hostName}:$Port/" -ForegroundColor Green
Write-Host "Data: $DataFile"
Write-Host 'Stang fonstret eller tryck Ctrl+C for att stoppa.'

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(500)) { }  # vanta i korta steg sa att Ctrl+C fungerar
    $ctx = $task.GetAwaiter().GetResult()
    try {
      Invoke-Request $ctx
    } catch {
      Write-Warning $_.Exception.Message
      try { Send-Text $ctx 500 $_.Exception.Message } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
