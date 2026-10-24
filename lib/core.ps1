# =============================================================================
#  DailyRead - core library
#  Windows PowerShell 5.1 compatible. Keep this file ASCII-only (PS 5.1 reads
#  BOM-less scripts as ANSI).
# =============================================================================

$script:Root        = Split-Path $PSScriptRoot -Parent
$script:DataDir     = Join-Path $script:Root 'data'
$script:SummaryDir  = Join-Path $script:DataDir 'summaries'
$script:CatalogDir  = Join-Path $script:Root 'catalog'
$script:PublicDir   = Join-Path $script:Root 'public'
$script:CliPath     = Join-Path $script:Root 'cli\dailyread.ps1'
$script:ServerPath  = Join-Path $script:Root 'server\server.ps1'
$script:SettingsPath   = Join-Path $script:DataDir 'settings.json'
$script:HistoryPath    = Join-Path $script:DataDir 'history.json'
$script:HighlightsPath = Join-Path $script:DataDir 'highlights.json'
$script:CustomBooksPath= Join-Path $script:DataDir 'custom_books.json'
$script:PidPath        = Join-Path $script:DataDir 'server.pid'
$script:Port        = 4747
$script:BaseUrl     = "http://localhost:4747"
$script:TaskName    = 'DailyRead Daily Reminder'
$script:Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)
$script:ToastAppId  = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function Get-LocalIp {
    try {
        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | 
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | 
            Select-Object -ExpandProperty IPAddress
        if ($ips) {
            foreach ($ip in $ips) {
                if ($ip -like '192.168.*' -or $ip -like '10.*' -or $ip -like '172.*') { return $ip }
            }
            return $ips[0]
        }
    } catch { }
    return '127.0.0.1'
}

$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

foreach ($d in @($script:DataDir, $script:SummaryDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ----------------------------------------------------------------------------- 
#  File + JSON helpers
# -----------------------------------------------------------------------------
function Read-TextFile([string]$Path) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
function Write-TextFile([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom) }

function ConvertTo-Hash($obj) {
    if ($null -eq $obj) { return $null }
    if ($obj -is [string]) { return $obj }
    if ($obj -is [System.Collections.IDictionary]) {
        $h = @{}; foreach ($k in $obj.Keys) { $h[$k] = ConvertTo-Hash $obj[$k] }; return $h
    }
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}; foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hash $p.Value }; return $h
    }
    if ($obj -is [System.Collections.IEnumerable]) {
        $l = New-Object System.Collections.ArrayList
        foreach ($i in $obj) { [void]$l.Add((ConvertTo-Hash $i)) }
        return ,$l
    }
    return $obj
}

function Read-Json([string]$Path, $Default) {
    if (Test-Path $Path) {
        $t = Read-TextFile $Path
        if ($t -and $t.Trim()) {
            try { $data = ConvertTo-Hash (ConvertFrom-Json $t); return ,$data } catch { }
        }
    }
    return ,$Default
}

function Save-Json([string]$Path, $Obj) {
    $json = ConvertTo-Json -InputObject $Obj -Depth 20
    $tmp = "$Path.tmp"
    Write-TextFile $tmp $json
    Move-Item -Path $tmp -Destination $Path -Force
}

function New-List { return ,(New-Object System.Collections.ArrayList) }

function ConvertTo-Slug([string]$Text) {
    $n = $Text.Normalize([Text.NormalizationForm]::FormD)
    $sb = New-Object Text.StringBuilder
    foreach ($ch in $n.ToCharArray()) {
        if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
    }
    $s = $sb.ToString().ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    return $s.Trim('-')
}

