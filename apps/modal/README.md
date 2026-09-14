# Install Modal CLI: pip install modal && modal setup
#
# Create secrets (Neon DB, Clerk, R2, webhook secret):
#   modal secret create thumper-secrets \
#     DATABASE_URL='postgres://...' \
#     COOKIE_ENCRYPTION_KEY='...' \
#     CLERK_SECRET_KEY='sk_...' \
#     R2_ACCOUNT_ID='...' \
#     R2_ACCESS_KEY_ID='...' \
#     R2_SECRET_ACCESS_KEY='...' \
#     R2_BUCKET='thumper' \
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
# changing R2 / Neon — swap PROCESS_BACKEND and the wake URL.
