$ErrorActionPreference = "Stop"

$targetProgram = "C:\Users\xerox\AppData\Local\Python\bin\python.exe"
$backgroundProgram = "C:\Users\xerox\AppData\Local\Python\bin\pythonw.exe"
$allowRuleName = "Estoque Disque Copias - TCP 8090"
$backgroundRuleName = "Estoque Disque Copias - TCP 8090 Background"
$removed = 0

$pythonRules = @(Get-NetFirewallRule -DisplayName "python.exe" -ErrorAction SilentlyContinue)
foreach ($rule in $pythonRules) {
    $application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule
    if ($rule.Direction -eq "Inbound" -and
        $rule.Action -eq "Block" -and
        $application.Program -ieq $targetProgram) {
        Remove-NetFirewallRule -Name $rule.Name
        $removed++
    }
}

Get-NetFirewallRule -DisplayName $allowRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

New-NetFirewallRule `
    -DisplayName $allowRuleName `
    -Description "Acesso ao sistema interno de estoque na rede privada." `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8090 `
    -Profile Private `
    -Program $targetProgram | Out-Null

Get-NetFirewallRule -DisplayName $backgroundRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

New-NetFirewallRule `
    -DisplayName $backgroundRuleName `
    -Description "Acesso ao sistema interno de estoque iniciado em segundo plano." `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8090 `
    -Profile Private `
    -Program $backgroundProgram | Out-Null

$rule = Get-NetFirewallRule -DisplayName $allowRuleName
$port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
$application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule

@"
Regras de bloqueio removidas: $removed
Regra criada: $($rule.DisplayName)
Habilitada: $($rule.Enabled)
Direcao: $($rule.Direction)
Acao: $($rule.Action)
Perfil: $($rule.Profile)
Protocolo: $($port.Protocol)
Porta local: $($port.LocalPort)
Programa: $($application.Program)
"@ | Set-Content -LiteralPath "$PSScriptRoot\firewall-config-result.txt" -Encoding UTF8