function Get-DateKey([datetime]$Date = (Get-Date)) { return $Date.ToString('yyyy-MM-dd') }
function ConvertFrom-DateKey([string]$Key) { return [datetime]::ParseExact($Key, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }

# -----------------------------------------------------------------------------
#  Config / API key
# -----------------------------------------------------------------------------
function Get-EnvConfig {
    $cfg = @{ GEMINI_API_KEY = $env:GEMINI_API_KEY; GEMINI_MODEL = $env:GEMINI_MODEL }
    $p = Join-Path $script:Root '.env'
    if (Test-Path $p) {
        foreach ($line in [IO.File]::ReadAllLines($p)) {
            if ($line -match '^\s*([A-Za-z_]+)\s*=\s*(.*)$') {
                $v = $matches[2].Trim().Trim('"').Trim("'")
                if ($v) { $cfg[$matches[1].ToUpper()] = $v }
            }
        }
    }
    return $cfg
}

function Set-ApiKey([string]$Key) {
    $p = Join-Path $script:Root '.env'
    $lines = New-Object System.Collections.ArrayList
    if (Test-Path $p) { foreach ($l in [IO.File]::ReadAllLines($p)) { if ($l -notmatch '^\s*GEMINI_API_KEY\s*=') { [void]$lines.Add($l) } } }
    [void]$lines.Insert(0, "GEMINI_API_KEY=$($Key.Trim())")
    Write-TextFile $p (($lines -join "`r`n") + "`r`n")
}

function Test-HasApiKey { $c = Get-EnvConfig; return [bool]$c.GEMINI_API_KEY }

# -----------------------------------------------------------------------------
#  Catalog
# -----------------------------------------------------------------------------
function Get-Categories { return ,(Read-Json (Join-Path $script:CatalogDir 'categories.json') (New-List)) }

function Get-CategoryMap {
    $m = @{}; foreach ($c in (Get-Categories)) { $m[$c.id] = $c }; return $m
}

function Get-AllBooks {
    $cats = Get-CategoryMap
    $list = New-Object System.Collections.ArrayList
    $seen = @{}
    $sources = @(
        @{ items = (Read-Json (Join-Path $script:CatalogDir 'books.json') (New-List)); custom = $false },
        @{ items = (Read-Json $script:CustomBooksPath (New-List)); custom = $true }
    )
    foreach ($src in $sources) {
        foreach ($b in $src.items) {
            $cat = $cats[$b.cat]
            if (-not $cat) { continue }
            $id = $(if ($b.id) { $b.id } else { ConvertTo-Slug $b.title })
            if ($seen.ContainsKey($id)) { continue }
            $seen[$id] = 1
            [void]$list.Add(@{
                id = $id; title = $b.title; author = $b.author; cat = $b.cat
                catName = $cat.name; icon = $cat.icon; domain = $cat.domain
                fiction = [bool]$cat.fiction; custom = $src.custom
            })
        }
    }
    return ,$list
}

function Get-BookById([string]$Id) {
    foreach ($b in (Get-AllBooks)) { if ($b.id -eq $Id) { return $b } }
    return $null
}

function Find-Book([string]$Query) {
    $books = Get-AllBooks
    $q = $Query.Trim().ToLowerInvariant()
    $slug = ConvertTo-Slug $Query
    foreach ($b in $books) { if ($b.id -eq $slug -or $b.title.ToLowerInvariant() -eq $q) { return $b } }
    foreach ($b in $books) { if ($b.title.ToLowerInvariant().Contains($q)) { return $b } }
    foreach ($b in $books) { if ($b.id.Contains($slug)) { return $b } }
    return $null
}

function Find-Category([string]$Query) {
    $q = $Query.Trim().ToLowerInvariant()
    $cats = Get-Categories
    foreach ($c in $cats) { if ($c.id -eq $q -or $c.name.ToLowerInvariant() -eq $q) { return $c } }
    foreach ($c in $cats) { if ($c.name.ToLowerInvariant().Contains($q)) { return $c } }
    return $null
}

function Add-CustomBook([string]$Title, [string]$Author, [string]$CatId) {
    if (-not $Title) { throw 'Title is required.' }
    $cat = Find-Category $CatId
    if (-not $cat) { throw "Unknown category '$CatId'. Run 'dailyread categories' to see the list." }
    $id = ConvertTo-Slug $Title
    if (Get-BookById $id) { throw "'$Title' is already in the library." }
    $custom = Read-Json $script:CustomBooksPath (New-List)
    [void]$custom.Add(@{ id = $id; title = $Title.Trim(); author = $(if ($Author) { $Author.Trim() } else { 'Unknown' }); cat = $cat.id; custom = $true; addedAt = (Get-Date).ToString('o') })
    Save-Json $script:CustomBooksPath $custom
    return Get-BookById $id
}

# -----------------------------------------------------------------------------
#  Settings
# -----------------------------------------------------------------------------
function Get-DefaultSettings {
    return @{
        notifyTime     = '21:00'
        days           = [System.Collections.ArrayList]@('Mon','Tue','Wed','Thu','Fri','Sat','Sun')
        fictionRatio   = 0.3
        summaryMinutes = 60
        wpm            = 230
        weights        = @{}
        browserNotify  = $false
        model          = ''
        email          = @{
            enabled            = $true
            targetEmail        = 'vpsapra5@gmail.com'
            senderEmail        = 'vpsapra5@gmail.com'
            service            = 'gmail'
            appPassword        = ''
            resendApiKey       = ''
            includeFullSummary = $false
        }
    }
}

function Get-Settings {
    $s = Get-DefaultSettings
    $saved = Read-Json $script:SettingsPath @{}
    foreach ($k in @($saved.Keys)) { if ($null -ne $saved[$k]) { $s[$k] = $saved[$k] } }
    if (-not ($s.weights -is [System.Collections.IDictionary])) { $s.weights = @{} }
    if (-not ($s.email -is [System.Collections.IDictionary]))   { $s.email = (Get-DefaultSettings).email }
    if (-not $s.summaryMinutes -or [int]$s.summaryMinutes -lt 60) { $s.summaryMinutes = 60 }
    return $s
}

function Save-Settings($Settings) {
    if ($Settings.ContainsKey('summaryMinutes')) {
        $Settings.summaryMinutes = [Math]::Max(60, [int]$Settings.summaryMinutes)
    }
    Save-Json $script:SettingsPath $Settings
}

function Get-CategoryWeight($Settings, [string]$CatId) {
    $w = $Settings.weights[$CatId]
    if ($null -eq $w) { return 1.0 }
    return [double]$w
}

# -----------------------------------------------------------------------------
#  History (days, finished, queue, progress)
# -----------------------------------------------------------------------------
function Get-History {
    $h = Read-Json $script:HistoryPath @{}
    if (-not ($h.days -is [System.Collections.IDictionary]))     { $h.days = @{} }
    if (-not ($h.finished -is [System.Collections.IDictionary])) { $h.finished = @{} }
    if (-not ($h.progress -is [System.Collections.IDictionary])) { $h.progress = @{} }
    if (-not ($h.queue -is [System.Collections.ArrayList]))      { $h.queue = New-Object System.Collections.ArrayList }
    foreach ($k in @($h.days.Keys)) {
        $d = $h.days[$k]
        if (-not ($d.skipped -is [System.Collections.ArrayList])) { $d.skipped = New-Object System.Collections.ArrayList }
    }
    return $h
}

function Save-History($History) { Save-Json $script:HistoryPath $History }

function Select-NextBook {
    param($History, [string]$ForDate, [string[]]$Exclude = @())
    $settings = Get-Settings
    $books = Get-AllBooks
    $byId = @{}; foreach ($b in $books) { $byId[$b.id] = $b }
    $finished = $History.finished

    # 1. My queue always wins
    foreach ($q in @($History.queue)) {
        if ($byId.ContainsKey($q) -and -not $finished.ContainsKey($q) -and ($Exclude -notcontains $q)) {
            $History.queue.Remove($q)
            return $byId[$q]
        }
    }

    # 2. Build the candidate pool
    $used = @{}
    foreach ($k in $History.days.Keys) {
        $d = $History.days[$k]
        if ($d.bookId) { $used[$d.bookId] = 1 }
        foreach ($s in $d.skipped) { $used[$s] = 1 }
    }
    $enabled = @($books | Where-Object { (Get-CategoryWeight $settings $_.cat) -gt 0 -and ($Exclude -notcontains $_.id) })
    if ($enabled.Count -eq 0) { $enabled = @($books | Where-Object { $Exclude -notcontains $_.id }) }
    $pool = @($enabled | Where-Object { -not $finished.ContainsKey($_.id) -and -not $used.ContainsKey($_.id) })
    if ($pool.Count -eq 0) { $pool = @($enabled | Where-Object { -not $finished.ContainsKey($_.id) }) }
    if ($pool.Count -eq 0) { $pool = $enabled }

    # 3. Never the same category two days in a row
    $prevKey = Get-DateKey ((ConvertFrom-DateKey $ForDate).AddDays(-1))
    if ($History.days.ContainsKey($prevKey)) {
        $prev = $byId[$History.days[$prevKey].bookId]
        if ($prev) {
            $p2 = @($pool | Where-Object { $_.cat -ne $prev.cat })
            if ($p2.Count -gt 0) { $pool = $p2 }
        }
    }

    # 4. Fiction / non-fiction balance
    $wantFiction = (Get-Random -Minimum 0.0 -Maximum 1.0) -lt [double]$settings.fictionRatio
    $p3 = @($pool | Where-Object { $_.fiction -eq $wantFiction })
    if ($p3.Count -gt 0) { $pool = $p3 }

    # 5. Weighted category pick, then random book within it
    $byCat = @{}
    foreach ($b in $pool) { if (-not $byCat.ContainsKey($b.cat)) { $byCat[$b.cat] = New-Object System.Collections.ArrayList }; [void]$byCat[$b.cat].Add($b) }
    $catIds = @($byCat.Keys)
    $total = 0.0
    foreach ($c in $catIds) { $total += [Math]::Max(0.1, (Get-CategoryWeight $settings $c)) }
    $r = Get-Random -Minimum 0.0 -Maximum $total
    $chosen = $catIds[-1]
    foreach ($c in $catIds) { $r -= [Math]::Max(0.1, (Get-CategoryWeight $settings $c)); if ($r -le 0) { $chosen = $c; break } }
    $items = $byCat[$chosen]
    return $items[(Get-Random -Minimum 0 -Maximum $items.Count)]
}

function Get-DayEntry([string]$Date = (Get-DateKey)) {
    $h = Get-History
    $entry = $h.days[$Date]
    if ($entry -and -not (Get-BookById $entry.bookId)) { $entry = $null }
    if (-not $entry) {
        $b = Select-NextBook -History $h -ForDate $Date
        $entry = @{ bookId = $b.id; assignedAt = (Get-Date).ToString('o'); skipped = (New-Object System.Collections.ArrayList) }
        $h.days[$Date] = $entry
        Save-History $h
    }
    return $entry
}

function Skip-Day([string]$Date = (Get-DateKey)) {
    $null = Get-DayEntry $Date
    $h = Get-History
    $entry = $h.days[$Date]
    if ($entry.skipped -notcontains $entry.bookId) { [void]$entry.skipped.Add($entry.bookId) }
    $b = Select-NextBook -History $h -ForDate $Date -Exclude ([string[]]@($entry.skipped))
    $entry.bookId = $b.id
    $entry.assignedAt = (Get-Date).ToString('o')
    Save-History $h
    return $b
}

function Set-DayBook([string]$BookId, [string]$Date = (Get-DateKey)) {
    $book = Get-BookById $BookId
    if (-not $book) { throw "Unknown book: $BookId" }
    $null = Get-DayEntry $Date
    $h = Get-History
    $entry = $h.days[$Date]
    if ($entry.bookId -ne $BookId -and $entry.skipped -notcontains $entry.bookId) { [void]$entry.skipped.Add($entry.bookId) }
    $entry.bookId = $BookId
    $entry.assignedAt = (Get-Date).ToString('o')
    if ($h.queue -contains $BookId) { $h.queue.Remove($BookId) }
    Save-History $h
    return $book
}

function Set-Queue([string]$BookId, [string]$Action = 'add') {
    $h = Get-History
    if ($Action -eq 'remove') { if ($h.queue -contains $BookId) { $h.queue.Remove($BookId) } }
    elseif ($h.queue -notcontains $BookId) { [void]$h.queue.Add($BookId) }
    Save-History $h
    return ,$h.queue
}

function Complete-Book([string]$BookId, [int]$Minutes = 0) {
    $h = Get-History
    if ($Minutes -le 0) {
        $meta = Read-Json (Join-Path $script:SummaryDir "$BookId.json") @{}
        $Minutes = if ($meta.minutes) { [int]$meta.minutes } else { [int](Get-Settings).summaryMinutes }
    }
    if ($Minutes -lt 60) { $Minutes = 60 }
    $h.finished[$BookId] = @{ date = (Get-DateKey); minutes = $Minutes; finishedAt = (Get-Date).ToString('o') }
    $h.progress[$BookId] = 1
    if ($h.queue -contains $BookId) { $h.queue.Remove($BookId) }
    Save-History $h
}

function Set-Progress([string]$BookId, [double]$Pct) {
    $h = Get-History
    $h.progress[$BookId] = [Math]::Round([Math]::Min(1, [Math]::Max(0, $Pct)), 3)
    Save-History $h
}

function Get-Stats {
    $h = Get-History
    $books = Get-AllBooks
    $byId = @{}; foreach ($b in $books) { $byId[$b.id] = $b }
    $dates = @{}; $minutes = 0
    $domainDone = @{}; $domainTotal = @{}
    foreach ($b in $books) { $domainTotal[$b.domain] = 1 + [int]$domainTotal[$b.domain] }
    $recent = New-Object System.Collections.ArrayList
    foreach ($id in $h.finished.Keys) {
        $f = $h.finished[$id]
        $dates[$f.date] = 1 + [int]$dates[$f.date]
        $fMins = if ($f.minutes) { [int]$f.minutes } else { 60 }
        if ($fMins -lt 60) { $fMins = 60 }
        $minutes += $fMins
        $b = $byId[$id]
        if ($b) {
            $domainDone[$b.domain] = 1 + [int]$domainDone[$b.domain]
            [void]$recent.Add(@{ book = $b; date = $f.date; minutes = $fMins; finishedAt = $f.finishedAt })
        }
    }
    # current streak
    $streak = 0
    $d = Get-Date
    if (-not $dates.ContainsKey((Get-DateKey $d))) { $d = $d.AddDays(-1) }
    while ($dates.ContainsKey((Get-DateKey $d))) { $streak++; $d = $d.AddDays(-1) }
    # best streak
    $best = 0; $run = 0; $prev = $null
    foreach ($k in ($dates.Keys | Sort-Object)) {
        $cur = ConvertFrom-DateKey $k
        if ($prev -and ($cur - $prev).TotalDays -eq 1) { $run++ } else { $run = 1 }
        if ($run -gt $best) { $best = $run }
        $prev = $cur
    }
    $sorted = New-Object System.Collections.ArrayList
    foreach ($r in ($recent | Sort-Object { $_.finishedAt } -Descending | Select-Object -First 12)) { [void]$sorted.Add($r) }
    $activity = @{}
    for ($i = 0; $i -lt 84; $i++) { $k = Get-DateKey ((Get-Date).AddDays(-$i)); if ($dates.ContainsKey($k)) { $activity[$k] = $dates[$k] } }
    return @{
        streak = $streak; bestStreak = $best; finished = $h.finished.Count; totalBooks = $books.Count
        minutes = $minutes; domainDone = $domainDone; domainTotal = $domainTotal
        recent = $sorted; activity = $activity; daysActive = $h.days.Count
    }
}

# -----------------------------------------------------------------------------
#  Summaries (Gemini)
# -----------------------------------------------------------------------------
function Get-SummaryPath([string]$BookId) { return Join-Path $script:SummaryDir "$BookId.md" }

function Get-SummaryStatus([string]$BookId) {
    $p = Get-SummaryPath $BookId
    $st = @{ generated = (Test-Path $p); generating = $false; error = $null }
    $lock = "$p.generating"
    if (Test-Path $lock) {
        $age = (Get-Date) - (Get-Item $lock).LastWriteTime
        if ($age.TotalMinutes -lt 20) { $st.generating = $true } else { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
    }
    if (-not $st.generated -and -not $st.generating -and (Test-Path "$p.error")) { $st.error = Read-TextFile "$p.error" }
    return $st
}

function Get-SummaryMeta([string]$BookId) {
    return Read-Json (Join-Path $script:SummaryDir "$BookId.json") @{}
}

function Invoke-Gemini {
    param([string]$Prompt, [int]$MaxTokens = 16000)
    $cfg = Get-EnvConfig
    $key = $cfg.GEMINI_API_KEY
    if (-not $key) { throw 'No Gemini API key found. Run: dailyread set-key YOUR_KEY  (free key: https://aistudio.google.com/apikey)' }
    $settings = Get-Settings
    $primary = 'gemini-3.8-flash'
    if ($cfg.GEMINI_MODEL) { $primary = $cfg.GEMINI_MODEL }
    if ($settings.model) { $primary = $settings.model }
    $models = @($primary, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash') | Select-Object -Unique

    $body = @{
        contents = @(@{ role = 'user'; parts = @(@{ text = $Prompt }) })
        generationConfig = @{ temperature = 0.7; maxOutputTokens = $MaxTokens; thinkingConfig = @{ thinkingBudget = 1024 } }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $body -Depth 10))
    $errors = New-Object System.Collections.ArrayList
    foreach ($m in $models) {
        try {
            $resp = Invoke-WebRequest -Uri "https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent" `
                -Method Post -Headers @{ 'x-goog-api-key' = $key } -Body $bytes `
                -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 600
            $text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
            $parsed = ConvertFrom-Json $text
            $out = ''
            if ($parsed.candidates) {
                foreach ($part in $parsed.candidates[0].content.parts) { if (-not $part.thought -and $part.text) { $out += $part.text } }
            }
            if ($out.Trim()) { return @{ text = $out; model = $m } }
            [void]$errors.Add("${m}: empty response")
        } catch {
            $msg = $_.Exception.Message
            $r = $_.Exception.Response
            if ($r) {
                try {
                    $sr = New-Object IO.StreamReader($r.GetResponseStream())
                    $e = (ConvertFrom-Json $sr.ReadToEnd()).error
                    if ($e) { $msg = "$($e.code) $($e.message)" }
                } catch { }
            }
            [void]$errors.Add("${m}: $msg")
            if ($msg -match 'API key not valid|API_KEY_INVALID|PERMISSION_DENIED') { break }
        }
    }
    throw ('Gemini request failed. ' + ($errors -join ' | '))
}

function Clear-ModelText([string]$Text) {
    $t = $Text.Trim()
    if ($t -match '(?s)^```(?:markdown|md)?\s*(.*?)\s*```$') { $t = $matches[1].Trim() }
    return $t
}

function Get-SummaryPrompts($Book) {
    $s = Get-Settings
    $mins = [Math]::Max(60, [int]$s.summaryMinutes)
    $scale = [double]$mins / 60.0
    $w = @{}
    foreach ($pair in @(@('idea',500), @('author',800), @('breakdown',8500), @('ideas',3000), @('crit',800))) {
        $w[$pair[0]] = [int]([Math]::Round(($pair[1] * $scale) / 50.0) * 50)
    }
    $kind = $(if ($Book.fiction) { 'fiction' } else { 'non-fiction' })
    $related = @(Get-AllBooks | Where-Object { $_.domain -eq $Book.domain -and $_.id -ne $Book.id } | ForEach-Object { "$($_.title) by $($_.author)" }) -join '; '

    if ($Book.fiction) {
        $breakdownRules = @"
Use ### subheadings for: Setting & World, Main Characters, The Story (beginning, rising action, climax), Themes, Symbolism & Style, Why It Endures.
Walk through the plot in rich detail so the reader truly knows the story. Put the ending and any major twists inside ONE spoiler block written exactly like this:

<details><summary>Spoiler: how it ends</summary>

(markdown paragraphs about the ending here)

</details>
"@
    } else {
        $breakdownRules = @"
Walk through the book part by part or chapter by chapter, with a ### subheading for each part or chapter (use the real chapter or part names when you know them).
For each, explain the key arguments, the stories, studies and evidence the author uses, and how the ideas build on each other.
"@
    }

    $common = @"
Writing rules:
- Original writing only. Never reproduce long passages from the book.
- Be concrete and vivid: specific examples, names, numbers, studies and stories from the book.
- Clear, engaging, intelligent prose. Short paragraphs, occasional bullet lists, **bold** for key terms.
- Output ONLY Markdown. No code fences. No preamble like "Here is".
"@

    $partA = @"
You are a world-class editor writing an exhaustive masterclass book summary for a daily reading app. The full summary is read in about $mins minutes (strictly minimum 14,000 words total for a true 1-hour read). You are writing PART 1 of 2.

Book: "$($Book.title)" by $($Book.author)
Category: $($Book.catName) ($kind)

Use exactly this structure and these headings:

# $($Book.title)
*by $($Book.author)* | (original publication year) | $($Book.catName)

> **Why it matters:** (one compelling sentence)

## The Big Idea
(about $($w.idea) words) The core thesis or heart of the book in plain language.

## About the Author & Context
(about $($w.author) words) Who the author is, when and why the book was written, and its impact.

## The Breakdown
(about $($w.breakdown) words)
$breakdownRules

$common
- Stop after The Breakdown section. Do not write key takeaways, quotes, or conclusions; part 2 covers those.
"@

    $partB = @"
You are a world-class editor writing an exhaustive masterclass book summary for a daily reading app. You are writing PART 2 of 2 for "$($Book.title)" by $($Book.author) ($kind, $($Book.catName)).
Part 1 (title, big idea, author context, and detailed breakdown) is already written. Write ONLY the sections below, starting directly with the first heading.

## 10 Key Ideas
(about $($w.ideas) words in total) Ten numbered ### subheadings like "### 1. Idea title". For each: explain the idea in 2-3 sentences, then a separate line starting with "**In real life:**" giving a concrete everyday example of applying it.$(if ($Book.fiction) { ' For fiction, these are the 10 key themes, insights and life lessons the story teaches.' })

## Memorable Quotes
3 to 5 short quotes as Markdown blockquotes, each followed by an attribution line. Only include lines you are confident are accurate.

## Criticisms & Counterpoints
(about $($w.crit) words) A fair, balanced view of the main critiques and limitations.

## Apply It Today
3 to 5 concrete actions or reflection prompts written as a checklist, each line starting with "- [ ] ".

## Read Next
Exactly 3 related books, chosen from this list when possible: $related.
Format each as: - **Title** by Author -- one sentence on why.

## Quick Quiz
Exactly 5 questions that test understanding. Format each one exactly like this:

**1. Question text?**

<details><summary>Show answer</summary>

The answer, with a one-sentence explanation.

</details>

$common
"@
    return @{ partA = $partA; partB = $partB }
}

function New-Summary {
    param([string]$BookId, [switch]$Force)
    $book = Get-BookById $BookId
    if (-not $book) { throw "Unknown book id: $BookId" }
    $path = Get-SummaryPath $BookId
    if ((Test-Path $path) -and -not $Force) { return $path }
    $lock = "$path.generating"; $err = "$path.error"
    Write-TextFile $lock ((Get-Date).ToString('o'))
    if (Test-Path $err) { Remove-Item $err -Force }
    try {
        $p = Get-SummaryPrompts $book
        $a = Invoke-Gemini -Prompt $p.partA -MaxTokens 20000
        $b = Invoke-Gemini -Prompt $p.partB -MaxTokens 14000
        $md = (Clear-ModelText $a.text) + "`n`n" + (Clear-ModelText $b.text) + "`n"
        Write-TextFile $path $md
        $words = ($md -split '\s+' | Where-Object { $_ }).Count
        $mins = [Math]::Max(60, [int](Get-Settings).summaryMinutes)
        Save-Json (Join-Path $script:SummaryDir "$BookId.json") @{ generatedAt = (Get-Date).ToString('o'); model = $a.model; words = $words; minutes = $mins }
        return $path
    } catch {
        Write-TextFile $err $_.Exception.Message
        throw
    } finally {
        Remove-Item $lock -Force -ErrorAction SilentlyContinue
    }
}

function Start-BackgroundGenerate([string]$BookId, [switch]$Force) {
    $st = Get-SummaryStatus $BookId
    if ($st.generating) { return }
    if ($st.generated -and -not $Force) { return }
    $p = Get-SummaryPath $BookId
    Write-TextFile "$p.generating" ((Get-Date).ToString('o'))
    if (Test-Path "$p.error") { Remove-Item "$p.error" -Force }
    $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($script:CliPath)`" generate --book $BookId"
    if ($Force) { $argLine += ' --force' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden | Out-Null
}

# -----------------------------------------------------------------------------
#  Highlights
# -----------------------------------------------------------------------------
function Get-Highlights([string]$BookId) {
    $all = Read-Json $script:HighlightsPath @{}
    $l = $all[$BookId]
    if (-not ($l -is [System.Collections.ArrayList])) { $l = New-Object System.Collections.ArrayList }
    return ,$l
}

function Add-Highlight([string]$BookId, [string]$Text, [string]$Note) {
    $all = Read-Json $script:HighlightsPath @{}
    if (-not ($all[$BookId] -is [System.Collections.ArrayList])) { $all[$BookId] = New-Object System.Collections.ArrayList }
    $hl = @{ id = ([guid]::NewGuid().ToString('N').Substring(0, 10)); text = $Text; note = $Note; createdAt = (Get-Date).ToString('o') }
    [void]$all[$BookId].Add($hl)
    Save-Json $script:HighlightsPath $all
    return $hl
}

function Remove-Highlight([string]$BookId, [string]$HighlightId) {
    $all = Read-Json $script:HighlightsPath @{}
    if ($all[$BookId] -is [System.Collections.ArrayList]) {
        $keep = New-Object System.Collections.ArrayList
        foreach ($h in $all[$BookId]) { if ($h.id -ne $HighlightId) { [void]$keep.Add($h) } }
        $all[$BookId] = $keep
        Save-Json $script:HighlightsPath $all
    }
}

# -----------------------------------------------------------------------------
#  Local server control
# -----------------------------------------------------------------------------
function Test-ServerRunning {
    try {
        $r = Invoke-WebRequest -Uri "$($script:BaseUrl)/api/ping" -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Start-DailyReadServer {
    if (Test-ServerRunning) { return $true }
    $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($script:ServerPath)`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-ServerRunning) { return $true }
    }
    return $false
}

