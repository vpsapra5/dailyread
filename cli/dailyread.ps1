# =============================================================================
#  DailyRead CLI  -  usage: dailyread <command> [options]
#  Windows PowerShell 5.1, ASCII-only.
# =============================================================================
$Rest = @($args)
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\core.ps1')

$cmd = 'help'
if ($Rest.Count -gt 0) { $cmd = "$($Rest[0])".ToLowerInvariant() }
$Pos = New-Object System.Collections.ArrayList
$Flags = @{}
for ($i = 1; $i -lt $Rest.Count; $i++) {
    $a = "$($Rest[$i])"
    if ($a.StartsWith('--')) {
        $name = $a.Substring(2).ToLowerInvariant()
        if (($i + 1) -lt $Rest.Count -and -not "$($Rest[$i + 1])".StartsWith('--')) { $Flags[$name] = "$($Rest[$i + 1])"; $i++ }
        else { $Flags[$name] = $true }
    } else { [void]$Pos.Add($a) }
}

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Ok([string]$Text)   { Write-Host '  [ok] ' -ForegroundColor Green -NoNewline; Write-Host $Text }
function Warn([string]$Text) { Write-Host '  [!!] ' -ForegroundColor Yellow -NoNewline; Write-Host $Text }
function Fail([string]$Text) { Write-Host "  $Text" -ForegroundColor Red; exit 1 }

function Show-Banner {
    Write-Host ''
    Write-Host '  Daily' -ForegroundColor Yellow -NoNewline
    Write-Host 'Read' -ForegroundColor Magenta -NoNewline
    Write-Host '  - one great book, every day, in 1 hour (60 minutes)' -ForegroundColor DarkGray
    Write-Host ''
}

function Show-BookLine($Book, [string]$Label = 'Today') {
    Write-Host ("  {0,-9}" -f $Label) -ForegroundColor DarkGray -NoNewline
    Write-Host $Book.title -ForegroundColor White -NoNewline
    Write-Host "  by $($Book.author)" -ForegroundColor Gray -NoNewline
    Write-Host "  [$($Book.catName)]" -ForegroundColor DarkCyan
}

function Show-Help {
    Show-Banner
    $rows = @(
        @('start',                         'Start the local app and open it in your browser'),
        @('stop',                          'Stop the local app'),
        @('today [--terminal]',            "Open today's summary (or read it right here in the terminal)"),
        @('set-time HH:mm',                'Set the daily reminder time (e.g. set-time 07:30)'),
        @('set-days Mon,Tue,...',          'Choose which days you get a reminder'),
        @('next',                          "Skip today's book and get another"),
        @('pick "Title"',                  'Choose a specific book for today'),
        @('queue "Title"',                 'Add a book to your up-next queue'),
        @('generate [--days N] [--book id] [--force]', 'Pre-generate summaries (default: today)'),
        @('categories',                    'List subjects and their weights'),
        @('weight <category> <0|0.5|1|2>', 'Off / less / normal / more of a subject'),
        @('history',                       'Your streak, stats and recently finished books'),
        @('archive',                       'View past daily assigned books and completion status'),
        @('add "Title" --author "Name" --category "Finance"', 'Add your own book'),
        @('export [--format md|pdf] [--book id] [--out path]', 'Export a summary'),
        @('set-key YOUR_GEMINI_KEY',       'Save your Gemini API key (free: aistudio.google.com/apikey)'),
        @('mobile [--enable]',             'Show phone access URL and configure Wi-Fi firewall'),
        @('doctor',                        'Check that everything is set up correctly'),
        @('install',                       "Add 'dailyread' to your PATH"),
        @('serve',                         'Run the server in this window (debugging)')
    )
    foreach ($r in $rows) {
        Write-Host ('  dailyread ' ) -ForegroundColor DarkGray -NoNewline
        Write-Host ("{0,-46}" -f $r[0]) -ForegroundColor Cyan -NoNewline
        Write-Host $r[1]
    }
    Write-Host ''
}

function Open-Url([string]$Url) { Start-Process $Url | Out-Null }

function Ensure-Server {
    if (-not (Start-DailyReadServer)) { Fail "Could not start the local server on port $($script:Port). Try: dailyread serve" }
}

