# =============================================================================
#  DailyRead - local web server (http://localhost:4747)
#  Windows PowerShell 5.1, ASCII-only. Started by: dailyread start
# =============================================================================
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'lib\core.ps1')

$script:StopServer = $false
$script:Mime = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.webp' = 'image/webp'; '.ico' = 'image/x-icon'; '.webmanifest' = 'application/manifest+json'; '.md' = 'text/markdown; charset=utf-8'
}

function Send-Bytes($Ctx, [byte[]]$Bytes, [string]$Type, [int]$Code = 200, [hashtable]$Headers = @{}) {
    $r = $Ctx.Response
    $r.StatusCode = $Code
    $r.ContentType = $Type
    $r.Headers['Cache-Control'] = 'no-cache'
    foreach ($k in $Headers.Keys) { $r.Headers[$k] = $Headers[$k] }
    $r.ContentLength64 = $Bytes.Length
    $r.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $r.OutputStream.Close()
}

function Send-Json($Ctx, $Obj, [int]$Code = 200) {
    $json = ConvertTo-Json -InputObject $Obj -Depth 20 -Compress
    if ($null -eq $json) { $json = 'null' }
    Send-Bytes $Ctx ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8' $Code
}

function Read-Body($Ctx) {
    try {
        $sr = New-Object IO.StreamReader($Ctx.Request.InputStream, [Text.Encoding]::UTF8)
        $t = $sr.ReadToEnd()
        if ($t -and $t.Trim()) { return ConvertTo-Hash (ConvertFrom-Json $t) }
    } catch { }
    return @{}
}

function Get-ReadySet {
    $set = @{}
    Get-ChildItem -Path $script:SummaryDir -Filter '*.md' -ErrorAction SilentlyContinue | ForEach-Object { $set[$_.BaseName] = 1 }
    return $set
}

function Get-BookView($Book, $History, $Ready) {
    if (-not $Book) { return $null }
    $v = @{}
    foreach ($k in $Book.Keys) { $v[$k] = $Book[$k] }
    $v.finished = $History.finished.ContainsKey($Book.id)
    $v.queued   = ($History.queue -contains $Book.id)
    $v.ready    = $Ready.ContainsKey($Book.id)
    $v.progress = $History.progress[$Book.id]
    return $v
}

function Get-TodayPayload {
    $date = Get-DateKey
    $entry = Get-DayEntry $date
    $book = Get-BookById $entry.bookId
    $st = Get-SummaryStatus $book.id
    if (-not $st.generated -and -not $st.generating -and -not $st.error -and (Test-HasApiKey)) {
        Start-BackgroundGenerate $book.id
        $st.generating = $true
    }
    $h = Get-History
    $ready = Get-ReadySet
    $settings = Get-Settings
    $upNext = New-Object System.Collections.ArrayList
    foreach ($q in $h.queue) { $b = Get-BookById $q; if ($b) { [void]$upNext.Add((Get-BookView $b $h $ready)) } }
    $tomorrow = $h.days[(Get-DateKey ((Get-Date).AddDays(1)))]
    return @{
        date = $date; dayNumber = $h.days.Count
        book = (Get-BookView $book $h $ready); status = $st
        skippedCount = $entry.skipped.Count
        upNext = $upNext
        tomorrow = $(if ($tomorrow) { Get-BookView (Get-BookById $tomorrow.bookId) $h $ready } else { $null })
        settings = @{ notifyTime = $settings.notifyTime; days = $settings.days; summaryMinutes = $settings.summaryMinutes; wpm = $settings.wpm }
        hasKey = (Test-HasApiKey)
    }
}

