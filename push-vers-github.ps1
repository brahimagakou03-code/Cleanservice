# Pousse le projet vers https://github.com/brahimagakou03-code/Cleanservice
# Trouve Git même s'il n'est pas dans le PATH (installations Windows courantes).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$remoteUrl = "https://github.com/brahimagakou03-code/Cleanservice.git"

function Resolve-GitExecutable {
  $fromPath = Get-Command git -ErrorAction SilentlyContinue
  if ($fromPath -and $fromPath.Source -and (Test-Path -LiteralPath $fromPath.Source)) {
    return $fromPath.Source
  }

  $pf86 = ${env:ProgramFiles(x86)}
  $candidates = @(
    (Join-Path $env:ProgramFiles "Git\cmd\git.exe")
    (Join-Path $env:ProgramFiles "Git\bin\git.exe")
    (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe")
    (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\git.exe")
  )
  if ($pf86) {
    $candidates += @(
      (Join-Path $pf86 "Git\cmd\git.exe")
      (Join-Path $pf86 "Git\bin\git.exe")
    )
  }

  foreach ($p in $candidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }

  try {
    $whereOut = & where.exe git 2>$null
    if ($whereOut) {
      $first = ($whereOut | Select-Object -First 1).ToString().Trim()
      if ($first -and (Test-Path -LiteralPath $first)) { return $first }
    }
  } catch { }

  return $null
}

$script:GitExe = Resolve-GitExecutable
if (-not $script:GitExe) {
  Write-Host ""
  Write-Host "Git est introuvable (PATH + emplacements habituels)." -ForegroundColor Red
  Write-Host "Installez Git pour Windows : https://git-scm.com/download/win" -ForegroundColor Yellow
  Write-Host "Important : cochez « Git from the command line and also from 3rd-party software »." -ForegroundColor Yellow
  Write-Host "Puis fermez et rouvrez PowerShell." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}

# PATH session : outils Git (ssh, credential manager…)
$gitParent = Split-Path -Parent $script:GitExe
$gitRoot = Split-Path -Parent $gitParent
foreach ($dir in @(
    (Join-Path $gitRoot "cmd")
    (Join-Path $gitRoot "bin")
    $gitParent
  )) {
  if ((Test-Path -LiteralPath $dir) -and ($env:PATH -notlike "*${dir}*")) {
    $env:PATH = "$dir;$env:PATH"
  }
}

Write-Host "Git détecté : $($script:GitExe)" -ForegroundColor Green

function Invoke-Git {
  param([Parameter(Mandatory)][string[]]$GitArguments)
  & $script:GitExe @GitArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Échec git (code $LASTEXITCODE) : git $($GitArguments -join ' ')"
  }
}

if (-not (Test-Path ".git")) {
  Invoke-Git @("init")
}

# Renommer la branche par défaut en main (ignore l’erreur si déjà main ou dépôt sans commit)
& $script:GitExe branch -M main 2>$null | Out-Null

& $script:GitExe remote get-url origin 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Invoke-Git @("remote", "set-url", "origin", $remoteUrl)
  Write-Host "Remote 'origin' mis à jour : $remoteUrl"
} else {
  Invoke-Git @("remote", "add", "origin", $remoteUrl)
  Write-Host "Remote 'origin' ajouté : $remoteUrl"
}

Invoke-Git @("add", "-A")
& $script:GitExe status

$changes = & $script:GitExe status --porcelain
if ($changes) {
  try {
    Invoke-Git @("commit", "-m", "Initial commit: plateforme Clean Service (admin + portail client)")
  } catch {
    Write-Host ""
    Write-Host "Le commit a échoué. Configurez votre identité Git puis relancez le script :" -ForegroundColor Yellow
    Write-Host "  & `"$($script:GitExe)`" config --global user.email `"vous@exemple.com`"" -ForegroundColor Gray
    Write-Host "  & `"$($script:GitExe)`" config --global user.name `"Votre Nom`"" -ForegroundColor Gray
    throw
  }
} else {
  Write-Host "Rien à committer (working tree propre)."
}

Write-Host ""
Write-Host "Envoi vers GitHub (branche main)..."
try {
  Invoke-Git @("push", "-u", "origin", "main")
} catch {
  Write-Host ""
  Write-Host "Push refusé ? Vérifiez : compte GitHub, accès au dépôt, et mot de passe = Personal Access Token (HTTPS)." -ForegroundColor Yellow
  Write-Host "https://github.com/settings/tokens" -ForegroundColor Gray
  throw
}

Write-Host ""
Write-Host "Terminé. Dépôt : $remoteUrl" -ForegroundColor Green
