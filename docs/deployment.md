# Deploying Updraft

## TLS is not optional

iOS App Transport Security blocks cleartext HTTP in release builds. A physical
device will not fetch an update over `http://`, so a production deployment must
be served over HTTPS. (The simulator reaches a local server because the example
app carries an ATS exception for `localhost` — that exception is for
development and has no place in a shipped app.)

Put a reverse proxy in front of the container and let it terminate TLS.

### Caddy

```
ota.example.com {
	reverse_proxy localhost:3000
}
```

Caddy obtains and renews certificates automatically. That is the whole config.

### Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.updraft.rule=Host(`ota.example.com`)
  - traefik.http.routers.updraft.tls.certresolver=letsencrypt
  - traefik.http.services.updraft.loadbalancer.server.port=3000
```

### Behind a proxy, set TRUST_PROXY

```bash
TRUST_PROXY=1
```

Without it every request appears to come from the proxy, so the rate limiter
sees one client and throttles everyone together. With it, `X-Forwarded-For` is
trusted — which is correct behind a proxy that overwrites the header, and a
limiter bypass if the server is also reachable directly. Do not set it on a
directly-exposed server.

## Endpoints and who should reach them

| Path | Auth | Exposure |
| --- | --- | --- |
| `/api/manifest/*`, `/assets/*` | none | public — this is the device path |
| `/api/admin/*` | bearer token | public is fine; consider restricting anyway |
| `/metrics` | bearer token | restrict to your monitoring network |
| `/healthz` | none | internal |
| `/readyz` | none | internal |

`/healthz` and `/readyz` reveal little, but neither needs to be on the public
internet. Blocking them at the proxy costs nothing.

### Liveness versus readiness

They are not interchangeable:

- **`/healthz`** answers "is this process alive". It never touches a
  dependency. Use it for the container `HEALTHCHECK` and for liveness probes.
  Pointing liveness at a dependency-aware endpoint means an object-store
  outage restarts your servers, which cannot help and usually makes things
  worse.
- **`/readyz`** answers "can this process serve". It probes the database and
  the object store, returns 503 when either is unavailable, and is the right
  target for load-balancer and orchestrator readiness.

Readiness answers are cached for a few seconds and single-flighted, because the
endpoint is necessarily unauthenticated: without that, one HTTP request would
become one billed object-store request at whatever rate a caller chose.

## Object storage

```bash
STORAGE_DRIVER=s3
S3_BUCKET=updraft-updates
S3_REGION=us-east-1
```

For anything other than AWS, set an endpoint. Path-style addressing turns on
automatically when one is present, which is what these services need:

```bash
# MinIO
S3_ENDPOINT=http://minio:9000
# Cloudflare R2
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
# Backblaze B2
S3_ENDPOINT=https://s3.<region>.backblazeb2.com
```

Prefer an IAM role or instance profile and leave `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY` unset. Setting exactly one of the pair is a boot error:
the AWS credential chain would otherwise fall back to ambient credentials and
write into whatever bucket those reach.

### Bucket policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::updraft-updates/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::updraft-updates"
    }
  ]
}
```

`s3:ListBucket` is required and easy to omit. Without it S3 answers a request
for a missing object with `403` rather than `404`, and this server treats a
`403` as a failure rather than an absence — deliberately, since a permissions
mistake must not look like an empty bucket. The symptom of omitting it is
publishing that errors instead of deduplicating.

### Serving assets from a CDN

Point a CDN at the bucket and set:

```bash
ASSETS_BASE_URL=https://cdn.example.com
```

New manifests then address assets there. The path is the object's storage key,
so `assets/<sha256>` must resolve at that origin. Assets are content-addressed
and immutable, so they can be cached indefinitely.

For a public-read bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": ["*"] },
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::updraft-updates/*"
    }
  ]
}
```

The server keeps serving assets itself regardless. Devices already hold
manifests addressed to `PUBLIC_URL`, and turning the proxy off would break
every update mid-download.

## Monitoring

`/metrics` is Prometheus text behind the publish token:

```yaml
scrape_configs:
  - job_name: updraft
    authorization:
      credentials: <PUBLISH_TOKEN>
    static_configs:
      - targets: ['updraft:3000']
```

Worth alerting on:

- `updraft_dependency_up == 0` — a dependency failed its last probe
- `rate(updraft_storage_operations_total{result="error"}[5m])` — storage
  errors, as distinct from `missing`, which is a normal absent key
- `rate(updraft_http_requests_total{status=~"5.."}[5m])`
- `updraft_asset_bytes_sent_total` — if this is large, `ASSETS_BASE_URL` will
  move that traffic off the server

Label sets are deliberately bounded. App slugs, channels, runtime versions,
update ids and client addresses are **never** used as labels: several come
straight from request input, and a label taken from request input lets anyone
create unbounded time series until the process runs out of memory.

## Backups

Two things hold state: the SQLite database and the blob store.

```bash
sqlite3 /data/db.sqlite "VACUUM INTO '/backup/db-$(date +%F).sqlite'"
```

Do not copy the database file with `cp` while the server is running. It runs in
WAL mode, so a plain file copy can capture a torn state with its
write-ahead log missing. `VACUUM INTO` (or `.backup`) is safe on a live
database.

Blobs are content-addressed and immutable, so any incremental sync works —
object storage versioning or lifecycle rules cover it for S3.

## Rate limits

Admin and metrics routes allow 600 requests per minute per client by default:

```bash
RATE_LIMIT_ADMIN_MAX=600
RATE_LIMIT_WINDOW_SECONDS=60
```

A real Metro export uploads tens of assets, so this never troubles a legitimate
publish. Device paths are deliberately unlimited: a release wave has every
client checking in at once, and answering that with 429s would be a
self-inflicted outage at the moment the system matters most. If the device path
ever needs protection, shape it at the reverse proxy rather than cliff-edging
it here.

The limits are per process. Running more than one instance multiplies them, and
SQLite makes a single instance the intended deployment anyway.
