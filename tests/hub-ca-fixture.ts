/**
 * Two throwaway CA certificates for the certificate tests.
 *
 * Committed on purpose: the tests have to run real DER through the platform
 * parser, and a certificate carries no secret — these two were minted with
 * `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1` and
 * their private keys were discarded with the temporary directory that made
 * them. Nothing here is usable as an anchor anywhere.
 */

/** `CN=dsh-test-alpha-ca` — the "configured" certificate in most cases. */
export const ALPHA_CA_BASE64 = 'MIICNTCCAdygAwIBAgIJAPagw1PCrW2uMAoGCCqGSM49BAMCMBwxGjAYBgNVBAMMEWRzaC10ZXN0LWFscGhhLWNhMB4XDTI2MDkzMDA4MDQxNFoXDTM2MDkyNzA4MDQxNFowHDEaMBgGA1UEAwwRZHNoLXRlc3QtYWxwaGEtY2EwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEmmZLiD6mlPE6dkakKqpJpcOF6gCiy4ma0EvgCadBMGP502/Lkbhy1if8gNQiRzYVJVH+vEzLql6o+v7J25IfcKMTMBEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBvNdyN7StizY+aJqd4tN9vrii3taNSZZ06ExgrcprHBAIgEVhHFPriHJRpXuh42Tj5+5s/KaHlKSWuxfePShbA51Q='

export const ALPHA_CA_FINGERPRINT = '04:5E:2C:22:20:1A:9C:6C:E5:01:A4:42:B2:1C:ED:97:D9:C9:A9:7E:02:1B:34:42:FD:D5:A7:BE:9D:D0:1C:29'

/** `CN=dsh-test-beta-ca` — a real certificate that is simply not the Hub's. */
export const BETA_CA_BASE64 = 'MIICNDCCAdqgAwIBAgIJAOlMeVDHzf/aMAoGCCqGSM49BAMCMBsxGTAXBgNVBAMMEGRzaC10ZXN0LWJldGEtY2EwHhcNMjYwOTMwMDgwNDE0WhcNMzYwOTI3MDgwNDE0WjAbMRkwFwYDVQQDDBBkc2gtdGVzdC1iZXRhLWNhMIIBSzCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBA0IABL1Y4C83CFzbXv6QrjxHDhZriw6pLvYykuA1vfOnM19Rb1qGK0wXFnz7XsMeImdmxppnMXSeen7CUfToSQhPrQKjEzARMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANy5Wlw4rACOaDYnbTItBpaTXV7o2EcoluQpA84/SCOEAiAxpU8fSRouIdb8B3AEDE+R2rdrhEcVdo6igeOP5a8k6A=='

export const BETA_CA_FINGERPRINT = '61:49:3F:1A:9A:86:87:80:D8:E8:CA:80:AB:FC:29:98:A6:71:8C:0E:91:22:AF:C2:9E:2B:88:F8:EE:95:74:9A'

/**
 * `CN=dsh-test-hub-leaf` — what a Hub that sends its leaf alone hands over.
 *
 * `basicConstraints CA:FALSE`, so it is a server certificate and not an
 * anchor: the fetch has to report it rather than fill the field with it three
 * lines before the phone would have rejected it.
 */
export const HUB_LEAF_BASE64 = 'MIICQzCCAeqgAwIBAgIJANYeJcP/AfvfMAoGCCqGSM49BAMCMBwxGjAYBgNVBAMMEWRzaC10ZXN0LWh1Yi1sZWFmMB4XDTI2MTAwNTEwMDU1OFoXDTM2MTAwMjEwMDU1OFowHDEaMBgGA1UEAwwRZHNoLXRlc3QtaHViLWxlYWYwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEQMCxTr/vfEqbUwKp47WrRCEA8bDjT50QN3zxU6DjUZ1rIm/Us1dupChSWXrdpXV+bwO3eSETsXKtbaCOf0un5aMhMB8wDAYDVR0TAQH/BAIwADAPBgNVHREECDAGhwTLAHEKMAoGCCqGSM49BAMCA0cAMEQCIGCYfjgDq5889oNnK9+psqEmlxIYc9MjkKr/uFNttthPAiAXvPl0dd2j+Q1bFGjZ4Ye5arBbgZuT3+4nkhZuwI4w6g=='

export const HUB_LEAF_FINGERPRINT = '6E:99:76:BD:01:4C:C0:A2:5F:CB:71:DE:B0:19:76:DE:D5:24:5B:DE:00:6B:9E:AC:AE:A1:58:5F:6A:51:21:6E'

/** The same DER, wrapped the way `ca.crt` comes off an OpenSSL run. */
export function asPem(base64: string): string {
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}
