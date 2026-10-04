# capture-desktop.ps1 — screenshot the interactive desktop and report whether the image is real.
#
# Why this exists: the owner asked "can it really be used like a normal browser window?", and the
# only honest answer is a picture of the window. This helper is deliberately paranoid about the
# difference between a real capture and a black frame, because a black PNG uploaded as "evidence"
# is worse than no evidence at all.
#
# It is also the diagnostic that decides whether a GitHub-hosted Windows runner has an interactive
# desktop at all: run it *before* a browser starts and the answer is unambiguous.
#
# stdout: one line of human context, then exactly one JSON object as the last line.
# exit  : 1 when the image is blank and -AllowBlank was not given, 0 otherwise.
#
# Usage:
#   pwsh -NoProfile -File scripts/capture-desktop.ps1 -Path out/desktop.png
#   pwsh -NoProfile -File scripts/capture-desktop.ps1 -Path out/window.png -Rect 100,80,1440,900
#   pwsh -NoProfile -File scripts/capture-desktop.ps1 -Path out/window.png -CropToProcessName camoufox.exe
#   pwsh -NoProfile -File scripts/capture-desktop.ps1 -Path out/baseline.png -AllowBlank
#
# `-Rect 'x,y,width,height'` is the precise path: the caller already has the window's own
# GetWindowRect, so there is no ambiguity about which process or which of its windows is meant.
# `-CropToProcessName` is the fallback and looks the rect up via the process's MainWindowHandle.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Rect,
    [string]$CropToProcessName,
    [switch]$AllowBlank
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Session facts first: these distinguish "the capture is black because there is no desktop" from
# "the capture is black because the browser never appeared".
Write-Host "[capture] UserInteractive : $([Environment]::UserInteractive)"
Write-Host "[capture] SessionId       : $((Get-Process -Id $PID).SessionId)"
$explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count
Write-Host "[capture] explorer.exe    : $explorer process(es)"

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$source = $screen
$origin = 'virtual screen'

# An explicit rect beats a process-name lookup: the caller already has the window's own
# GetWindowRect, so there is no ambiguity about which process or which of its windows is meant.
# It is also the only crop path that can be exercised on a machine where no process exposes a
# MainWindowHandle, which is why it is preferred.
if ($Rect) {
    $parts = @($Rect -split ',' | ForEach-Object { $_.Trim() })
    if ($parts.Count -ne 4) {
        throw "-Rect needs 'x,y,width,height'; got '$Rect'"
    }
    $numbers = @()
    foreach ($part in $parts) {
        $value = 0
        if (-not [int]::TryParse($part, [ref]$value)) { throw "-Rect needs four integers; got '$Rect'" }
        $numbers += $value
    }
    if ($numbers[2] -le 0 -or $numbers[3] -le 0) {
        throw "-Rect needs a positive width and height; got '$Rect'"
    }

    $wanted = [System.Drawing.Rectangle]::new($numbers[0], $numbers[1], $numbers[2], $numbers[3])
    # A window can hang off the edge of the desktop; CopyFromScreen on a region outside the
    # virtual screen returns black for the outside part, so intersect and say so.
    $clipped = [System.Drawing.Rectangle]::Intersect($wanted, $screen)
    if ($clipped.Width -le 0 -or $clipped.Height -le 0) {
        throw "-Rect $Rect does not overlap the virtual screen $($screen.Width)x$($screen.Height) at $($screen.X),$($screen.Y)"
    }
    $source = $clipped
    $origin = "rect $($numbers[0]),$($numbers[1]),$($numbers[2]),$($numbers[3])"
    if ($clipped -ne $wanted) {
        $origin += " clipped to $($clipped.X),$($clipped.Y),$($clipped.Width),$($clipped.Height)"
    }
}

if (-not $Rect -and $CropToProcessName) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public struct VFoxRect { public int Left; public int Top; public int Right; public int Bottom; }

public static class VFoxWin32 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out VFoxRect rect);
}
'@

    # `Get-Process -Name` does not accept the `.exe` suffix — `-Name pwsh.exe` finds nothing while
    # `-Name pwsh` finds two processes here — and callers naturally pass `camoufox.exe`. Stripping
    # it is what makes the crop actually happen instead of silently falling back to the whole screen.
    $processName = $CropToProcessName -replace '\.exe$', ''

    if ([string]::IsNullOrWhiteSpace($processName)) {
        # `Get-Process -Name ''` is a parameter-binding error, not a lookup miss, so it has to be
        # guarded rather than caught by -ErrorAction.
        Write-Host "[capture] -CropToProcessName '$CropToProcessName' names no process; using the whole screen"
    }
    else {
        $target = Get-Process -Name $processName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
            Select-Object -First 1

        if ($null -eq $target) {
            Write-Host "[capture] no visible '$processName' window; falling back to the whole screen"
        }
        else {
            $rect = [VFoxRect]::new()
            if ([VFoxWin32]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
                $width = $rect.Right - $rect.Left
                $height = $rect.Bottom - $rect.Top
                if ($width -gt 0 -and $height -gt 0) {
                    $source = [System.Drawing.Rectangle]::new($rect.Left, $rect.Top, $width, $height)
                    $origin = "$processName window (pid $($target.Id))"
                }
            }
        }
    }
}

Write-Host "[capture] capturing $origin -> $($source.Width)x$($source.Height)"

$bitmap = [System.Drawing.Bitmap]::new($source.Width, $source.Height)
try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($source.Location, [System.Drawing.Point]::Empty, $source.Size)
    }
    finally {
        $graphics.Dispose()
    }

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    # Sample a grid rather than every pixel: enough to tell a desktop from a black frame.
    $step = [Math]::Max(1, [int]($source.Width / 96))
    $sampled = 0
    $nonBlack = 0
    $colors = [System.Collections.Generic.HashSet[int]]::new()
    for ($y = 0; $y -lt $bitmap.Height; $y += $step) {
        for ($x = 0; $x -lt $bitmap.Width; $x += $step) {
            $pixel = $bitmap.GetPixel($x, $y)
            $sampled++
            if ($pixel.R -gt 8 -or $pixel.G -gt 8 -or $pixel.B -gt 8) { $nonBlack++ }
            [void]$colors.Add(($pixel.R -shl 16) -bor ($pixel.G -shl 8) -bor $pixel.B)
        }
    }
}
finally {
    $bitmap.Dispose()
}

$fraction = if ($sampled -gt 0) { [Math]::Round($nonBlack / $sampled, 4) } else { 0 }
# One or two distinct colours across the whole sample is a blank frame, not a desktop. A real
# desktop has hundreds even when it is mostly a dark terminal.
$blank = $colors.Count -le 2 -or $fraction -lt 0.01

$result = [ordered]@{
    path             = (Resolve-Path $Path).Path
    width            = $source.Width
    height           = $source.Height
    bytes            = (Get-Item $Path).Length
    origin           = $origin
    sampledPixels    = $sampled
    nonBlackFraction = $fraction
    distinctColors   = $colors.Count
    blank            = $blank
}
Write-Host "[capture] $($result.distinctColors) distinct colours, non-black $fraction, blank=$blank"

if ($blank -and -not $AllowBlank) {
    Write-Host '##[error]the captured desktop is blank — a real window did not appear, or this runner has no interactive desktop'
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 1
}

Write-Output ($result | ConvertTo-Json -Compress)
exit 0
