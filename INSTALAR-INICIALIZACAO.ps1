$ErrorActionPreference = "Stop"

$taskName = "Estoque Disque Copias"
$python = "C:\Users\xerox\AppData\Local\Python\bin\python.exe"
$server = Join-Path $PSScriptRoot "server.py"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python nao encontrado em: $python"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$python' '$server'`"" `
    -WorkingDirectory $PSScriptRoot

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Mantem o sistema interno de estoque disponivel na porta TCP 8090."

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

@"
Tarefa: $taskName
Executavel: $python
Servidor: $server
Inicializacao: ao entrar no Windows
Conta: $currentUser
"@ | Set-Content -LiteralPath "$PSScriptRoot\inicializacao-config-result.txt" -Encoding UTF8