function Stop-DailyReadServer {
    $stopped = $false
    try { Invoke-WebRequest -Uri "$($script:BaseUrl)/api/shutdown" -Method Post -UseBasicParsing -TimeoutSec 3 | Out-Null; $stopped = $true } catch { }
    Start-Sleep -Milliseconds 800
    if (Test-Path $script:PidPath) {
        $procId = [int](Read-TextFile $script:PidPath)
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; $stopped = $true }
        Remove-Item $script:PidPath -Force -ErrorAction SilentlyContinue
    }
    return $stopped
}

# -----------------------------------------------------------------------------
#  Notifications + Windows Task Scheduler
# -----------------------------------------------------------------------------
function Show-Toast([string]$Title, [string]$Body, [string]$Url = $script:BaseUrl) {
    $t = [Security.SecurityElement]::Escape($Title)
    $b = [Security.SecurityElement]::Escape($Body)
    $u = [Security.SecurityElement]::Escape($Url)
    try {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $xml = @"
<toast activationType="protocol" launch="$u" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$b</text>
      <text placement="attribution">DailyRead</text>
    </binding>
  </visual>
  <actions>
    <action content="Read now" activationType="protocol" arguments="$u" />
    <action content="Later" activationType="system" arguments="dismiss" />
  </actions>
  <audio src="ms-winsoundevent:Notification.Reminder" />
</toast>
"@
        $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $doc.LoadXml($xml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($script:ToastAppId).Show($toast)
        return $true
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms, System.Drawing
            $ni = New-Object System.Windows.Forms.NotifyIcon
            $ni.Icon = [System.Drawing.SystemIcons]::Information
            $ni.BalloonTipTitle = $Title; $ni.BalloonTipText = $Body; $ni.Visible = $true
            $ni.ShowBalloonTip(15000); Start-Sleep -Seconds 8; $ni.Dispose()
            return $true
        } catch { return $false }
    }
}

