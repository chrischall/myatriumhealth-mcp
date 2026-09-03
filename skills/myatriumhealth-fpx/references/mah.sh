# MyAtriumHealth (Epic MyChart) helpers — source this file.
#   source references/mah.sh
# Data goes to stdout; pair codes and status to stderr. Works under bash and zsh.

MAH_PROFILE="${MAH_PROFILE:-myatriumhealth}"
MAH_BASE="https://my.atriumhealth.org/myatriumhealth"

# Fetch a page through the signed-in tab. $1 = path under /myatriumhealth.
mah_page() { fpx get "$MAH_BASE/${1#/}" -p "$MAH_PROFILE"; }

# True (0) when the session is alive. MyChart answers an EXPIRED session with
# HTTP 200 whose body is the login page, so status codes cannot be trusted here.
mah_signed_in() {
  mah_page "Home" 2>/dev/null | grep -q '<title>MyAtriumHealth - Login Page' && return 1
  return 0
}

# The 172-char ASP.NET antiforgery token from any signed-in page. Cache it:
#   export MAH_TOKEN="$(mah_token)"
mah_token() {
  { [ -n "$MAH_TOKEN" ] && printf %s "$MAH_TOKEN" && return 0; } 2>/dev/null
  mah_page "Home" 2>/dev/null \
    | perl -ne 'if (/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) { print $1; exit }'
}

# The page CSP nonce ($$WPUtil.GetPageNonce), needed by the conversations
# endpoints. Only /app/* SPA pages carry one, and it is SINGLE-quoted.
# $1 = an /app/... path, e.g. app/communication-center
mah_nonce() {
  mah_page "${1:-app/communication-center}" 2>/dev/null \
    | perl -ne "if (/id='cspScripts'[^>]*nonce='([0-9a-f]{32})'/ || /id=\"cspScripts\"[^>]*nonce=\"([0-9a-f]{32})\"/) { print \$1 || \$2; exit }"
}

# mah_api <area/Action> [json-body]   — modern JSON endpoints. Default body {}.
mah_api() {
  local ep="$1" body="${2:-{\}}" tok
  tok="$(mah_token)"
  if [ -z "$tok" ]; then
    echo "no antiforgery token — sign in to MyAtriumHealth in Chrome, then retry" >&2
    return 2
  fi
  fpx request "$MAH_BASE/api/$ep" -p "$MAH_PROFILE" -X POST \
    -H "__RequestVerificationToken: $tok" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# mah_legacy <Area/Controller/Action> [querystring] — older form-encoded endpoints.
mah_legacy() {
  local ep="$1" qs="$2" tok
  tok="$(mah_token)"
  [ -n "$tok" ] || { echo "no antiforgery token — sign in first" >&2; return 2; }
  fpx request "$MAH_BASE/$ep?${qs}${qs:+&}noCache=0.$RANDOM" -p "$MAH_PROFILE" -X POST \
    -H "__RequestVerificationToken: $tok" \
    -H "X-Requested-With: XMLHttpRequest" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d ''
}
