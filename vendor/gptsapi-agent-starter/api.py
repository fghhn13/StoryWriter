"""Minimal GPTsAPI client. Python 3.10+; no external dependencies."""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://api2.gptsapi.net/v1"
DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)


def load_config(path):
    """Read simple dotenv assignments or the original three labeled lines."""
    values = {}
    aliases = {
        "Base URL": "GPTSAPI_BASE_URL",
        "API Key": "GPTSAPI_API_KEY",
        "Model": "GPTSAPI_MODEL",
    }
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        assignment = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if assignment:
            name, value = assignment.groups()
        else:
            name, separator, value = line.partition(":")
            if not separator or name.strip() not in aliases:
                raise ValueError("Unsupported config line; use the format in .env.example")
            name = aliases[name.strip()]
        value = value.strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[name] = value
    return values


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, key, base_url=DEFAULT_BASE, timeout=45, user_agent=DEFAULT_USER_AGENT):
        if not key or key == "sk-your-key-here":
            raise ValueError("Set GPTSAPI_API_KEY in .env or the process environment")
        base_url = base_url.rstrip("/")
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/v1")):
            raise ValueError("Base URL must be an HTTPS origin, optionally ending with /v1")
        if timeout <= 0:
            raise ValueError("Timeout must be positive")
        self.base_url = base_url if parsed.path == "/v1" else base_url + "/v1"
        self.key = key
        self.timeout = timeout
        self.headers = {"Authorization": "Bearer " + key, "User-Agent": user_agent,
                        "Accept": "application/json", "Content-Type": "application/json"}
        self.opener = urllib.request.build_opener(RejectRedirects())

    def request(self, endpoint, payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.base_url + endpoint, data=body, headers=self.headers,
                                     method="GET" if payload is None else "POST")
        start = time.monotonic()
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                data = json.load(response)
                status = response.status
        except urllib.error.HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", errors="replace").replace(self.key, "[REDACTED]")
            raise RuntimeError(f"HTTP {exc.code}: {detail[:1000]}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RuntimeError("Network error: " + str(exc).replace(self.key, "[REDACTED]")) from None
        except (ValueError, UnicodeError):
            raise RuntimeError("API returned invalid JSON") from None
        if not isinstance(data, dict):
            raise RuntimeError("API returned an unexpected JSON shape")
        if "error" in data:
            detail = json.dumps(data["error"], ensure_ascii=False).replace(self.key, "[REDACTED]")
            raise RuntimeError("API error: " + detail[:1000])
        return data, {"status": status, "seconds": round(time.monotonic() - start, 2)}

    def models(self):
        data, meta = self.request("/models")
        try:
            ids = [item["id"] for item in data["data"]]
        except (KeyError, TypeError):
            raise RuntimeError("Model response is missing data[].id") from None
        return {**meta, "count": len(ids), "models": ids}

    def chat(self, prompt, model=DEFAULT_MODEL, max_tokens=128):
        if max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        data, meta = self.request("/chat/completions", {
            "model": model, "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens, "stream": False,
        })
        try:
            answer = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("Chat response is missing choices[0].message.content") from None
        if not isinstance(answer, str):
            raise RuntimeError("Chat response content is not text")
        return {**meta, "model": data.get("model", model), "answer": answer,
                "usage": data.get("usage"), "finish_reason": data["choices"][0].get("finish_reason")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", help="Config file; defaults to .env if present")
    parser.add_argument("--base-url", help="HTTPS origin or /v1 base URL")
    parser.add_argument("--model", help="Exact model ID from the relay's model list")
    parser.add_argument("--timeout", type=float, default=45, help="HTTP timeout in seconds")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("models", help="List model IDs")
    commands.add_parser("smoke", help="One billed chat request, max 16 output tokens")
    chat_parser = commands.add_parser("chat", help="Send one text chat request")
    chat_parser.add_argument("prompt")
    chat_parser.add_argument("--max-tokens", type=int, default=128)
    args = parser.parse_args()
    key = ""
    try:
        path = args.env_file or ".env"
        config = load_config(path) if args.env_file or Path(path).exists() else {}
        for name in ("GPTSAPI_API_KEY", "GPTSAPI_BASE_URL", "GPTSAPI_MODEL", "GPTSAPI_USER_AGENT"):
            if name in os.environ:
                config[name] = os.environ[name]
        key = config.get("GPTSAPI_API_KEY", "")
        client = Client(key, args.base_url or config.get("GPTSAPI_BASE_URL", DEFAULT_BASE),
                        args.timeout, config.get("GPTSAPI_USER_AGENT", DEFAULT_USER_AGENT))
        model = args.model or config.get("GPTSAPI_MODEL", DEFAULT_MODEL)
        if args.command == "models":
            result = client.models()
        else:
            prompt = "Reply with exactly: OK" if args.command == "smoke" else args.prompt
            max_tokens = 16 if args.command == "smoke" else args.max_tokens
            result = client.chat(prompt, model, max_tokens)
            if args.command == "smoke":
                result["passed"] = result["answer"].strip() == "OK"
        output = json.dumps(result, ensure_ascii=False, indent=2)
        print(output.replace(key, "[REDACTED]"))
        return 0 if result.get("passed", True) else 1
    except (ValueError, OSError, RuntimeError) as exc:
        message = str(exc)
        if key:
            message = message.replace(key, "[REDACTED]")
        print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
