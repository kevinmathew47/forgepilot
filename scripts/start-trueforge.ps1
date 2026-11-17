$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root ".trueforge"
New-Item -ItemType Directory -Force $dataDir | Out-Null

$env:SQLITE_PATH = Join-Path $dataDir "trueforge.sqlite"
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
$env:MODEL_HTTP_HEADERS_TIMEOUT_MS = "180000"
$env:MODEL_HTTP_BODY_TIMEOUT_MS = "300000"
$env:MCP_REQUEST_TIMEOUT_MS = "600000"
if (-not $env:PORT) { $env:PORT = "8790" }

npx -y @truefoundry/trueforge@latest