function Register-DailyTask {
    $s = Get-Settings
    $at = [datetime]::ParseExact($s.notifyTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $map = @{ Mon = 'Monday'; Tue = 'Tuesday'; Wed = 'Wednesday'; Thu = 'Thursday'; Fri = 'Friday'; Sat = 'Saturday'; Sun = 'Sunday' }
    $days = @($s.days | ForEach-Object { $map[$_] } | Where-Object { $_ })
    if ($days.Count -eq 0) {
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
        return $null
    }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($script:CliPath)`" notify"
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $at
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60)
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $set -Description 'DailyRead: daily 1-hour book summary reminder' -Force | Out-Null
    return Get-TaskInfo
}

function Get-TaskInfo {
    $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    if (-not $t) { return @{ registered = $false; nextRun = $null; state = $null } }
    $i = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $next = $null
    if ($i -and $i.NextRunTime) { $next = $i.NextRunTime.ToString('o') }
    return @{ registered = $true; nextRun = $next; state = "$($t.State)" }
}

function Convert-MarkdownToHtmlEmail([string]$Md) {
    if (-not $Md) { return '' }
    $lines = $Md -split "`r?`n"
    $html = New-Object System.Text.StringBuilder
    $inList = $false
    
    foreach ($line in $lines) {
        $l = $line.Trim()
        if ($l -match '^</?details>' -or $l -match '^</?summary>') { continue }
        
        if ($l -match '^#\s+(.*)$') {
            if ($inList) { [void]$html.AppendLine("</ul>"); $inList = $false }
            [void]$html.AppendLine("<h1 style='color:#ffffff; font-size:22px; margin:28px 0 12px 0; font-family:Georgia, serif; font-weight:700;'>$($matches[1])</h1>")
            continue
        }
        if ($l -match '^##\s+(.*)$') {
            if ($inList) { [void]$html.AppendLine("</ul>"); $inList = $false }
            [void]$html.AppendLine("<h2 style='color:#f8fafc; font-size:18px; border-bottom:1px solid #334155; padding-bottom:8px; margin:24px 0 12px 0; font-family:Georgia, serif; font-weight:600;'>$($matches[1])</h2>")
            continue
        }
        if ($l -match '^###\s+(.*)$') {
            if ($inList) { [void]$html.AppendLine("</ul>"); $inList = $false }
            [void]$html.AppendLine("<h3 style='color:#38bdf8; font-size:15px; margin:18px 0 8px 0; font-weight:600;'>$($matches[1])</h3>")
            continue
        }
        if ($l -match '^>\s*(.*)$') {
            if ($inList) { [void]$html.AppendLine("</ul>"); $inList = $false }
            [void]$html.AppendLine("<blockquote style='border-left:3px solid #f59e0b; margin:16px 0; padding:10px 16px; background:rgba(245, 158, 11, 0.08); color:#fbbf24; font-style:italic;'>$($matches[1])</blockquote>")
            continue
        }
        if ($l -match '^\s*[-*]\s+(.*)$') {
            if (-not $inList) { [void]$html.AppendLine("<ul style='padding-left:22px; margin:12px 0; color:#cbd5e1; line-height:1.7;'>"); $inList = $true }
            $item = $matches[1] -replace '\*\*([^*]+)\*\*', '<strong style="color:#ffffff;">$1</strong>' -replace '\*([^*]+)\*', '<em style="color:#e2e8f0;">$1</em>'
            [void]$html.AppendLine("<li style='margin-bottom:8px;'>$item</li>")
            continue
        }
        if ($inList) { [void]$html.AppendLine("</ul>"); $inList = $false }
        
        if ($l -match '^---+$') {
            [void]$html.AppendLine("<hr style='border:none; border-top:1px solid #334155; margin:24px 0;' />")
            continue
        }
        
        if (-not $l) { continue }
        
        $p = $l -replace '\*\*([^*]+)\*\*', '<strong style="color:#ffffff;">$1</strong>' -replace '\*([^*]+)\*', '<em style="color:#e2e8f0;">$1</em>'
        [void]$html.AppendLine("<p style='color:#cbd5e1; font-size:15px; line-height:1.75; margin:12px 0;'>$p</p>")
    }
    if ($inList) { [void]$html.AppendLine("</ul>") }
    return $html.ToString()
}

function Build-EmailHtml {
    param(
        [hashtable]$Book,
        [string]$PhoneUrl,
        [int]$Minutes = 30,
        [string]$SummaryHtml = ''
    )
    $title = [System.Net.WebUtility]::HtmlEncode($Book.title)
    $author = [System.Net.WebUtility]::HtmlEncode($Book.author)
    $cat = [System.Net.WebUtility]::HtmlEncode($Book.catName)
    $desc = [System.Net.WebUtility]::HtmlEncode($Book.desc)
    $dateStr = (Get-Date).ToString('dddd, MMMM d')

    $summarySection = ''
    if ($SummaryHtml) {
        $summarySection = @"
<div style='margin-top: 36px; padding-top: 28px; border-top: 2px dashed #334155;'>
  <div style='font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 20px; text-align: center;'>Complete 30-Minute Summary Breakdown</div>
  <div style='font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif; line-height: 1.75; color: #cbd5e1;'>
    $SummaryHtml
  </div>
</div>
"@
    }

    $html = @"
<!DOCTYPE html>
<html>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>$title - DailyRead</title>
</head>
<body style='margin:0; padding:0; background-color:#0b0f19; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:#f8fafc;'>
  <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0' style='background-color:#0b0f19; padding: 24px 12px;'>
    <tr>
      <td align='center'>
        <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0' style='max-width:620px; background-color:#131b2e; border: 1px solid #1e293b; border-radius:16px; overflow:hidden; box-shadow:0 12px 30px rgba(0,0,0,0.4);'>
          <!-- Header Banner -->
          <tr>
            <td style='padding: 24px 32px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid #334155;'>
              <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td>
                    <span style='font-size: 18px; font-weight: 800; color: #f59e0b; letter-spacing: -0.02em;'>Daily<span style='color:#ec4899;'>Read</span></span>
                    <span style='font-size: 12px; color: #94a3b8; margin-left: 10px; text-transform: uppercase; letter-spacing: 0.08em;'>Tonight's 9:00 PM Read</span>
                  </td>
                  <td align='right'>
                    <span style='font-size: 13px; color: #cbd5e1; font-weight: 500;'>$dateStr</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero Content -->
          <tr>
            <td style='padding: 36px 32px;'>
              <!-- Category & Read Time -->
              <div style='margin-bottom: 16px;'>
                <span style='background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;'>$cat</span>
                <span style='background: rgba(255, 255, 255, 0.08); color: #cbd5e1; border: 1px solid rgba(255, 255, 255, 0.12); padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 500; margin-left: 6px;'>$Minutes min read</span>
              </div>

              <!-- Title & Author -->
              <h1 style='margin: 0 0 8px 0; font-size: 28px; line-height: 1.25; font-weight: 800; color: #ffffff; font-family: Georgia, serif;'>$title</h1>
              <p style='margin: 0 0 20px 0; font-size: 16px; color: #94a3b8;'>by <strong style='color:#e2e8f0;'>$author</strong></p>

              <!-- Description / Big Idea Hook -->
              <div style='background: #1a243b; border-left: 3px solid #f59e0b; border-radius: 4px; padding: 16px 20px; margin-bottom: 28px;'>
                <div style='font-size: 11px; text-transform: uppercase; font-weight: 700; color: #fbbf24; letter-spacing: 0.08em; margin-bottom: 6px;'>The Core Premise</div>
                <p style='margin:0; font-size: 15px; line-height: 1.6; color: #e2e8f0; font-style: italic;'>$desc</p>
              </div>

              <!-- Primary CTA Button -->
              <table role='presentation' border='0' cellspacing='0' cellpadding='0' style='margin-bottom: 24px;'>
                <tr>
                  <td align='center' style='border-radius: 10px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);'>
                    <a href='$PhoneUrl' target='_blank' style='display: inline-block; padding: 14px 28px; font-size: 16px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 10px;'>
                      &#128241; Read Tonight's Book on Your Phone &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style='font-size: 13px; color: #94a3b8; margin: 0 0 24px 0;'>
                Direct browser link: <a href='$PhoneUrl' style='color:#38bdf8; text-decoration:none;'>$PhoneUrl</a>
              </p>

              <!-- Full Summary if enabled -->
              $summarySection
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style='padding: 24px 32px; background: #0c1220; border-top: 1px solid #1e293b; text-align: center; color: #64748b; font-size: 13px;'>
              <p style='margin: 0 0 6px 0;'>DailyRead 9:00 PM Edition &bull; One great book, every day, in 1 hour (60 minutes)</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"@
    return $html
}

function Send-DailyEmail {
    param(
        [Parameter(Mandatory=$true)]$Book,
        [string]$TargetEmail = '',
        [switch]$IncludeFullSummary
    )
    $s = Get-Settings
    $em = $s.email
    if (-not $em) { $em = @{} }
    
    $to = if ($TargetEmail) { $TargetEmail } else { $em.targetEmail }
    if (-not $to) { $to = 'vpsapra5@gmail.com' }
    
    $cfg = Get-EnvConfig
    $appPass = if ($em.appPassword) { $em.appPassword } else { $cfg.GMAIL_APP_PASSWORD }
    $resendKey = if ($em.resendApiKey) { $em.resendApiKey } else { $cfg.RESEND_API_KEY }
    $service = if ($em.service) { $em.service } else { 'gmail' }
    $sender = if ($em.senderEmail) { $em.senderEmail } else { $to }
    
    $ip = Get-LocalIp
    $phoneUrl = "http://${ip}:$($script:Port)/#/read/$($Book.id)"
    $mins = if ($s.summaryMinutes) { [Math]::Max(60, [int]$s.summaryMinutes) } else { 60 }
    
    $p = Get-SummaryPath $Book.id
    $md = ''
    if (Test-Path $p) { $md = Read-TextFile $p }
    
    $summaryHtml = ''
    if ($IncludeFullSummary -or $em.includeFullSummary) {
        if ($md) { $summaryHtml = Convert-MarkdownToHtmlEmail $md }
    }
    
    $subject = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, [char]0xD83D + [char]0xDCDA + " Tonight's 1-Hour Read: {0} by {1}", $Book.title, $Book.author)
    $htmlBody = Build-EmailHtml -Book $Book -PhoneUrl $phoneUrl -Minutes $mins -SummaryHtml $summaryHtml
    
    if ($service -eq 'resend' -or ($resendKey -and -not $appPass)) {
        if (-not $resendKey) { throw "Resend API Key is required." }
        $bodyJson = @{
            from = "DailyRead <onboarding@resend.dev>"
            to = @($to)
            subject = $subject
            html = $htmlBody
        } | ConvertTo-Json -Compress
        $res = Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post -Headers @{
            Authorization = "Bearer $resendKey"
            'Content-Type' = 'application/json'
        } -Body $bodyJson
        return @{ ok = $true; id = $res.id; method = 'resend'; to = $to }
    } else {
        if (-not $appPass) {
            throw "Google App Password is required to send via Gmail. Please enter your 16-character App Password in Settings (generate free at https://myaccount.google.com/apppasswords)."
        }
        $cleanPass = ($appPass -replace '\s+', '').Trim()
        
        $smtp = New-Object System.Net.Mail.SmtpClient('smtp.gmail.com', 587)
        $smtp.EnableSsl = $true
        $smtp.UseDefaultCredentials = $false
        $smtp.Credentials = New-Object System.Net.NetworkCredential($sender, $cleanPass)
        $smtp.DeliveryMethod = [System.Net.Mail.SmtpDeliveryMethod]::Network
        $smtp.Timeout = 20000
        
        $msg = New-Object System.Net.Mail.MailMessage
        $msg.From = New-Object System.Net.Mail.MailAddress($sender, 'DailyRead')
        $msg.To.Add($to)
        $msg.Subject = $subject
        $msg.Body = $htmlBody
        $msg.IsBodyHtml = $true
        $msg.BodyEncoding = [System.Text.Encoding]::UTF8
        
        try {
            $smtp.Send($msg)
            return @{ ok = $true; to = $to; method = 'gmail' }
        } finally {
            $msg.Dispose()
            $smtp.Dispose()
        }
    }
}

function Invoke-DailyNotify {
    $today = Get-DateKey
    $entry = Get-DayEntry $today
    $book = Get-BookById $entry.bookId
    $null = Start-DailyReadServer
    if (-not (Get-SummaryStatus $book.id).generated) {
        try { $null = New-Summary -BookId $book.id } catch { }
    }
    $mins = (Get-Settings).summaryMinutes
    $url = "$($script:BaseUrl)/#/today"
    if ((Get-SummaryStatus $book.id).generated) { $url = "$($script:BaseUrl)/#/read/$($book.id)" }
    $null = Show-Toast "Your $mins-minute read is ready" "$($book.title) by $($book.author)" $url
    
    # Send Email Notification
    $s = Get-Settings
    if ($s.email -and $s.email.enabled) {
        try {
            $null = Send-DailyEmail -Book $book
        } catch {
            Write-Host "[Email notification error] $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # Pre-pick and pre-generate tomorrow so it is instant next time
    try {
        $t = Get-DayEntry (Get-DateKey ((Get-Date).AddDays(1)))
        $null = New-Summary -BookId $t.bookId
    } catch { }
}