function Invoke-Route($Ctx) {
    $req = $Ctx.Request
    $method = $req.HttpMethod
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    $route = "$method $path"

    if ($route -eq 'GET /api/ping') { return Send-Json $Ctx @{ ok = $true; app = 'DailyRead' } }

    if ($route -eq 'GET /api/network') {
        $ip = Get-LocalIp
        return Send-Json $Ctx @{
            localIp = $ip
            port = $script:Port
            wifiUrl = "http://${ip}:$($script:Port)"
            networkListening = [bool]$script:IsNetworkListening
            adminCommand = "netsh http add urlacl url=http://+:$($script:Port)/ user=Everyone"
            firewallCommand = "netsh advfirewall firewall add rule name=`"DailyRead`" dir=in action=allow protocol=TCP localport=$($script:Port)"
        }
    }

    if ($route -eq 'POST /api/shutdown') {
        $script:StopServer = $true
        return Send-Json $Ctx @{ ok = $true }
    }

    if ($route -eq 'GET /api/categories') { return Send-Json $Ctx @{ categories = (Get-Categories) } }

    if ($route -eq 'GET /api/today') { return Send-Json $Ctx (Get-TodayPayload) }

    if ($route -eq 'POST /api/today/next') {
        $b = Skip-Day
        Start-BackgroundGenerate $b.id
        return Send-Json $Ctx (Get-TodayPayload)
    }

    if ($route -eq 'POST /api/today/pick') {
        $body = Read-Body $Ctx
        $b = Set-DayBook $body.bookId
        return Send-Json $Ctx (Get-TodayPayload)
    }

    if ($route -eq 'GET /api/books') {
        $h = Get-History; $ready = Get-ReadySet
        $list = New-Object System.Collections.ArrayList
        foreach ($b in (Get-AllBooks)) { [void]$list.Add((Get-BookView $b $h $ready)) }
        return Send-Json $Ctx @{ books = $list; todayId = $h.days[(Get-DateKey)].bookId }
    }

    if ($route -eq 'POST /api/books') {
        $body = Read-Body $Ctx
        try { $b = Add-CustomBook $body.title $body.author $body.cat }
        catch { return Send-Json $Ctx @{ error = $_.Exception.Message } 400 }
        return Send-Json $Ctx @{ book = $b }
    }

    if ($route -eq 'POST /api/queue') {
        $body = Read-Body $Ctx
        $q = Set-Queue $body.bookId $body.action
        return Send-Json $Ctx @{ queue = $q }
    }

    if ($route -eq 'POST /api/finish') {
        $body = Read-Body $Ctx
        Complete-Book $body.bookId ([int]$body.minutes)
        return Send-Json $Ctx @{ ok = $true; stats = (Get-Stats) }
    }

    if ($route -eq 'POST /api/unfinish') {
        $body = Read-Body $Ctx
        $h = Get-History
        if ($h.finished.ContainsKey($body.bookId)) {
            $h.finished.Remove($body.bookId)
            if ($h.progress.ContainsKey($body.bookId)) { $h.progress.Remove($body.bookId) }
            Save-History $h
        }
        return Send-Json $Ctx @{ ok = $true; stats = (Get-Stats) }
    }

    if ($route -eq 'GET /api/archive') {
        $h = Get-History
        $ready = Get-ReadySet
        $todayKey = Get-DateKey
        $allBooks = Get-AllBooks
        $byId = @{}; foreach ($b in $allBooks) { $byId[$b.id] = $b }

        $entries = New-Object System.Collections.ArrayList
        $seenBookIds = @{}

        # 1. Past daily entries from history.days (sorted newest to oldest)
        foreach ($k in ($h.days.Keys | Sort-Object -Descending)) {
            $d = $h.days[$k]
            $b = $byId[$d.bookId]
            if ($b) {
                $seenBookIds[$b.id] = 1
                $meta = Get-SummaryMeta $b.id
                $f = $h.finished[$b.id]
                [void]$entries.Add(@{
                    date = $k
                    assignedAt = $d.assignedAt
                    isToday = ($k -eq $todayKey)
                    book = (Get-BookView $b $h $ready)
                    finished = ($null -ne $f)
                    finishedAt = $(if ($f) { $f.finishedAt } else { $null })
                    finishedDate = $(if ($f) { $f.date } else { $null })
                    summary = @{
                        ready = $ready.ContainsKey($b.id)
                        words = $meta.words
                        minutes = $meta.minutes
                        model = $meta.model
                    }
                })
            }
        }

        # 2. Also include any generated summaries or finished books not in days
        foreach ($id in $ready.Keys) {
            if (-not $seenBookIds.ContainsKey($id)) {
                $b = $byId[$id]
                if ($b) {
                    $seenBookIds[$id] = 1
                    $meta = Get-SummaryMeta $id
                    $f = $h.finished[$id]
                    [void]$entries.Add(@{
                        date = $(if ($f) { $f.date } else { "Archive" })
                        assignedAt = $null
                        isToday = $false
                        book = (Get-BookView $b $h $ready)
                        finished = ($null -ne $f)
                        finishedAt = $(if ($f) { $f.finishedAt } else { $null })
                        finishedDate = $(if ($f) { $f.date } else { $null })
                        summary = @{
                            ready = $true
                            words = $meta.words
                            minutes = $meta.minutes
                            model = $meta.model
                        }
                    })
                }
            }
        }

        # Stats for Archive header
        $completedCount = 0
        foreach ($e in $entries) { if ($e.finished) { $completedCount++ } }
        $totalCount = $entries.Count
        $rate = 0
        if ($totalCount -gt 0) { $rate = [Math]::Round(($completedCount / $totalCount) * 100) }

        return Send-Json $Ctx @{
            entries = $entries
            totalCount = $totalCount
            completedCount = $completedCount
            pendingCount = ($totalCount - $completedCount)
            completionRate = $rate
        }
    }

    if ($route -eq 'POST /api/progress') {
        $body = Read-Body $Ctx
        Set-Progress $body.bookId ([double]$body.pct)
        return Send-Json $Ctx @{ ok = $true }
    }

    if ($route -eq 'GET /api/stats') { return Send-Json $Ctx (Get-Stats) }

    if ($route -eq 'POST /api/generate') {
        $body = Read-Body $Ctx
        if (-not (Test-HasApiKey)) { return Send-Json $Ctx @{ error = 'No Gemini API key yet. Add one in Settings or run: dailyread set-key YOUR_KEY' } 400 }
        Start-BackgroundGenerate $body.bookId -Force:([bool]$body.force)
        return Send-Json $Ctx (Get-SummaryStatus $body.bookId)
    }

    if ($method -eq 'GET' -and $path -match '^/api/status/([a-z0-9\-]+)$') {
        return Send-Json $Ctx (Get-SummaryStatus $matches[1])
    }

    if ($method -eq 'GET' -and $path -match '^/api/summary/([a-z0-9\-]+)\.md$') {
        $id = $matches[1]; $p = Get-SummaryPath $id
        if (-not (Test-Path $p)) { return Send-Json $Ctx @{ error = 'Not generated yet' } 404 }
        return Send-Bytes $Ctx ([IO.File]::ReadAllBytes($p)) 'text/markdown; charset=utf-8' 200 @{ 'Content-Disposition' = "attachment; filename=`"$id.md`"" }
    }

    if ($method -eq 'GET' -and $path -match '^/api/summary/([a-z0-9\-]+)$') {
        $id = $matches[1]
        $book = Get-BookById $id
        if (-not $book) { return Send-Json $Ctx @{ error = 'Unknown book' } 404 }
        $h = Get-History; $ready = Get-ReadySet
        $p = Get-SummaryPath $id
        $md = $null
        if (Test-Path $p) { $md = Read-TextFile $p }
        $s = Get-Settings
        return Send-Json $Ctx @{ book = (Get-BookView $book $h $ready); markdown = $md; status = (Get-SummaryStatus $id); meta = (Get-SummaryMeta $id); wpm = $s.wpm }
    }

    if ($path -match '^/api/highlights/([a-z0-9\-]+)(/delete)?$') {
        $id = $matches[1]; $isDelete = [bool]$matches[2]
        if ($method -eq 'GET') { return Send-Json $Ctx @{ highlights = (Get-Highlights $id) } }
        $body = Read-Body $Ctx
        if ($isDelete) { Remove-Highlight $id $body.hid } else { $null = Add-Highlight $id $body.text $body.note }
        return Send-Json $Ctx @{ highlights = (Get-Highlights $id) }
    }

    if ($route -eq 'GET /api/courses') {
        $coursesDir = Join-Path $script:DataDir 'courses'
        $courseList = @()
        if (Test-Path $coursesDir) {
            Get-ChildItem -Path $coursesDir -Filter '*.json' | ForEach-Object {
                try {
                    $jsonContent = Get-Content -Path $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                    $courseList += $jsonContent
                } catch { }
            }
        }
        $h = Get-History
        $finished = if ($h.finished) { $h.finished } else { @{} }
        $ready = Get-ReadySet

        $resultList = @()
        foreach ($c in $courseList) {
            $books = if ($c.books) { $c.books } else { @() }
            $totalBooks = $books.Count
            $completedCount = 0
            $booksView = @()
            foreach ($b in $books) {
                $bId = $b.bookId
                $isDone = [bool]($finished.ContainsKey($bId))
                if ($isDone) { $completedCount++ }
                $bCopy = @{}
                foreach ($prop in $b.PSObject.Properties) { $bCopy[$prop.Name] = $prop.Value }
                $bCopy['id'] = $bId
                $bCopy['isFinished'] = $isDone
                $bCopy['summaryReady'] = [bool]($ready.ContainsKey($bId))
                $booksView += $bCopy
            }
            $percent = if ($totalBooks -gt 0) { [Math]::Round(($completedCount / $totalBooks) * 100) } else { 0 }
            
            $cCopy = @{}
            foreach ($prop in $c.PSObject.Properties) {
                if ($prop.Name -ne 'books') { $cCopy[$prop.Name] = $prop.Value }
            }
            $cCopy['totalBooks'] = $totalBooks
            $cCopy['completedCount'] = $completedCount
            $cCopy['percentComplete'] = $percent
            $cCopy['isCompleted'] = ($completedCount -ge $totalBooks)
            $cCopy['books'] = $booksView
            $resultList += $cCopy
        }
        return Send-Json $Ctx @{ courses = $resultList }
    }

    if ($route -eq 'GET /api/settings') {
        return Send-Json $Ctx @{ settings = (Get-Settings); task = (Get-TaskInfo); hasKey = (Test-HasApiKey) }
    }

    if ($route -eq 'POST /api/settings') {
        $body = Read-Body $Ctx
        $s = Get-Settings
        foreach ($k in @('notifyTime','days','fictionRatio','summaryMinutes','wpm','weights','browserNotify','model','email')) {
            if ($body.ContainsKey($k)) { $s[$k] = $body[$k] }
        }
        if ($s.notifyTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { return Send-Json $Ctx @{ error = 'Time must be HH:mm' } 400 }
        Save-Settings $s
        $task = $null; $taskError = $null
        if ($body.ContainsKey('notifyTime') -or $body.ContainsKey('days')) {
            try { $task = Register-DailyTask } catch { $taskError = $_.Exception.Message }
        }
        if (-not $task) { $task = Get-TaskInfo }
        return Send-Json $Ctx @{ settings = $s; task = $task; taskError = $taskError; hasKey = (Test-HasApiKey) }
    }

    if ($route -eq 'POST /api/settings/key') {
        $body = Read-Body $Ctx
        if (-not $body.key) { return Send-Json $Ctx @{ error = 'Key is empty' } 400 }
        Set-ApiKey $body.key
        return Send-Json $Ctx @{ ok = $true; hasKey = (Test-HasApiKey) }
    }

    if ($route -eq 'POST /api/test-notification') {
        $entry = Get-DayEntry
        $b = Get-BookById $entry.bookId
        $ok = Show-Toast 'DailyRead test notification' "Today's read: $($b.title) by $($b.author)" "$($script:BaseUrl)/#/today"
        return Send-Json $Ctx @{ ok = $ok }
    }

    if ($route -eq 'POST /api/test-email') {
        $body = Read-Body $Ctx
        $entry = Get-DayEntry
        $b = Get-BookById $entry.bookId
        try {
            $target = $body.targetEmail
            $incSummary = if ($body.ContainsKey('includeFullSummary')) { [bool]$body.includeFullSummary } else { $true }
            $res = Send-DailyEmail -Book $b -TargetEmail $target -IncludeFullSummary:$incSummary
            return Send-Json $Ctx @{ ok = $true; result = $res }
        } catch {
            return Send-Json $Ctx @{ error = $_.Exception.Message } 400
        }
    }

    if ($path.StartsWith('/api/')) { return Send-Json $Ctx @{ error = "No route: $route" } 404 }

    # ----- static files -----
    $rel = $path.TrimStart('/')
    if (-not $rel) { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $script:PublicDir $rel))
    if (-not $full.StartsWith($script:PublicDir, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
        return Send-Bytes $Ctx ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain' 404
    }
    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    $type = $script:Mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
    Send-Bytes $Ctx ([IO.File]::ReadAllBytes($full)) $type
}

# C# Bridge for zero-admin mobile Wi-Fi access (bypasses Windows HTTP.sys URL reservation requirement)
$bridgeCode = @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace DailyReadBridge {
    public class HttpBridge {
        private TcpListener _listener;
        private int _targetPort;
        private bool _running;

        public HttpBridge(int listenPort, int targetPort) {
            _listener = new TcpListener(IPAddress.Any, listenPort);
            _targetPort = targetPort;
        }

        public void Start() {
            _running = true;
            _listener.Start();
            Task.Run(async () => {
                while (_running) {
                    try {
                        var client = await _listener.AcceptTcpClientAsync();
                        var ignored = HandleClient(client);
                    } catch { if (!_running) break; }
                }
            });
        }

        private async Task HandleClient(TcpClient client) {
            using (client) {
                try {
                    using (var target = new TcpClient()) {
                        await target.ConnectAsync(IPAddress.Loopback, _targetPort);
                        var clientStream = client.GetStream();
                        var targetStream = target.GetStream();

                        var pipeTargetToClient = targetStream.CopyToAsync(clientStream);

                        byte[] buffer = new byte[32768];
                        int read;
                        while ((read = await clientStream.ReadAsync(buffer, 0, buffer.Length)) > 0) {
                            byte[] toSend = buffer;
                            int toSendLen = read;

                            string peek = Encoding.ASCII.GetString(buffer, 0, Math.Min(read, 16));
                            if (peek.StartsWith("GET ") || peek.StartsWith("POST") || peek.StartsWith("HEAD") || peek.StartsWith("OPTI")) {
                                string full = Encoding.ASCII.GetString(buffer, 0, read);
                                string mod = Regex.Replace(full, @"(?i)Host:\s*[^\r\n]+", "Host: localhost:" + _targetPort);
                                toSend = Encoding.ASCII.GetBytes(mod);
                                toSendLen = toSend.Length;
                            }
                            await targetStream.WriteAsync(toSend, 0, toSendLen);
                        }

                        await pipeTargetToClient;
                    }
                } catch { }
            }
        }

        public void Stop() {
            _running = false;
            try { _listener.Stop(); } catch {}
        }
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'DailyReadBridge.HttpBridge').Type) {
    Add-Type -TypeDefinition $bridgeCode -Language CSharp
}

# ----- main loop -----
$listener = New-Object System.Net.HttpListener
$script:IsNetworkListening = $false
$script:Bridge = $null

try {
    # If the user has urlacl or admin, bind directly to all interfaces on 4747
    $listener.Prefixes.Add("http://+:$($script:Port)/")
    $listener.Start()
    $script:IsNetworkListening = $true
} catch {
    # Non-admin fallback: Bind HttpListener to local loopback 4746, and run HttpBridge on 0.0.0.0:4747
    $internalPort = 4746
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$internalPort/")
    try {
        $listener.Start()
        $script:Bridge = New-Object DailyReadBridge.HttpBridge($script:Port, $internalPort)
        $script:Bridge.Start()
        $script:IsNetworkListening = $true
    } catch {
        Write-Host "Could not start DailyRead on port $($script:Port): $($_.Exception.Message)" -ForegroundColor Red; exit 1
    }
}
Write-TextFile $script:PidPath "$PID"
Write-Host "DailyRead is running at $($script:BaseUrl)/  (Ctrl+C to stop)" -ForegroundColor Green
if ($script:IsNetworkListening) {
    $ip = Get-LocalIp
    Write-Host "  Mobile Phone URL: http://${ip}:$($script:Port)/" -ForegroundColor Cyan
}

try {
    while ($listener.IsListening -and -not $script:StopServer) {
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(500)) { if ($script:StopServer) { break } }
        if (-not $task.IsCompleted) { continue }
        $ctx = $task.Result
        try { Invoke-Route $ctx }
        catch {
            Write-Host "[error] $($_.Exception.Message)" -ForegroundColor Yellow
            try { Send-Json $ctx @{ error = $_.Exception.Message } 500 } catch { }
        }
    }
} finally {
    if ($script:Bridge) { $script:Bridge.Stop() }
    $listener.Stop()
    $listener.Close()
    Remove-Item $script:PidPath -Force -ErrorAction SilentlyContinue
}
