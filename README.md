# AI Pet Studio Backend

Dedicated Cloudflare Worker for AI Pet Studio. The Worker owns anonymous sessions, private R2 media, generation tasks, points operations and Vidu provider calls. The iOS app reads the Material Hub catalog directly and sends a validated material snapshot when creating a task; the Worker has no Material Hub runtime dependency.

## Local smoke test

```sh
npm install
npm run typecheck
npx wrangler d1 migrations apply ai-pet-studio-db --local
npx wrangler dev --local --port 8787
```

The catalog is loaded directly by iOS from Material Hub. The Worker does not expose catalog proxy routes and does not accept a Material Hub secret.

## Deployment order

1. The production resources are `ai-pet-studio-db`, `ai-pet-studio-assets`, and `ai-pet-studio-video-task`.
2. Apply migrations remotely, including `0004_v1_contract.sql`, `0005_remove_legacy_artwork_features.sql`, and `0006_material_snapshot.sql`.
3. Set `JWT_SECRET`, `REVENUECAT_SECRET_KEY`, `REVENUECAT_WEBHOOK_AUTH`, and `VIDU_API_KEY` as Worker secrets. `JWT_SECRET` must be at least 32 characters; there is no development fallback.
5. After Firebase access is available, set `APP_ATTEST_MODE=required`, `APP_CHECK_PROJECT_NUMBER`, and optionally `APP_CHECK_APP_ID`; the Worker verifies the Firebase App Check JWT against the rotating Firebase JWKS.
5. Deploy the Worker and verify `/healthz`, bootstrap, wallet, one image task and one video task. A 10-minute cron marks stale queued/processing tasks failed, refunds them idempotently, and removes unreferenced upload objects older than 24 hours.

Generation pricing is enforced by the Worker: image tasks cost 10 points and video tasks cost 50 points, regardless of the Material Hub price field. Provider configuration uses `VIDU_BASE_URL`, `VIDU_IMAGE_MODEL` (default `viduq2`) and `VIDU_VIDEO_MODEL` (default `viduq3-pro-fast`).

The current contract exposes task history for the authenticated anonymous account. Sharing, sharing rewards, task deletion and task cancellation are intentionally not supported.

`GET /v1/tasks` returns the newest tasks first. It accepts `limit` (default 30, maximum 50) and an opaque `cursor`, and returns `items`, `next_cursor` and a summary containing `total_count`, `image_count`, `video_count` and `template_count`. Each item includes a private `thumbnail_url`: a successful image uses its generated result, while other states and video tasks use the original input image when available. The App must continue to load those URLs with the user's JWT and refresh `queued`/`processing` items through `GET /v1/tasks/{taskID}`.

Deploy the Worker and verify this list contract before releasing the App build that depends on it; no database migration is required for task history.

## Task material snapshot contract

The App reads and displays Material Hub data directly. `POST /v1/tasks` accepts the selected snapshot and stores it with the task. The Worker never calls Material Hub and never accepts a client prompt outside the snapshot.

```json
{
  "template_id": "material-id",
  "material_snapshot": {
    "material_id": "material-id",
    "title": "Birthday",
    "kind": "image",
    "prompt": "...",
    "image_count": 1,
    "source_updated_at": "2026-08-26T00:00:00Z"
  },
  "input_asset_ids": ["users/<user-id>/uploads/<uuid>.jpg"],
  "client_request_id": "<uuid>"
}
```

`template_id` 可空，为空时 `material_snapshot.material_id` 与 `title` 同步可空（供未来用户自定义任务使用，任务标题回退为「自定义任务」）；模板任务仍须传齐快照字段且 `material_id == template_id`。Worker 只接受 `image_count == 1`，校验快照字段类型与 prompt 长度，并按 kind 固定计费（图片 10、视频 50）。重试使用任务中不可变的快照。