function Ensure-Task {
    if (-not (Get-TaskInfo).registered) {
        try { $null = Register-DailyTask } catch { Warn "Could not register the daily reminder: $($_.Exception.Message)" }
    }
}

function Wait-Generate([string]$BookId, [switch]$Force) {
    $book = Get-BookById $BookId
    Write-Host "  Writing summary: " -ForegroundColor DarkGray -NoNewline
    Write-Host $book.title -ForegroundColor White -NoNewline
    Write-Host '  (1-3 min)...' -ForegroundColor DarkGray
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $null = New-Summary -BookId $BookId -Force:$Force
    $meta = Get-SummaryMeta $BookId
    Ok ("Done in {0:N0}s - {1} words via {2}" -f $sw.Elapsed.TotalSeconds, $meta.words, $meta.model)
}

function Write-Wrapped([string]$Text, [string]$Color, [string]$Indent = '  ') {
    $width = 96
    try { $width = [Math]::Min(100, [Console]::WindowWidth - 4) } catch { }
    $words = $Text -split ' '
    $line = $Indent
    $out = New-Object System.Collections.ArrayList
    foreach ($w in $words) {
        if (($line.Length + $w.Length + 1) -gt $width -and $line.Trim()) { [void]$out.Add($line); $line = $Indent + $w }
        elseif ($line.Trim()) { $line += ' ' + $w }
        else { $line += $w }
    }
    [void]$out.Add($line)
    return ,$out
}

function Show-MarkdownInTerminal([string]$Markdown) {
    $lines = New-Object System.Collections.ArrayList
    foreach ($raw in ($Markdown -split "`r?`n")) {
        $l = $raw -replace '\*\*', '' -replace '(?<![\w*])\*(?!\s)([^*]+)\*', '$1'
        if ($l -match '^<details><summary>(.*)</summary>') { [void]$lines.Add(@('  >> ' + $matches[1], 'DarkYellow')); continue }
        if ($l -match '^</?details>|^</?summary>') { continue }
        if ($l -match '^# (.*)')     { [void]$lines.Add(@('', 'Gray')); [void]$lines.Add(@('  ' + $matches[1].ToUpper(), 'Yellow')); continue }
        if ($l -match '^## (.*)')    { [void]$lines.Add(@('', 'Gray')); [void]$lines.Add(@('  == ' + $matches[1] + ' ==', 'Cyan')); continue }
        if ($l -match '^### (.*)')   { [void]$lines.Add(@('  ' + $matches[1], 'Magenta')); continue }
        if ($l -match '^> ?(.*)')    { foreach ($x in (Write-Wrapped $matches[1] 'DarkGray' '    | ')) { [void]$lines.Add(@($x, 'DarkGray')) }; continue }
        if ($l -match '^\s*- \[ \] (.*)') { foreach ($x in (Write-Wrapped ('[ ] ' + $matches[1]) 'Green' '   ')) { [void]$lines.Add(@($x, 'Green')) }; continue }
        if ($l -match '^\s*[-*] (.*)') { foreach ($x in (Write-Wrapped ('* ' + $matches[1]) 'Gray' '   ')) { [void]$lines.Add(@($x, 'Gray')) }; continue }
        if (-not $l.Trim()) { [void]$lines.Add(@('', 'Gray')); continue }
        foreach ($x in (Write-Wrapped $l 'Gray')) { [void]$lines.Add(@($x, 'Gray')) }
    }
    $page = 30
    try { $page = [Math]::Max(10, [Console]::WindowHeight - 2) } catch { }
    $n = 0
    foreach ($ln in $lines) {
        Write-Host $ln[0] -ForegroundColor $ln[1]
        $n++
        if ($n -ge $page) {
            Write-Host '  -- Enter: next page | q: quit --' -ForegroundColor DarkGray -NoNewline
            try { $k = [Console]::ReadKey($true) } catch { $k = $null }
            Write-Host "`r                                       `r" -NoNewline
            if ($k -and $k.KeyChar -eq 'q') { return }
            $n = 0
        }
    }
}

