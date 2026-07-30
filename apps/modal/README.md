# Install Modal CLI: pip install modal && modal setup
#
# Create secrets (Neon DB, Clerk, Blob token, webhook secret):
#   modal secret create thumper-secrets \
#     DATABASE_URL='postgres://...' \
#     COOKIE_ENCRYPTION_KEY='...' \
#     CLERK_SECRET_KEY='sk_...' \
#     BLOB_READ_WRITE_TOKEN='vercel_blob_rw_...' \
#     MODAL_WEBHOOK_SECRET='long-random-string'
#
# Deploy from repo root:
#   modal deploy apps/modal/thumper_worker.py
#
# Copy the printed wake endpoint URL into Vercel as MODAL_JOB_URL.
# Set PROCESS_BACKEND=modal and the same MODAL_WEBHOOK_SECRET on Vercel.
#
# Manual test:
#   modal run apps/modal/thumper_worker.py --job-id <uuid>
#
# Fallback later: Fly Machines start/stop can replace this worker without
# changing Vercel Blob / Neon — swap PROCESS_BACKEND and the wake URL.
