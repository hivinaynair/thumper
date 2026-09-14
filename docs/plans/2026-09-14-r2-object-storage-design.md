# Cloudflare R2 object storage

Replace Vercel Blob with a private R2 bucket so production audio never
traverses Vercel. Cost is storage + operations; R2 egress is $0.

## Why

Thumper stores cookies, browser uploads (up to 500 MB), and finished audio
in object storage. The Blob path streamed those bytes through Next.js
(`/api/files`), paying Blob transfer and Vercel Fast Data Transfer. R2 plus
presigned URLs keeps Clerk on the minting path and puts bytes on R2 ↔
browser / Modal only.

Neon Object Storage is out: the Thumper project is `aws-ap-southeast-1`;
Neon storage is `us-east-2` / `eu-central-1` only.

## Shape

- Keys stay `users/{userId}/uploads|downloads|cookies/…` in `files` rows.
- Local `DATA_DIR` when `R2_*` is unset (dev / Compose).
- Retag and stems share `/api/retag/upload` (stems re-exports it).
- Downloader, retag, and stems all download via `/api/files/:id` (302 to a
  15-minute presigned GET) and zip via `/api/files/zip` (server GetObject +
  zip; leftover Vercel transfer on the archive only).
- Modal uses the same `R2_*` vars as Vercel.

## Env

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
optional `R2_ENDPOINT`. Hard cut: no `BLOB_READ_WRITE_TOKEN`.

Bucket CORS must allow the web origin to `PUT`/`GET`/`HEAD` and expose
`ETag` (multipart complete). Copy existing Blob objects with R2 Super
Slurper or a one-shot script before dropping the Blob store.
