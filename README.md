# AURA WhatsApp Gateway

Lightweight WhatsApp Web gateway for AURA Supply Chain, designed for blitz.cloud.

## Environment variables
- `PORT=8080`
- `API_KEY=change-this-to-a-long-random-secret`
- `SESSION_PATH=/app/data/auth`

## API
- `GET /health`
- `GET /status` with `X-API-Key`
- `GET /qr` with `X-API-Key`
- `POST /api/send` with JSON `{ "phone":"628...", "message":"..." }`
- `GET /api/groups`
- `POST /api/send-group` with JSON `{ "groupId":"...@g.us", "message":"..." }`

> Baileys is an unofficial WhatsApp Web library. Use a dedicated number and avoid spam/bulk unsolicited messaging.
