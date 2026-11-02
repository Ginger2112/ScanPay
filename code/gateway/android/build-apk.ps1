# Builds the Scantopay Observer debug APK on a fresh Windows PC.
# Installs JDK 17, Android SDK (cmdline-tools, platform 34, build-tools) and Gradle
# into one folder (no system-wide install), then runs `gradle assembleDebug`.
# Re-running skips anything already downloaded.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest far faster on PS 5.1

$tools = Join-Path $env:USERPROFILE 'scantopay-buildtools'
$sdk   = Join-Path $tools 'sdk'
$proj  = $PSScriptRoot
$out   = Join-Path $proj '..\public\scantopay-observer.apk'
New-Item -ItemType Directory -Force -Path $tools, $sdk | Out-Null

function Get-Zip($url, $zip, $dest) {
  if (-not (Test-Path $zip)) {
    Write-Host ">> downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
  if (-not (Test-Path $dest)) {
    Write-Host ">> extracting $zip"
    Expand-Archive -Path $zip -DestinationPath $dest -Force
  }
}

# 1. JDK 17 (Eclipse Temurin)
Get-Zip 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' `
        (Join-Path $tools 'jdk17.zip') (Join-Path $tools 'jdk17')
$jdk = (Get-ChildItem (Join-Path $tools 'jdk17') -Directory | Select-Object -First 1).FullName
Write-Host ">> JDK: $jdk"

# 2. Android command-line tools -> sdk\cmdline-tools\latest
$latest = Join-Path $sdk 'cmdline-tools\latest'
if (-not (Test-Path (Join-Path $latest 'bin\sdkmanager.bat'))) {
  Get-Zip 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' `
          (Join-Path $tools 'cmdline-tools.zip') (Join-Path $tools 'cmdline-tmp')
  New-Item -ItemType Directory -Force -Path (Split-Path $latest) | Out-Null
  Move-Item (Join-Path $tools 'cmdline-tmp\cmdline-tools') $latest -Force
}
$sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'

# 3. Gradle
Get-Zip 'https://services.gradle.org/distributions/gradle-8.7-bin.zip' `
        (Join-Path $tools 'gradle.zip') (Join-Path $tools 'gradle')
$gradle = Join-Path $tools 'gradle\gradle-8.7\bin\gradle.bat'

# Environment for this build
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
# JDK 17 on Windows fails with "Unable to establish loopback connection" when TEMP is long
# or sandboxed. A short temp folder fixes it.
$short = 'C:\Users\Public\sotmp'
New-Item -ItemType Directory -Force -Path $short | Out-Null
$env:TEMP = $short; $env:TMP = $short
$env:JAVA_TOOL_OPTIONS = "-Djdk.net.unixdomain.tmpdir=$short -Djava.io.tmpdir=$short"
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$env:Path"

# 4. SDK packages + licenses
Write-Host '>> accepting Android SDK licenses'
$yes = ('y' + [Environment]::NewLine) * 40
$yes | & $sdkmanager --sdk_root=$sdk --licenses | Out-Null
Write-Host '>> installing platform 34 + build-tools'
& $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' | Out-Null

# 5. Point the project at this SDK and build
"sdk.dir=$($sdk -replace '\\','/')" | Set-Content -Encoding ASCII (Join-Path $proj 'local.properties')
Write-Host '>> building APK (first build downloads Android Gradle Plugin, a few minutes)'
& $gradle -p $proj assembleDebug --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)" }

$apk = Join-Path $proj 'app\build\outputs\apk\debug\app-debug.apk'
Copy-Item $apk $out -Force
Write-Host ">> DONE. APK: $((Resolve-Path $out).Path)"
