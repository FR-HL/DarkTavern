"""Agent LLM test bench.

Proxies a chat completion request to an OpenAI-compatible endpoint
(DeepSeek by default) and measures latency:

  - ``ttfb_ms``  time to first content token (stream mode)
  - ``total_ms`` time to full completion

Also attempts to parse the model output as JSON so the test page can
verify whether the model "understands" (produces a valid tool call).

The API key is passed per-request and never persisted server-side.
"""

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import List, Optional

from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"


class ChatMessage(BaseModel):
    role: str
    content: str


class LlmTestRequest(BaseModel):
    api_key: str
    messages: List[ChatMessage]
    base_url: Optional[str] = None
    model: Optional[str] = None
    stream: bool = True
    temperature: float = 0.0
    max_tokens: int = 512


def _extract_json(text: str):
    """Best-effort parse of a JSON object out of a model reply."""
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            return None
    return None


@router.post("/llm-test")
def llm_test(body: LlmTestRequest):
    base_url = (body.base_url or DEFAULT_BASE_URL).rstrip("/")
    url = base_url + "/chat/completions"
    payload = {
        "model": body.model or DEFAULT_MODEL,
        "messages": [{"role": m.role, "content": m.content} for m in body.messages],
        "stream": body.stream,
        "temperature": body.temperature,
        "max_tokens": body.max_tokens,
    }
    if body.stream:
        payload["stream_options"] = {"include_usage": True}

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + body.api_key.strip(),
            "Accept": "text/event-stream" if body.stream else "application/json",
        },
        method="POST",
    )

    t_start = time.perf_counter()
    ttfb_ms = None
    chunks = []
    usage = {}

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            if not body.stream:
                result = json.loads(resp.read().decode("utf-8", "replace"))
                choices = result.get("choices") or []
                if choices:
                    chunks.append((choices[0].get("message") or {}).get("content") or "")
                usage = result.get("usage") or {}
            else:
                for raw_line in resp:
                    line = raw_line.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        evt = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if evt.get("usage"):
                        usage = evt["usage"]
                    choices = evt.get("choices") or []
                    if not choices:
                        continue
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        if ttfb_ms is None:
                            ttfb_ms = int((time.perf_counter() - t_start) * 1000)
                        chunks.append(delta)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        return {
            "ok": False,
            "error": "HTTP {}: {}".format(e.code, detail),
            "total_ms": int((time.perf_counter() - t_start) * 1000),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "total_ms": int((time.perf_counter() - t_start) * 1000),
        }

    total_ms = int((time.perf_counter() - t_start) * 1000)
    text = "".join(chunks)
    if ttfb_ms is None:
        ttfb_ms = total_ms
    parsed = _extract_json(text)

    return {
        "ok": True,
        "text": text,
        "json": parsed,
        "json_ok": parsed is not None,
        "ttfb_ms": ttfb_ms,
        "total_ms": total_ms,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
    }


@router.get("/test-page", response_class=HTMLResponse)
def test_page():
    path = os.path.join(os.path.dirname(__file__), "..", "agent", "test_page.html")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()
