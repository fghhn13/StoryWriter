# Agent quick reference

This repository explains and tests the GPTsAPI relay. Start here, then read README.md for troubleshooting. Python 3.10+; standard library only.

## API contract

- Tested base URL: `https://api2.gptsapi.net/v1` (include `/v1` once).
- Provider-documented base URL: `https://api.gptsapi.net/v1`. It failed to connect from the test machine; do not assume that failure means the key is invalid.
- Authentication: `Authorization: Bearer <GPTSAPI_API_KEY>`.
- `GET /models`: read `data[].id`; discover model IDs instead of guessing them.
- `POST /chat/completions`: JSON with `model`, `messages`, `max_tokens`, `stream: false`.
- Tested model: `claude-opus-5-5`. Send its exact name; it is the relay's model ID, not a guarantee of upstream model identity.
- Read text from `choices[0].message.content`; usage from `usage`.
- The test encountered HTTP 403 / Cloudflare 1010 with Python's default User-Agent. `api.py` supplies the browser User-Agent that worked.
- Documentation: https://api2.gptsapi.net/tutorial

## Ready-to-run commands

```text
python api.py models
python api.py smoke
python api.py chat "用一句话解释什么是 API"
python api.py --env-file /path/to/credentials.env --base-url https://api2.gptsapi.net/v1 smoke
```

Put credentials in an ignored `.env` or process environment. `.env.example` lists the variable names. Existing files using `Base URL: ...`, `API Key: ...`, `Model: ...` are supported. Process variables override file values; command-line base/model options override both.

## Working rules

- Never display, commit, or copy real credentials into examples or test reports. Do not read unrelated credential files.
- List models before choosing another model. A smoke test makes one billed completion request with at most 16 output tokens; avoid repeated requests and automatic retries.
- Preserve TLS verification. The client rejects redirects rather than forwarding credentials to another endpoint.
- Do not implement `/responses`, tool calling, image generation, streaming, or Anthropic-native requests based on assumed compatibility. This repository has tested only model listing and non-streaming text chat.
- Distinguish transport/DNS failures, HTTP auth errors, Cloudflare blocking, and model errors. Check README.md before changing credentials or endpoints.
- After changing the client, validate `python api.py --help` and, when authorized with credentials, one `smoke` request. Do not run paid tests in CI by default.
