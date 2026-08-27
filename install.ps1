$ErrorActionPreference = "Stop"

$repository = "https://github.com/visnia-ai/invoice-fetcher"
$installDirectory = if ($env:INSTALL_DIR) {
    $env:INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA "Programs\invoice-fetcher"
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($architecture -ne "X64") {
    throw "The Windows installer currently supports only x64 systems."
}

$release = Invoke-RestMethod "https://api.github.com/repos/visnia-ai/invoice-fetcher/releases/latest"
$tag = [string]$release.tag_name
if ($tag -notmatch '^v[0-9]') {
    throw "Could not determine the latest release."
}

$version = $tag.Substring(1)
$archive = "invoice-fetcher-$version-windows-x64.zip"
$downloadUrl = "$repository/releases/download/$tag"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())

try {
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $archivePath = Join-Path $temporaryDirectory $archive
    $checksumPath = "$archivePath.sha256"

    Invoke-WebRequest "$downloadUrl/$archive" -OutFile $archivePath
    Invoke-WebRequest "$downloadUrl/$archive.sha256" -OutFile $checksumPath

    $expectedChecksum = ((Get-Content $checksumPath -Raw).Trim() -split '\s+')[0]
    $actualChecksum = (Get-FileHash $archivePath -Algorithm SHA256).Hash
    if ($actualChecksum -ne $expectedChecksum) {
        throw "The downloaded archive failed SHA-256 verification."
    }

    Expand-Archive $archivePath -DestinationPath $temporaryDirectory
    New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
    Copy-Item (Join-Path $temporaryDirectory "invoice-fetcher.exe") `
        (Join-Path $installDirectory "invoice-fetcher.exe") -Force

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @($userPath -split ';' | Where-Object { $_ })
    if ($pathEntries -notcontains $installDirectory) {
        $updatedPath = (@($pathEntries) + $installDirectory) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
    }

    Write-Host "Installed invoice-fetcher to $installDirectory\invoice-fetcher.exe"
    Write-Host "Open a new terminal, then run: invoice-fetcher --version"
} finally {
    if (Test-Path $temporaryDirectory) {
        Remove-Item -Recurse -Force $temporaryDirectory
    }
}