switch ($cmd) {
    'help'   { Show-Help }
    '--help' { Show-Help }
    '-h'     { Show-Help }

    'install' {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not $userPath) { $userPath = '' }
        if (($userPath -split ';') -contains $script:Root) { Ok "'dailyread' is already on your PATH." }
        else {
            [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $script:Root), 'User')
            Ok "Added $($script:Root) to your PATH. Open a NEW terminal, then run: dailyread start"
        }
        Ensure-Task
    }

    'serve' { & $script:ServerPath }

    'start' {
        Show-Banner
        Ensure-Server
        Ensure-Task
        $entry = Get-DayEntry
        $b = Get-BookById $entry.bookId
        Show-BookLine $b
        if (-not (Test-HasApiKey)) { Warn "No Gemini API key yet - add it in Settings or run: dailyread set-key YOUR_KEY" }
        Ok "App running at $($script:BaseUrl)"
        Open-Url "$($script:BaseUrl)/#/today"
    }

    'stop' {
        if (Stop-DailyReadServer) { Ok 'DailyRead stopped.' } else { Say '  DailyRead was not running.' }
    }

    'today' {
        $entry = Get-DayEntry
        $b = Get-BookById $entry.bookId
        if ($Flags.terminal) {
            if (-not (Get-SummaryStatus $b.id).generated) {
                try { Wait-Generate $b.id } catch { Fail $_.Exception.Message }
            }
            Show-MarkdownInTerminal (Read-TextFile (Get-SummaryPath $b.id))
            Write-Host ''
            $ans = Read-Host '  Mark as finished? (y/N)'
            if ($ans -match '^[yY]') { Complete-Book $b.id ([int](Get-Settings).summaryMinutes); Ok "Finished! Streak: $((Get-Stats).streak) day(s)" }
        } else {
            Show-Banner
            Show-BookLine $b
            Ensure-Server
            Open-Url "$($script:BaseUrl)/#/read/$($b.id)"
        }
    }

    'set-time' {
        $t = "$($Pos[0])"
        if ($t -match '^(\d{1,2}):(\d{2})$') { $t = '{0:D2}:{1}' -f [int]$matches[1], $matches[2] }
        if ($t -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { Fail 'Usage: dailyread set-time HH:mm   (24-hour, e.g. 07:30 or 21:00)' }
        $s = Get-Settings; $s.notifyTime = $t; Save-Settings $s
        try { $info = Register-DailyTask } catch { Fail "Could not register the reminder: $($_.Exception.Message)" }
        Ok "Daily reminder set for $t on $(@($s.days) -join ', ')."
        if ($info.nextRun) { Ok ("Next reminder: {0:dddd, MMM d 'at' h:mm tt}" -f [datetime]$info.nextRun) }
    }

    'set-days' {
        $valid = @('Mon','Tue','Wed','Thu','Fri','Sat','Sun')
        $want = New-Object System.Collections.ArrayList
        foreach ($d in (("$($Pos -join ',')") -split '[,\s]+')) {
            if (-not $d) { continue }
            $cap = $d.Substring(0, [Math]::Min(3, $d.Length))
            $cap = $cap.Substring(0,1).ToUpper() + $cap.Substring(1).ToLower()
            if ($valid -contains $cap -and $want -notcontains $cap) { [void]$want.Add($cap) }
        }
        if ($want.Count -eq 0) { Fail 'Usage: dailyread set-days Mon,Tue,Wed,Thu,Fri' }
        $s = Get-Settings; $s.days = $want; Save-Settings $s
        $null = Register-DailyTask
        Ok "Reminders on: $($want -join ', ') at $($s.notifyTime)"
    }

    'next' {
        $b = Skip-Day
        Show-BookLine $b 'New pick'
        if (Test-HasApiKey) { Start-BackgroundGenerate $b.id; Say '  Summary is being written in the background.' 'DarkGray' }
    }

    'pick' {
        $q = ($Pos -join ' ')
        if (-not $q) { Fail 'Usage: dailyread pick "Book title"' }
        $b = Find-Book $q
        if (-not $b) { Fail "No book matching '$q'. Add it with: dailyread add `"$q`" --author `"Name`" --category `"Philosophy`"" }
        $null = Set-DayBook $b.id
        Show-BookLine $b
        if (Test-HasApiKey) { Start-BackgroundGenerate $b.id; Say '  Summary is being written in the background.' 'DarkGray' }
    }

    'queue' {
        $q = ($Pos -join ' ')
        if (-not $q) {
            $h = Get-History
            if ($h.queue.Count -eq 0) { Say '  Your queue is empty.' } else { $i = 1; foreach ($id in $h.queue) { $b = Get-BookById $id; if ($b) { Show-BookLine $b "#$i"; $i++ } } }
            break
        }
        $b = Find-Book $q
        if (-not $b) { Fail "No book matching '$q'." }
        $null = Set-Queue $b.id 'add'
        Ok "Queued: $($b.title)"
    }

    'generate' {
        if (-not (Test-HasApiKey)) { Fail 'No Gemini API key. Run: dailyread set-key YOUR_KEY' }
        if ($Flags.book) {
            try { Wait-Generate $Flags.book -Force:([bool]$Flags.force) } catch { Fail $_.Exception.Message }
            break
        }
        $days = 1
        if ($Flags.days) { $days = [Math]::Max(1, [int]$Flags.days) }
        if ($days -gt 8) { Warn 'Each summary uses 2 API calls; the free Gemini tier allows ~20 calls/day per model.' }
        for ($d = 0; $d -lt $days; $d++) {
            $key = Get-DateKey ((Get-Date).AddDays($d))
            $entry = Get-DayEntry $key
            $b = Get-BookById $entry.bookId
            Show-BookLine $b $key
            if ((Get-SummaryStatus $b.id).generated -and -not $Flags.force) { Ok 'Already cached'; continue }
            try { Wait-Generate $b.id -Force:([bool]$Flags.force) } catch { Warn $_.Exception.Message }
        }
    }

    'categories' {
        $s = Get-Settings
        $books = Get-AllBooks
        $label = @{ '0' = 'off'; '0.5' = 'less'; '1' = 'normal'; '2' = 'more' }
        Show-Banner
        foreach ($c in (Get-Categories)) {
            $w = Get-CategoryWeight $s $c.id
            $n = @($books | Where-Object { $_.cat -eq $c.id }).Count
            $wl = $label["$w"]; if (-not $wl) { $wl = "$w" }
            $color = 'Gray'; if ($w -eq 0) { $color = 'DarkGray' } elseif ($w -gt 1) { $color = 'Green' }
            Write-Host ("  {0,-14}" -f $c.id) -ForegroundColor Cyan -NoNewline
            Write-Host ("{0,-42}" -f $c.name) -ForegroundColor $color -NoNewline
            Write-Host ("{0,3} books   {1}" -f $n, $wl) -ForegroundColor DarkGray
        }
        Write-Host ''
        Say '  Change with: dailyread weight scifi 2   (0 = off, 0.5 = less, 1 = normal, 2 = more)' 'DarkGray'
    }

    'weight' {
        if ($Pos.Count -lt 2) { Fail 'Usage: dailyread weight <category> <0|0.5|1|2>' }
        $c = Find-Category $Pos[0]
        if (-not $c) { Fail "Unknown category '$($Pos[0])'. See: dailyread categories" }
        $w = [double]::Parse($Pos[1], [Globalization.CultureInfo]::InvariantCulture)
        $s = Get-Settings; $s.weights[$c.id] = $w; Save-Settings $s
        Ok "$($c.name) weight set to $w"
    }

    'history' {
        $st = Get-Stats
        Show-Banner
        Write-Host ("  Streak      {0} day(s)   (best {1})" -f $st.streak, $st.bestStreak) -ForegroundColor Yellow
        Write-Host ("  Finished    {0} of {1} books" -f $st.finished, $st.totalBooks)
        Write-Host ("  Time read   {0:N1} hours" -f ($st.minutes / 60.0))
        Write-Host ''
        if ($st.recent.Count -eq 0) { Say '  Nothing finished yet - start with: dailyread today' 'DarkGray' }
        foreach ($r in $st.recent) { Show-BookLine $r.book $r.date }
        Write-Host ''
    }

    'archive' {
        Show-Banner
        $h = Get-History
        $todayKey = Get-DateKey
        Say '  DailyRead Archive & Past Days' 'Yellow'
        Write-Host ''
        $keys = @($h.days.Keys | Sort-Object -Descending)
        if ($keys.Count -eq 0) { Say '  No daily entries recorded yet.' 'DarkGray' }
        foreach ($k in $keys) {
            $d = $h.days[$k]
            $b = Get-BookById $d.bookId
            if (-not $b) { continue }
            $isFin = $h.finished.ContainsKey($b.id)
            $finMark = $(if ($isFin) { '[DONE]' } else { '[OPEN]' })
            $col = $(if ($isFin) { 'Green' } else { 'Yellow' })
            $todayTag = $(if ($k -eq $todayKey) { ' (Today)' } else { '' })
            Write-Host ("  {0} " -f $finMark) -ForegroundColor $col -NoNewline
            Write-Host ("{0,-12}" -f "$k$todayTag") -ForegroundColor DarkGray -NoNewline
            Write-Host (" {0}" -f $b.title) -ForegroundColor White -NoNewline
            Write-Host (" by {0}" -f $b.author) -ForegroundColor Gray -NoNewline
            Write-Host (" [{0}]" -f $b.catName) -ForegroundColor DarkCyan
        }
        Write-Host ''
    }

    'add' {
        $title = ($Pos -join ' ')
        if (-not $title -or -not $Flags.category) { Fail 'Usage: dailyread add "Title" --author "Name" --category "Finance"' }
        try { $b = Add-CustomBook $title "$($Flags.author)" "$($Flags.category)" } catch { Fail $_.Exception.Message }
        Ok "Added: $($b.title) by $($b.author) [$($b.catName)]"
        Say "  Read it today: dailyread pick `"$($b.title)`"" 'DarkGray'
    }

    'export' {
        $id = $Flags.book
        if (-not $id) { $id = (Get-DayEntry).bookId }
        $b = Get-BookById $id
        if (-not $b) { Fail "Unknown book id '$id'." }
        $src = Get-SummaryPath $id
        if (-not (Test-Path $src)) { Fail "No summary for '$($b.title)' yet. Run: dailyread generate --book $id" }
        $format = 'md'; if ($Flags.format) { $format = "$($Flags.format)".ToLower() }
        $outDir = Join-Path $script:Root 'exports'
        if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
        $out = $Flags.out
        if (-not $out) { $out = Join-Path $outDir "$id.$format" }
        if ($format -eq 'md') { Copy-Item $src $out -Force; Ok "Exported: $out" }
        elseif ($format -eq 'pdf') {
            Ensure-Server
            $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
            if (-not $edge) { Fail 'Microsoft Edge not found (needed for PDF export). Use --format md instead.' }
            $full = [IO.Path]::GetFullPath($out)
            $p = Start-Process -FilePath $edge -ArgumentList @('--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=15000', "--print-to-pdf=`"$full`"", "`"$($script:BaseUrl)/print.html?id=$id`"") -Wait -PassThru -WindowStyle Hidden
            if (Test-Path $full) { Ok "Exported: $full" } else { Fail 'PDF export failed.' }
        } else { Fail 'Format must be md or pdf.' }
    }

    'set-key' {
        $k = "$($Pos[0])"
        if (-not $k) { Fail 'Usage: dailyread set-key YOUR_GEMINI_KEY   (get one free at https://aistudio.google.com/apikey)' }
        Set-ApiKey $k
        Ok 'Gemini API key saved to .env'
    }

    'test-email' {
        Show-Banner
        $entry = Get-DayEntry
        $b = Get-BookById $entry.bookId
        $target = if ($Pos.Count -gt 0) { $Pos[0] } else { '' }
        Say "  Sending test email for: $($b.title)..." 'DarkGray'
        try {
            $res = Send-DailyEmail -Book $b -TargetEmail $target
            Ok "Email sent successfully to $($res.to) via $($res.method)!"
        } catch {
            Fail $_.Exception.Message
        }
    }

    'notify' { Invoke-DailyNotify }

    'doctor' {
        Show-Banner
        Ok ("PowerShell {0}" -f $PSVersionTable.PSVersion)
        if (Test-Path $script:DataDir) { Ok "Data folder: $($script:DataDir)" } else { Warn 'Data folder missing' }
        Ok ("Library: {0} books in {1} subjects" -f (Get-AllBooks).Count, (Get-Categories).Count)
        if (Test-HasApiKey) {
            Ok 'Gemini API key found'
            try {
                $key = (Get-EnvConfig).GEMINI_API_KEY
                $null = Invoke-WebRequest -Uri 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1' -Headers @{ 'x-goog-api-key' = $key } -UseBasicParsing -TimeoutSec 15
                Ok 'Gemini API key is valid'
            } catch { Warn "Gemini API check failed: $($_.Exception.Message)" }
        } else { Warn 'No Gemini API key. Run: dailyread set-key YOUR_KEY  (free: https://aistudio.google.com/apikey)' }
        $t = Get-TaskInfo
        $s = Get-Settings
        if ($t.registered) {
            $nr = ''; if ($t.nextRun) { $nr = " - next: {0:ddd MMM d, h:mm tt}" -f [datetime]$t.nextRun }
            Ok "Daily reminder scheduled at $($s.notifyTime) ($($t.state))$nr"
        } else { Warn "Daily reminder not scheduled. Run: dailyread set-time 21:00" }
        if ($s.email -and $s.email.enabled) {
            $hasPass = [bool]($s.email.appPassword -or (Get-EnvConfig).GMAIL_APP_PASSWORD -or $s.email.resendApiKey)
            if ($hasPass) { Ok "Daily email active for $($s.email.targetEmail) at $($s.notifyTime)" }
            else { Warn "Daily email configured for $($s.email.targetEmail) (Waiting for 16-letter App Password in Settings)" }
        }
        if (Test-ServerRunning) { Ok "Server running at $($script:BaseUrl)" } else { Warn "Server not running (start with: dailyread start)" }
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath -and (($userPath -split ';') -contains $script:Root)) { Ok "'dailyread' is on your PATH" } else { Warn "'dailyread' not on PATH yet. Run: .\dailyread install" }
        Write-Host ''
    }

    'mobile' {
        Show-Banner
        $ip = Get-LocalIp
        $phoneUrl = 'http://' + $ip + ':' + $script:Port
        Say '  [Mobile] DailyRead Phone & Tablet Access' 'Yellow'
        Write-Host ''
        Write-Host '  1. Connect your phone to the same Wi-Fi network as this PC.' -ForegroundColor White
        Write-Host '  2. Open Safari (iOS) or Chrome (Android) and go to:' -ForegroundColor White
        Write-Host "     $phoneUrl" -ForegroundColor Cyan
        Write-Host ''
        Write-Host '  3. For the native app feel (Kindle reader without browser bars):' -ForegroundColor White
        Write-Host '     * iOS Safari: Tap Share button -> tap Add to Home Screen' -ForegroundColor Gray
        Write-Host '     * Android: Tap the 3 dots menu -> tap Add to Home screen' -ForegroundColor Gray
        Write-Host ''

        if ($Flags.enable) {
            Say '  Launching Windows Administrator prompt to enable phone Wi-Fi access...' 'Yellow'
            $scriptText = 'netsh http delete urlacl url=http://+:' + $script:Port + '/ 2>$null; netsh http add urlacl url=http://+:' + $script:Port + '/ user=Everyone; netsh advfirewall firewall delete rule name="DailyRead" 2>$null; netsh advfirewall firewall add rule name="DailyRead" dir=in action=allow protocol=TCP localport=' + $script:Port + ' profile=any; Write-Host ""; Write-Host "DailyRead Wi-Fi access successfully enabled!" -ForegroundColor Green; Write-Host "You can now close this window."; Start-Sleep -Seconds 3'
            Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-Command', $scriptText)
            Ok "Administrator prompt launched on your screen. Click 'Yes' to authorize."
            Say "  After clicking Yes, restart the server with:" 'DarkGray'
            Write-Host "     dailyread stop; dailyread start" -ForegroundColor Cyan
        } else {
            Say "  If your phone cannot load the page, Windows Firewall may be blocking port $($script:Port)." 'DarkGray'
            Say "  To automatically enable phone access, run:" 'DarkGray'
            Write-Host "     dailyread mobile --enable" -ForegroundColor Green
            Write-Host ''
            Say "  To read away from home (on cellular data/5G outside Wi-Fi):" 'DarkGray'
            Write-Host "     npx localtunnel --port $($script:Port)" -ForegroundColor Magenta
        }
        Write-Host ''
    }

    default { Warn "Unknown command '$cmd'"; Show-Help; exit 1 }
}
